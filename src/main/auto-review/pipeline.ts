// main/auto-review/pipeline.ts — 자동 리뷰 1건의 실행 경로: 작업 트리 준비 → AI → 결과 게시
//
// 오케스트레이터(orchestrator.ts)가 runOne / postOne 을 부른다. 단계 전환마다 setPhase 로
// 현황을 올려 트레이 메뉴에 "지금 뭘 하는지" 가 보이게 한다.
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import log from 'electron-log';
import type Store from 'electron-store';
import type { AIConfig, AppSettings, GitConfig, ReviewItemSummary, StoreSchema } from '../../shared/types';
import { DEFAULT_SLOTS_PER_PROJECT } from '../../shared/constants';
import type { AutoReviewRequest, SetPhase } from './orchestrator';
import { isResolved, reviewableDiscussions } from './orchestrator';
import { COMMENT_HEADER, isCleanReview, settleClean } from './clean';
import { buildVerifyPrompt, parseVerdict, postVerdicts, type ThreadVerdict } from './verify';
import { isReadyClone, prepareSlot } from './worktree';
import { leaseSlot, markBroken, markProvisioned, type SlotLease } from './slot-pool';
import { createAIProvider } from '../providers/ai/ai-provider';
import { createGitProvider } from '../providers/git/git-provider';
import { buildPrompt, runReview, type ReviewPrompt } from '../review-runner';

const MAX_CACHED_REVIEW_CHARS = 200_000;

export interface AutoReviewPayload {
  item: ReviewItemSummary;
  cfg: GitConfig;
  ai: AIConfig;
  store: Store<StoreSchema>;
  /** 있으면 전체 리뷰가 아니라 "이 스레드들의 해결이 진짜인지" 검증만 한다 */
  verifyThreadIds?: string[];
}

/** 리뷰 결과 — 전체 리뷰(markdown + 리뷰 시점의 resolved 스레드) 또는 스레드 해결 검증 */
export type ReviewOutcome =
  | { kind: 'review'; markdown: string; resolvedThreadIds: string[] }
  | { kind: 'verify'; verdicts: ThreadVerdict[] };

/** 에러 메시지에서 토큰 마스킹 — clone 실패 stderr 에 인증 URL 이 그대로 실린다 */
export function mask(s: string, secret: string): string {
  return secret ? s.split(secret).join('***') : s;
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

/**
 * 리뷰 대상 브랜치를 프로젝트 슬롯에 준비한다(클론 또는 fetch+checkout).
 * clone URL 조회를 지원하지 않는 provider(현재 GitHub)나 실패 시 null — diff 만으로 리뷰 진행.
 * @param required true 면 실패를 null 로 삼키지 않고 사유와 함께 던진다 — 해결 검증은 코드를
 *   못 보면 판정이 불가능하므로, "검증 불가" 답글로 수용하는 대신 실패로 남겨 재시도한다.
 */
export async function prepareWorkspace(
  payload: Pick<AutoReviewPayload, 'item' | 'cfg' | 'store'>,
  setPhase: SetPhase = (): void => undefined,
  required = false,
): Promise<{ dir: string; release: () => void } | null> {
  const { item, cfg, store } = payload;
  const provider = createGitProvider(cfg);
  if (!provider.fetchRepoCloneUrl) {
    if (required) throw new Error('이 연결은 저장소 클론을 지원하지 않아 해결 검증을 할 수 없습니다');
    return null;
  }

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

    setPhase('클론 슬롯 대기');
    lease = await leaseSlot(key, base, maxSlots, path.sep);
    // 풀이 처음 보는 슬롯(fresh)이어도 디스크에 완성된 클론이 있으면 재사용된다(앱 재시작 후)
    const willClone = !(await isReadyClone(lease.dir));
    log.info(
      `auto-review: 슬롯 ${willClone ? '신규 클론' : `재사용${lease.fresh ? '(디스크)' : ''}`} ${item.id} → ${lease.dir}`,
    );
    setPhase(willClone ? '클론 중 (최초 — 수 분 소요)' : '브랜치 fetch/checkout');
    const t0 = Date.now();
    await prepareSlot(lease.dir, u.toString(), item.sourceBranch, item.targetBranch);
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
    const msg = mask(err instanceof Error ? err.message : String(err), cfg.token).slice(0, 200);
    if (required) throw new Error(`저장소 준비(클론/fetch) 실패: ${msg}`);
    log.warn(`auto-review: 작업 트리 준비 실패 ${item.id} — diff 만으로 진행: ${msg}`);
    return null;
  }
}

/** AI 실행을 promise 로 감싼다. finalText 가 오면 그것이 본문(진행 서술 제외). */
function runAI(ai: AIConfig, prompt: ReviewPrompt, cwd: string | undefined, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let streamed = '';
    const handle = runReview(
      createAIProvider(ai),
      prompt,
      (chunk: string): void => { streamed += chunk; },
      (finalText?: string): void => resolve(finalText ?? streamed),
      reject,
      cwd,
    );
    signal.addEventListener('abort', () => {
      handle.abort();
      reject(new Error('중단됨'));
    }, { once: true });
  });
}

