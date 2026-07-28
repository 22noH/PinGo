// main/auto-review.ts — 새 MR/PR 감지 시 백그라운드 AI 리뷰 실행
//
// 흐름: 감지 → 오케스트레이터(동시성/대기열) → 브랜치 clone → AI 리뷰(cwd=클론 경로)
//       → reviewCache 저장 → MR/PR 에 댓글 게시 → 클론 정리.
// 리뷰 창을 열면 기존 캐시 복원 경로(REVIEW_CACHE_LOAD)로 결과가 그대로 표시된다.
import { shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type { AIConfig, GitConfig, ReviewItemSummary, StoreSchema } from '../shared/types';
import { AutoReviewOrchestrator, createAutoReviewOrchestrator, resolveAutoReviewConcurrency, reviewableDiscussions } from './auto-review/orchestrator';
import type { AutoReviewRequest } from './auto-review/orchestrator';
import { createReviewWorktree } from './auto-review/worktree';
import { createAIProvider } from './providers/ai/ai-provider';
import { createGitProvider } from './providers/git/git-provider';
import { sendAutoReviewFailure } from './notifier';
import { buildPrompt, runReview } from './review-runner';

const MAX_CACHED_REVIEW_CHARS = 200_000;
const COMMENT_HEADER = '🤖 **Pingo 자동 AI 리뷰**';

interface AutoReviewPayload {
  item: ReviewItemSummary;
  cfg: GitConfig;
  ai: AIConfig;
  store: Store<StoreSchema>;
}

/** 에러 메시지에서 토큰 마스킹 — clone 실패 stderr 에 인증 URL 이 그대로 실린다 */
function mask(s: string, secret: string): string {
  return secret ? s.split(secret).join('***') : s;
}

/** 내 담당(내가 작성자 or 리뷰어)인 경우만 자동리뷰 — GitLab은 scope=all 이라 팀 전체 MR이 잡히므로 필수 */
function isMyItem(cfg: GitConfig, item: ReviewItemSummary): boolean {
  if (item.viewerIsReviewer) return true;
  if (cfg.type === 'gitlab') return item.author.id === cfg.userId;
  return item.author.username.toLowerCase() === cfg.username.toLowerCase();
}

/**
 * 리뷰 대상 브랜치를 임시 디렉터리에 클론한다.
 * clone URL 조회를 지원하지 않는 provider(현재 GitHub)나 clone 실패 시 null — diff 만으로 리뷰 진행.
 */
async function cloneBranch(
  payload: AutoReviewPayload,
): Promise<{ dir: string; cleanup: () => Promise<void> } | null> {
  const { item, cfg, store } = payload;
  const provider = createGitProvider(cfg);
  if (!provider.fetchRepoCloneUrl) return null;
  try {
    const u = new URL(await provider.fetchRepoCloneUrl(item));
    u.username = 'oauth2';
    u.password = cfg.token;
    // 작업 폴더가 설정돼 있으면 거기에 클론 — 진행 상황을 눈으로 확인할 수 있게
    const workDir = store.get('settings').mergeWorkDir;
    const label = `${item.providerType === 'gitlab' ? 'MR' : 'PR'}-${item.itemId}-${item.sourceBranch}`;
    log.info(`auto-review: clone 시작 ${item.id} → ${workDir ? `${workDir}\\pingo-review` : '(임시 폴더)'}`);
    const wt = await createReviewWorktree(u.toString(), item.sourceBranch, workDir, label);
    log.info(`auto-review: cloned ${item.id} → ${wt.dir}`);
    return wt;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`auto-review: clone 실패 ${item.id} — diff 만으로 진행: ${mask(msg, cfg.token).slice(0, 200)}`);
    return null;
  }
}

/** 리뷰 1건 실행: clone → 변경/토론 수집 → AI. */
async function runOne(req: AutoReviewRequest<AutoReviewPayload>, signal: AbortSignal): Promise<string> {
  const { item, cfg, ai } = req.payload;
  const provider = createGitProvider(cfg);

  const [full, discussions] = await Promise.all([
    provider.fetchChanges(item),
    provider.fetchDiscussions(item).catch((): [] => []),
  ]);
  // resolved 스레드는 제외 — 이미 정리된 지적을 다시 댓글로 달지 않기 위함
  full.discussions = reviewableDiscussions(discussions);

  // clone 은 API 호출 뒤에 — 병렬로 돌리면 API 가 먼저 실패했을 때 클론 디렉터리가 미아가 된다
  const worktree = await cloneBranch(req.payload);
  try {
    if (signal.aborted) throw new Error('중단됨');
    const prompt = buildPrompt(full, undefined, worktree !== null);
    let markdown = '';
    await new Promise<void>((resolve, reject) => {
      const handle = runReview(
        createAIProvider(ai),
        prompt,
        (chunk: string): void => { markdown += chunk; },
        resolve,
        reject,
        worktree?.dir,
      );
      signal.addEventListener('abort', () => {
        handle.abort();
        reject(new Error('중단됨'));
      }, { once: true });
    });
    if (!markdown.trim()) throw new Error('빈 리뷰 결과');
    return markdown;
  } finally {
    await worktree?.cleanup();
  }
}

