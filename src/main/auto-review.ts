// main/auto-review.ts — 새 MR/PR 감지 시 백그라운드 AI 리뷰 실행
//
// 흐름: 감지 → 오케스트레이터(동시성/대기열) → 브랜치 clone → AI 리뷰(cwd=클론 경로)
//       → reviewCache 저장 → MR/PR 에 댓글 게시 → 클론 정리.
// 리뷰 창을 열면 기존 캐시 복원 경로(REVIEW_CACHE_LOAD)로 결과가 그대로 표시된다.
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type { AIConfig, AppSettings, Discussion, GitConfig, ReviewItemSummary, StoreSchema } from '../shared/types';
import { AutoReviewOrchestrator, createAutoReviewOrchestrator, isResolved, resolveAutoReviewConcurrency, reviewableDiscussions } from './auto-review/orchestrator';
import type { AutoReviewRequest } from './auto-review/orchestrator';
import { COMMENT_HEADER, isCleanReview, isOwnReviewThread, settleClean } from './auto-review/clean';
import { prepareSlot } from './auto-review/worktree';
import { leaseSlot, markBroken, markProvisioned, type SlotLease } from './auto-review/slot-pool';
import { createAIProvider } from './providers/ai/ai-provider';
import { createGitProvider } from './providers/git/git-provider';
import { sendAutoReviewFailure } from './notifier';
import { buildPrompt, runReview } from './review-runner';

import { DEFAULT_SLOTS_PER_PROJECT } from '../shared/constants';

const MAX_CACHED_REVIEW_CHARS = 200_000;

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

/** 내 담당(내가 작성자 or 리뷰어)인지 */
function isMyItem(cfg: GitConfig, item: ReviewItemSummary): boolean {
  if (item.viewerIsReviewer) return true;
  if (cfg.type === 'gitlab') return item.author.id === cfg.userId;
  return item.author.username.toLowerCase() === cfg.username.toLowerCase();
}

/**
 * 이 MR/PR 이 자동 리뷰 대상인지 — 설정된 범위에 따라 판단.
 * 기본은 내 담당만. GitLab 은 scope=all 로 폴링해 팀 전체 MR 이 잡히므로,
 * 'all' 로 두면 남의 MR 에도 내 계정으로 AI 댓글이 달린다(의도된 동작).
 */
export function isReviewTarget(
  scope: 'mine' | 'all' | undefined,
  cfg: GitConfig,
  item: ReviewItemSummary,
): boolean {
  if (scope === 'all') return true;
  return isMyItem(cfg, item);
}

/**
 * 리뷰 대상 브랜치를 임시 디렉터리에 클론한다.
 * clone URL 조회를 지원하지 않는 provider(현재 GitHub)나 clone 실패 시 null — diff 만으로 리뷰 진행.
 */
/** 리뷰 결과 — 마크다운 + 리뷰 시점의 resolved 스레드 id (다음 재리뷰 판단 기준) */
export interface ReviewOutcome {
  markdown: string;
  resolvedThreadIds: string[];
}

async function prepareWorkspace(
  payload: AutoReviewPayload,
): Promise<{ dir: string; release: () => void } | null> {
  const { item, cfg, store } = payload;
  const provider = createGitProvider(cfg);
  if (!provider.fetchRepoCloneUrl) return null;

  const settings = store.get('settings');
  // 슬롯은 프로젝트 단위. gitConfigId 까지 넣어야 서버가 다른 같은 projectId 가 안 겹친다.
  const key = `${cfg.id}-${item.projectId}`;
  const base = settings.mergeWorkDir
    ? path.join(settings.mergeWorkDir, 'pingo-review')
    : path.join(tmpdir(), 'pingo-review');
  const maxSlots = resolveSlotsPerProject(settings);

  let lease: SlotLease | null = null;
  try {
    const u = new URL(await provider.fetchRepoCloneUrl(item));
    u.username = 'oauth2';
    u.password = cfg.token;

    lease = await leaseSlot(key, base, maxSlots, path.sep);
    log.info(
      `auto-review: 슬롯 ${lease.fresh ? '신규 클론' : '재사용'} ${item.id} → ${lease.dir}`,
    );
    const t0 = Date.now();
    await prepareSlot(lease.dir, lease.fresh, u.toString(), item.sourceBranch, item.targetBranch);
    markProvisioned(key, lease.dir);
    log.info(`auto-review: 작업 트리 준비 완료 ${item.id} (${Math.round((Date.now() - t0) / 1000)}s)`);
    const dir = lease.dir;
    const release = lease.release;
    return { dir, release };
  } catch (err) {
    if (lease) {
      markBroken(key, lease.dir); // 다음 대여 때 다시 클론하도록
      lease.release();
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`auto-review: 작업 트리 준비 실패 ${item.id} — diff 만으로 진행: ${mask(msg, cfg.token).slice(0, 200)}`);
    return null;
  }
}

