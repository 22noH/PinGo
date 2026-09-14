// main/auto-review.ts — 새 MR/PR 감지 시 백그라운드 AI 리뷰 (진입점·트리거·현황)
//
// 흐름: 감지 → 오케스트레이터(동시성/대기열) → 파이프라인(pipeline.ts: 클론 → AI → 게시).
// 리뷰 창을 열면 기존 캐시 복원 경로(REVIEW_CACHE_LOAD)로 결과가 그대로 표시된다.
//
// 트리거 정책:
//   - 리뷰 이력 없음 → 첫 리뷰. 실패해도 캐시가 안 생기므로 다음 tick 에 다시 잡힌다(백오프 후).
//   - 리뷰 이력 있음 → 폴링 tick 마다 토론을 조회해, 검증할 스레드(pending.ts)가 있으면 "해결 검증".
//     판단은 캐시가 아니라 MR 댓글 자체로 한다 — 리뷰 댓글 이후 해결됐고 검증 답글이 없는 스레드.
//     댓글 없는 resolve 는 MR updatedAt 을 안 바꿔서 updatedAt 게이트를 두면 영영 못 잡는다.
//   - 트레이 "다시 실행" 은 리뷰 댓글이 있으면 검증, 없으면 전체 리뷰(smartAutoReview).
import { shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type { GitConfig, ReviewItemSummary, StoreSchema } from '../shared/types';
import {
  AutoReviewOrchestrator, createAutoReviewOrchestrator, resolveAutoReviewConcurrency,
} from './auto-review/orchestrator';
import type { AutoReviewStatus } from './auto-review/status';
import { mask, postOne, runOne, type AutoReviewPayload, type ReviewOutcome } from './auto-review/pipeline';
import { pendingVerifications } from './auto-review/pending';
import { createGitProvider } from './providers/git/git-provider';
import { sendAutoReviewFailure } from './notifier';

export { prepareWorkspace, resolveSlotsPerProject } from './auto-review/pipeline';

/** 실패한 요청을 같은 key 로 다시 접수하기까지의 최소 간격 — 매 tick 재시도하면 실패 알림이 30초마다 뜬다 */
export const RETRY_BACKOFF_MS = 10 * 60_000;

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

/** 해결 검증 요청의 오케스트레이터 key — 전체 리뷰(item.id)와 분리해 서로 덮거나 버리지 않게 */
export function verifyKey(itemId: string): string {
  return `${itemId}#verify`;
}

/** 검증 실패 백오프는 스레드 단위 — 한 스레드가 실패해도 같은 MR 의 다른 스레드 검증을 막지 않는다 */
function threadFailKey(itemId: string, threadId: string): string {
  return `${verifyKey(itemId)}:${threadId}`;
}

/** 자동 리뷰가 실패했음을 사용자에게 알린다. 알림을 꺼둔 상태(MUTED)면 로그만 남긴다. */
function notifyFailure(payload: AutoReviewPayload, reason: string): void {
  if (payload.store.get('settings').notificationEnabled !== true) return;
  sendAutoReviewFailure(payload.item, reason, () => {
    void shell.openExternal(payload.item.webUrl);
  });
}

// ── 오케스트레이터 (단일 인스턴스, 동시 상한은 제자리에서 갱신) ─────────────
let orchestrator: AutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome> | null = null;
let orchestratorMax = 0;
let changeListener: (() => void) | null = null;
/** key → 마지막 실패 시각. 백오프 안에는 같은 key 를 다시 접수하지 않는다. */
const failedAt = new Map<string, number>();

/** 현황이 바뀔 때(접수/단계/완료) 불릴 콜백 — 트레이 메뉴 갱신용 */
export function onAutoReviewChange(fn: () => void): void {
  changeListener = fn;
}

function recordFailure(req: { key: string; payload: AutoReviewPayload }): void {
  const now = Date.now();
  const threads = req.payload.verifyThreadIds;
  if (threads) for (const t of threads) failedAt.set(threadFailKey(req.payload.item.id, t), now);
  else failedAt.set(req.key, now);
}

function inBackoff(key: string, now = Date.now()): boolean {
  const last = failedAt.get(key);
  return last !== undefined && now - last < RETRY_BACKOFF_MS;
}

function getOrchestrator(concurrency: number): AutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome> {
  if (!orchestrator) {
    orchestratorMax = concurrency;
    orchestrator = createAutoReviewOrchestrator<AutoReviewPayload, ReviewOutcome>(
      { autoReviewConcurrency: concurrency },
      {
        runReview: runOne,
        postResult: postOne,
        logError: (msg, req) => {
          const safe = mask(msg, req.payload.cfg.token).slice(0, 200);
          log.warn(`auto-review: failed ${req.key}: ${safe}`);
          recordFailure(req);
          notifyFailure(req.payload, safe);
        },
        onChange: () => changeListener?.(),
      },
    );
  } else if (orchestratorMax !== concurrency) {
    log.info(`auto-review: 동시 상한 변경 ${orchestratorMax} → ${concurrency}`);
    orchestratorMax = concurrency;
    orchestrator.setMaxConcurrent(concurrency);
  }
  return orchestrator;
}

/** 트레이 메뉴 표시용 — 지금 뭐가 어느 단계에 있고, 뭐가 기다리고, 최근에 뭐가 됐는지 */
export function getAutoReviewStatus(): AutoReviewStatus {
  const s = orchestrator?.snapshot();
  if (!s) return { active: [], queued: [], recent: [] };
  const kind = (p: AutoReviewPayload): 'review' | 'verify' => (p.verifyThreadIds ? 'verify' : 'review');
  return {
    active: s.active.map((a) => ({ item: a.payload.item, kind: kind(a.payload), phase: a.phase, startedAt: a.startedAt })),
    queued: s.queued.map((q) => ({ item: q.payload.item, kind: kind(q.payload) })),
    recent: s.recent.map((r) => ({ item: r.payload.item, kind: kind(r.payload), ok: r.ok, summary: r.summary, at: r.at })),
  };
}

function submit(
  store: Store<StoreSchema>,
  item: ReviewItemSummary,
  why: string,
  verifyThreadIds?: string[],
  force = false,
): void {
  const settings = store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!force && !isReviewTarget(settings.autoReviewScope, cfg, item)) return;

  const key = verifyThreadIds ? verifyKey(item.id) : item.id;
  const orch = getOrchestrator(resolveAutoReviewConcurrency(settings));
  if (orch.has(key)) return; // 이미 실행/대기 중 — 로그 소음 방지

  let threads = verifyThreadIds;
  if (threads && !force) {
    threads = threads.filter((t) => !inBackoff(threadFailKey(item.id, t)));
    if (threads.length === 0) return; // 전부 백오프 중
  }
  if (!threads && !force && inBackoff(key)) return;

  log.info(`auto-review: queue ${key} (${why}) ${item.title.slice(0, 60)}`);
  if (threads) for (const t of threads) failedAt.delete(threadFailKey(item.id, t));
  else failedAt.delete(key);
  orch.submit({ key, payload: { item, cfg, ai: settings.ai, store, verifyThreadIds: threads } });
}