/** 검증 실행: 해결된 스레드 각각에 대해 "진짜 고쳐졌나" 만 AI 로 판정 */
async function runVerify(
  req: AutoReviewRequest<AutoReviewPayload>,
  signal: AbortSignal,
  setPhase: SetPhase,
): Promise<ReviewOutcome> {
  const { item, cfg, ai, verifyThreadIds } = req.payload;
  setPhase('토론 조회');
  const discussions = await createGitProvider(cfg).fetchDiscussions(item);
  const targets = discussions.filter((d) => verifyThreadIds?.includes(d.id));
  if (targets.length === 0) return { kind: 'verify', verdicts: [] }; // 이력에 "대상 없음" 만 남긴다
  // 저장소는 필수 — 준비 실패는 답글 없이 실패로 던진다(트레이 ❌ + 사유, 백오프 후 자동 재시도).
  // "검증 불가" 답글로 수용하면 그 스레드는 다시 닫아도 영영 검증되지 않는다(20260915 리포트).
  const workspace = await prepareWorkspace(req.payload, setPhase, true);
  if (!workspace) throw new Error('저장소 준비 실패');
  try {
    const verdicts: ThreadVerdict[] = [];
    for (const [i, d] of targets.entries()) {
      if (signal.aborted) throw new Error('중단됨');
      setPhase(`AI 검증 ${i + 1}/${targets.length}`);
      const out = await runAI(ai, buildVerifyPrompt(d, item.targetBranch), workspace.dir, signal);
      verdicts.push({ ...parseVerdict(d.id, out), resolvedAt: d.resolvedAt });
    }
    return { kind: 'verify', verdicts };
  } finally {
    workspace.release();
  }
}

/** 리뷰 1건 실행: clone → 변경/토론 수집 → AI. */
export async function runOne(
  req: AutoReviewRequest<AutoReviewPayload>,
  signal: AbortSignal,
  setPhase: SetPhase,
): Promise<ReviewOutcome> {
  if (req.payload.verifyThreadIds) return runVerify(req, signal, setPhase);
  const { item, cfg, ai, store } = req.payload;
  const provider = createGitProvider(cfg);

  setPhase('변경/토론 조회');
  const [full, discussions] = await Promise.all([
    provider.fetchChanges(item),
    provider.fetchDiscussions(item).catch((): [] => []),
  ]);
  // resolved 스레드는 제외 — 이미 정리된 지적을 다시 댓글로 달지 않기 위함
  full.discussions = reviewableDiscussions(discussions);
  // 이번 리뷰 시점의 해결된 스레드 — 이후 새로 해결되는 게 생기면 검증 트리거
  const resolvedThreadIds = discussions.filter(isResolved).map((d) => d.id);

  // clone 은 API 호출 뒤에 — 병렬로 돌리면 API 가 먼저 실패했을 때 클론 디렉터리가 미아가 된다
  const workspace = await prepareWorkspace(req.payload, setPhase);
  try {
    if (signal.aborted) throw new Error('중단됨');
    // 이전 리뷰가 있으면(재리뷰) 프롬프트에 포함 — 지적별 해결 여부를 명시한 리뷰가 나온다
    const prevReview = (store.get('reviewCache') ?? {})[item.id]?.markdown;
    const prompt = buildPrompt(full, prevReview, workspace !== null);
    setPhase(workspace ? 'AI 리뷰 (저장소 열람)' : 'AI 리뷰 (diff 만)');
    const markdown = await runAI(ai, prompt, workspace?.dir, signal);
    if (!markdown.trim()) throw new Error('빈 리뷰 결과');
    return { kind: 'review', markdown, resolvedThreadIds };
  } finally {
    // 슬롯은 지우지 않는다 — 재사용이 이 설계의 전부다. 반납만 한다.
    workspace?.release();
  }
}

/** 리뷰 완료 후: 캐시 저장 → MR/PR 댓글 게시. 검증 결과는 스레드 답글로. 반환값은 이력 요약. */
export async function postOne(
  req: AutoReviewRequest<AutoReviewPayload>,
  outcome: ReviewOutcome,
): Promise<string> {
  const { item, cfg, store } = req.payload;
  if (outcome.kind === 'verify') {
    return postVerdicts(createGitProvider(cfg), item, outcome.verdicts, store);
  }
  const { markdown } = outcome;

  const cache = store.get('reviewCache') ?? {};
  cache[item.id] = {
    markdown: markdown.length > MAX_CACHED_REVIEW_CHARS ? markdown.slice(-MAX_CACHED_REVIEW_CHARS) : markdown,
    updatedAt: new Date().toISOString(),
    // 어느 커밋을 리뷰했는지 기록 (참고용)
    headSha: item.headSha,
    // 이 시점에 해결돼 있던 스레드 — 이후 새로 해결된 게 생기면 검증한다
    resolvedThreadIds: outcome.resolvedThreadIds,
  };
  store.set('reviewCache', cache);
  log.info(`auto-review: done ${item.id} (${markdown.length} chars)`);

  const provider = createGitProvider(cfg);
  const res = await provider.postComment(item, `${COMMENT_HEADER}\n\n${markdown}`);
  if (!res.success) {
    log.warn(`auto-review: 댓글 등록 실패 ${item.id}: ${(res.error ?? '').slice(0, 200)}`);
    throw new Error(`댓글 등록 실패: ${(res.error ?? '').slice(0, 120)}`);
  }
  log.info(`auto-review: 댓글 등록 ${item.id} (${res.commentId ?? '-'})`);

  // 지적 없으면 사람 손을 안 빌린다 — 봇이 자기 스레드를 닫는다.
  if (isCleanReview(markdown)) {
    const settled = await settleClean(provider, item, res.commentId);
    // 봇이 스스로 해결한 스레드는 검증 트리거가 아니다 — 캐시에 미리 기록해 둔다.
    // (사람이 해결한 Pingo 스레드는 기록에 없으므로 정상적으로 검증을 부른다)
    if (settled && res.commentId) {
      const c = store.get('reviewCache') ?? {};
      c[item.id]?.resolvedThreadIds?.push(res.commentId);
      store.set('reviewCache', c);
    }
    return settled ? '댓글 게시 · 지적 없음 → 스레드 자체 해결' : '댓글 게시 · 지적 없음';
  }
  return '댓글 게시';
}