/** 리뷰 1건 실행: clone → 변경/토론 수집 → AI. */
async function runOne(
  req: AutoReviewRequest<AutoReviewPayload>,
  signal: AbortSignal,
): Promise<ReviewOutcome> {
  const { item, cfg, ai } = req.payload;
  const provider = createGitProvider(cfg);

  const [full, discussions] = await Promise.all([
    provider.fetchChanges(item),
    provider.fetchDiscussions(item).catch((): [] => []),
  ]);
  // resolved 스레드는 제외 — 이미 정리된 지적을 다시 댓글로 달지 않기 위함
  full.discussions = reviewableDiscussions(discussions);
  // 이번 리뷰 시점의 해결된 스레드 — 이후 새로 해결되는 게 생기면 재리뷰 트리거
  const resolvedThreadIds = resolvedIds(discussions);

  // clone 은 API 호출 뒤에 — 병렬로 돌리면 API 가 먼저 실패했을 때 클론 디렉터리가 미아가 된다
  const workspace = await prepareWorkspace(req.payload);
  try {
    if (signal.aborted) throw new Error('중단됨');
    const prompt = buildPrompt(full, undefined, workspace !== null);
    let markdown = '';
    await new Promise<void>((resolve, reject) => {
      const handle = runReview(
        createAIProvider(ai),
        prompt,
        (chunk: string): void => { markdown += chunk; },
        resolve,
        reject,
        workspace?.dir,
      );
      signal.addEventListener('abort', () => {
        handle.abort();
        reject(new Error('중단됨'));
      }, { once: true });
    });
    if (!markdown.trim()) throw new Error('빈 리뷰 결과');
    return { markdown, resolvedThreadIds };
  } finally {
    // 슬롯은 지우지 않는다 — 재사용이 이 설계의 전부다. 반납만 한다.
    workspace?.release();
  }
}