/**
 * 트레이 "전체 리뷰 새로 달기" — 이력/스코프/백오프 검사 없이 전체 리뷰를 다시 돌려 새 댓글을 단다.
 * 완료 시 postOne 이 캐시를 새로 쓴다.
 */
export function forceAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  submit(store, item, '수동 전체 리뷰', undefined, true);
}

/**
 * 트레이 "자동 리뷰 다시 실행" — MR 댓글을 보고 판단한다:
 *   Pingo 리뷰 댓글이 없으면 전체 리뷰, 있으면 해결된 스레드의 검증(검증할 게 없어도 접수해
 *   이력에 "대상 없음" 이 남게 한다). 자동 경로가 놓친 검증을 사람이 즉시 밀어넣는 통로.
 */
export async function smartAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): Promise<void> {
  const cfg = store.get('settings').gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  try {
    const discussions = await createGitProvider(cfg).fetchDiscussions(item);
    const pending = pendingVerifications(discussions);
    if (!pending.reviewed) {
      submit(store, item, '수동 — 리뷰 댓글 없음 → 전체 리뷰', undefined, true);
      return;
    }
    submit(store, item, `수동 — 스레드 ${pending.threadIds.length}건 검증`, pending.threadIds, true);
  } catch (err) {
    log.warn(`auto-review: 토론 조회 실패(수동) ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 새 MR/PR·리뷰어 지정 감지 시 첫 리뷰. 이미 리뷰한 적이 있으면 아무것도 하지 않는다. */
export function maybeAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  if (store.get('settings').autoReviewEnabled !== true) return;
  if ((store.get('reviewCache') ?? {})[item.id]) return; // 이미 리뷰됨 — 첫 리뷰 경로 종료
  submit(store, item, '첫 리뷰');
}

/**
 * 폴링 tick 마다 열린 MR/PR 전체에 대해 호출.
 *  - 리뷰 이력 없음 → 첫 리뷰 (이벤트를 놓쳤거나, 자동 리뷰를 방금 켠 경우, 지난 시도가 실패한 경우)
 *  - 리뷰 이력 있음 → 토론을 조회해 검증할 스레드가 있으면 그 스레드들의 해결 검증
 *
 * 토론 조회는 리뷰된 대상 MR 마다 tick 당 1회. 같은 MR 의 검증/리뷰가 이미 돌고 있으면 건너뛴다.
 */
export function maybeAutoReviewOnPoll(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  const settings = store.get('settings');
  if (settings.autoReviewEnabled !== true) return;
  if (!(store.get('reviewCache') ?? {})[item.id]) {
    submit(store, item, '첫 리뷰(폴링)');
    return;
  }
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!isReviewTarget(settings.autoReviewScope, cfg, item)) return;
  if (orchestrator?.has(verifyKey(item.id)) || orchestrator?.has(item.id)) return; // 이미 진행/대기 중

  void (async (): Promise<void> => {
    try {
      const discussions = await createGitProvider(cfg).fetchDiscussions(item);
      const pending = pendingVerifications(discussions);
      // 캐시는 있는데 리뷰 댓글이 없는 경우(댓글 게시 실패 등)는 자동으로 다시 달지 않는다 —
      // 실패는 이력/알림에 남고, 사람이 "다시 실행" 으로 밀어넣는다.
      if (!pending.reviewed || pending.threadIds.length === 0) return;
      // 전체 재리뷰가 아니라 해결 검증만 — 재리뷰 댓글이 새 스레드를 만들어
      // 해결 → 리뷰 → 해결 무한 반복이 되는 것을 막는다
      submit(store, item, `스레드 ${pending.threadIds.length}건 해결 — 검증`, pending.threadIds);
    } catch (err) {
      log.warn(`auto-review: 토론 조회 실패 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