/** 리뷰 완료 후: 캐시 저장 → MR/PR 댓글 게시. */
async function postOne(req: AutoReviewRequest<AutoReviewPayload>, markdown: string): Promise<void> {
  const { item, cfg, store } = req.payload;

  const cache = store.get('reviewCache') ?? {};
  cache[item.id] = {
    markdown: markdown.length > MAX_CACHED_REVIEW_CHARS ? markdown.slice(-MAX_CACHED_REVIEW_CHARS) : markdown,
    updatedAt: new Date().toISOString(),
    // 어느 커밋을 리뷰했는지 기록 — 다음 폴링에서 새 커밋 여부 판단에 쓰인다
    headSha: item.headSha,
  };
  store.set('reviewCache', cache);
  log.info(`auto-review: done ${item.id} (${markdown.length} chars)`);

  const res = await createGitProvider(cfg).postComment(item, `${COMMENT_HEADER}\n\n${markdown}`);
  if (res.success) log.info(`auto-review: 댓글 등록 ${item.id} (${res.commentId ?? '-'})`);
  else log.warn(`auto-review: 댓글 등록 실패 ${item.id}: ${(res.error ?? '').slice(0, 200)}`);
}

/** 자동 리뷰가 실패했음을 사용자에게 알린다. 알림을 꺼둔 상태(MUTED)면 로그만 남긴다. */
function notifyFailure(payload: AutoReviewPayload, reason: string): void {
  if (payload.store.get('settings').notificationEnabled !== true) return;
  sendAutoReviewFailure(payload.item, reason, () => {
    void shell.openExternal(payload.item.webUrl);
  });
}

// 설정의 동시 상한이 바뀌면 재생성한다 — 앱 재시작 없이 설정이 먹도록.
// ponytail: 재생성 시 대기열은 버려진다(실행 중인 리뷰는 이전 인스턴스에서 그대로 완주).
//   설정 변경은 드물고, 버려진 항목은 다음 폴링에서 캐시 미존재로 다시 잡힌다.
let orchestrator: AutoReviewOrchestrator<AutoReviewPayload, string> | null = null;
let orchestratorMax = 0;

function getOrchestrator(concurrency: number): AutoReviewOrchestrator<AutoReviewPayload, string> {
  if (orchestrator && orchestratorMax === concurrency) return orchestrator;
  if (orchestrator) log.info(`auto-review: 동시 상한 변경 ${orchestratorMax} → ${concurrency}, 오케스트레이터 재생성`);
  orchestratorMax = concurrency;
  orchestrator = createAutoReviewOrchestrator<AutoReviewPayload, string>(
    { autoReviewConcurrency: concurrency },
    {
      runReview: runOne,
      postResult: postOne,
      onEvict: (req) => log.warn(`auto-review: 대기열 초과로 취소 ${req.key}`),
      logError: (msg, req) => {
        const safe = mask(msg, req.payload.cfg.token).slice(0, 200);
        log.warn(`auto-review: failed ${req.key}: ${safe}`);
        notifyFailure(req.payload, safe);
      },
    },
  );
  return orchestrator;
}

/** 트레이 메뉴 표시용 — 지금 몇 건이 돌고 몇 건이 대기 중인지 */
export function getAutoReviewStatus(): { active: number; queued: number } {
  return {
    active: orchestrator?.activeCount ?? 0,
    queued: orchestrator?.queuedCount ?? 0,
  };
}

/**
 * 이미 리뷰한 MR/PR 에 새 커밋이 들어왔는지 — 재리뷰 판단.
 * 양쪽 SHA 를 모두 알 때만 true. 하나라도 모르면 판단 불가로 보고 재리뷰하지 않는다
 * (모르는 채로 돌리면 폴링마다 댓글이 쌓인다).
 */
export function hasNewCommits(
  cached: { headSha?: string } | undefined,
  item: Pick<ReviewItemSummary, 'headSha'>,
): boolean {
  if (!cached) return false; // 리뷰한 적 없음 — 재리뷰가 아니라 첫 리뷰 경로
  if (!cached.headSha || !item.headSha) return false;
  return cached.headSha !== item.headSha;
}

function submit(store: Store<StoreSchema>, item: ReviewItemSummary, why: string): void {
  const settings = store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!isMyItem(cfg, item)) return;

  log.info(`auto-review: queue ${item.id} (${why}) ${item.title.slice(0, 60)}`);
  getOrchestrator(resolveAutoReviewConcurrency(settings)).submit({
    key: item.id,
    payload: { item, cfg, ai: settings.ai, store },
  });
}

/** 새 MR/PR·리뷰어 지정 감지 시 첫 리뷰. 이미 리뷰한 적이 있으면 아무것도 하지 않는다. */
export function maybeAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  if (store.get('settings').autoReviewEnabled !== true) return;
  if ((store.get('reviewCache') ?? {})[item.id]) return; // 이미 리뷰됨 — 첫 리뷰 경로 종료
  submit(store, item, '첫 리뷰');
}

/**
 * 폴링 tick 마다 열린 MR/PR 전체에 대해 호출 — 이미 리뷰한 것에 새 커밋이 들어왔으면 재리뷰.
 * 리뷰 이력이 없는 항목은 여기서 건드리지 않는다. 그러지 않으면 자동 리뷰를 켠 직후
 * 열려 있던 MR 전부에 댓글이 한꺼번에 달린다.
 */
export function maybeReReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  if (store.get('settings').autoReviewEnabled !== true) return;
  const cached = (store.get('reviewCache') ?? {})[item.id];
  if (!hasNewCommits(cached, item)) return;
  submit(store, item, `새 커밋 ${cached?.headSha?.slice(0, 8)} → ${item.headSha?.slice(0, 8)}`);
}