/** 리뷰 완료 후: 캐시 저장 → MR/PR 댓글 게시. */
async function postOne(
  req: AutoReviewRequest<AutoReviewPayload>,
  outcome: ReviewOutcome,
): Promise<void> {
  const { item, cfg, store } = req.payload;
  const { markdown } = outcome;

  const cache = store.get('reviewCache') ?? {};
  cache[item.id] = {
    markdown: markdown.length > MAX_CACHED_REVIEW_CHARS ? markdown.slice(-MAX_CACHED_REVIEW_CHARS) : markdown,
    updatedAt: new Date().toISOString(),
    // 어느 커밋을 리뷰했는지 기록 (참고용)
    headSha: item.headSha,
    // 이 시점에 해결돼 있던 스레드 — 이후 새로 해결된 게 생기면 재리뷰한다
    resolvedThreadIds: outcome.resolvedThreadIds,
    // 다음 tick 에서 "변화 없음" 을 싸게 걸러내기 위한 기준값
    seenUpdatedAt: item.updatedAt,
  };
  store.set('reviewCache', cache);
  log.info(`auto-review: done ${item.id} (${markdown.length} chars)`);

  const provider = createGitProvider(cfg);
  const res = await provider.postComment(item, `${COMMENT_HEADER}\n\n${markdown}`);
  if (res.success) log.info(`auto-review: 댓글 등록 ${item.id} (${res.commentId ?? '-'})`);
  else log.warn(`auto-review: 댓글 등록 실패 ${item.id}: ${(res.error ?? '').slice(0, 200)}`);

  // 지적 없으면 사람 손을 안 빌린다 — 봇이 자기 스레드를 닫는다.
  if (res.success && isCleanReview(markdown)) await settleClean(provider, item, res.commentId);
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
let orchestrator: AutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome> | null = null;
let orchestratorMax = 0;

function getOrchestrator(concurrency: number): AutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome> {
  if (orchestrator && orchestratorMax === concurrency) return orchestrator;
  if (orchestrator) log.info(`auto-review: 동시 상한 변경 ${orchestratorMax} → ${concurrency}, 오케스트레이터 재생성`);
  orchestratorMax = concurrency;
  orchestrator = createAutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome>(
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

/** 프로젝트당 슬롯 상한 — 미설정/비정상이면 기본값 */
export function resolveSlotsPerProject(
  settings: Pick<AppSettings, 'autoReviewSlotsPerProject'>,
): number {
  const n = settings.autoReviewSlotsPerProject;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1
    ? Math.floor(n)
    : DEFAULT_SLOTS_PER_PROJECT;
}

/** 트레이 메뉴 표시용 — 지금 몇 건이 돌고 몇 건이 대기 중인지 */
export function getAutoReviewStatus(): { active: number; queued: number } {
  return {
    active: orchestrator?.activeCount ?? 0,
    queued: orchestrator?.queuedCount ?? 0,
  };
}

/**
 * 해결(resolved)된 스레드 id 목록 — Pingo 자기 리뷰 스레드는 제외.
 * GitLab 은 자동 리뷰 댓글도 resolvable 스레드로 만들어서, 머지하려면 해결해야 한다.
 * 그 해결을 재리뷰 트리거로 세면 리뷰 → 해결 → 리뷰 무한루프가 된다.
 */
export function resolvedIds(discussions: Discussion[]): string[] {
  return discussions.filter((d) => isResolved(d) && !isOwnReviewThread(d)).map((d) => d.id);
}

/**
 * 지난 리뷰 이후 새로 해결된 스레드가 있는지 — 재리뷰 트리거.
 * 지적을 고치고 스레드를 닫으면 그때 다시 본다. 커밋마다 도는 것보다 낫다:
 * 중간 커밋에는 반응하지 않고, "고쳤다" 는 신호가 왔을 때만 확인한다.
 */
export function newlyResolved(cachedIds: string[] | undefined, current: string[]): string[] {
  if (!cachedIds) return []; // 리뷰 이력이 없으면 재리뷰가 아니라 첫 리뷰 경로
  const before = new Set(cachedIds);
  return current.filter((id) => !before.has(id));
}

function submit(store: Store<StoreSchema>, item: ReviewItemSummary, why: string): void {
  const settings = store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!isReviewTarget(settings.autoReviewScope, cfg, item)) return;

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
 * 폴링 tick 마다 열린 MR/PR 전체에 대해 호출.
 *  - 리뷰 이력 없음 → 첫 리뷰 (이벤트를 놓쳤거나, 자동 리뷰를 방금 켠 경우)
 *  - 리뷰 이력 있음 → 지난 리뷰 이후 새로 해결된 스레드가 있을 때만 재리뷰
 *
 * 토론 조회는 MR 의 updatedAt 이 바뀌었을 때만 한다. 안 그러면 리뷰한 MR 수만큼
 * 30초마다 API 를 때린다.
 */
export function maybeAutoReviewOnPoll(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  const settings = store.get('settings');
  if (settings.autoReviewEnabled !== true) return;
  const cached = (store.get('reviewCache') ?? {})[item.id];
  if (!cached) {
    submit(store, item, '첫 리뷰(폴링)');
    return;
  }
  if (cached.seenUpdatedAt === item.updatedAt) return; // MR 에 아무 변화 없음

  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!isReviewTarget(settings.autoReviewScope, cfg, item)) return;

  void (async (): Promise<void> => {
    try {
      const discussions = await createGitProvider(cfg).fetchDiscussions(item);
      const fresh = newlyResolved(cached.resolvedThreadIds, resolvedIds(discussions));
      // updatedAt 을 갱신해 다음 tick 에서 같은 조회를 반복하지 않는다
      const cache = store.get('reviewCache') ?? {};
      const entry = cache[item.id];
      if (entry) {
        entry.seenUpdatedAt = item.updatedAt;
        store.set('reviewCache', cache);
      }
      if (fresh.length === 0) return;
      submit(store, item, `스레드 ${fresh.length}건 해결됨`);
    } catch (err) {
      log.warn(`auto-review: 토론 조회 실패 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
