// main/auto-review.ts — 새 MR/PR 감지 시 백그라운드 AI 리뷰 (진입점·트리거·현황)
//
// 흐름: 감지 → 오케스트레이터(동시성/대기열) → 파이프라인(pipeline.ts: 클론 → AI → 게시).
// 리뷰 창을 열면 기존 캐시 복원 경로(REVIEW_CACHE_LOAD)로 결과가 그대로 표시된다.
//
// 트리거 정책:
//   - 리뷰 이력 없음 → 첫 리뷰. 실패해도 캐시가 안 생기므로 다음 tick 에 다시 잡힌다(백오프 후).
//   - 리뷰 이력 있음 → 폴링 tick 마다 토론을 조회해, 새로 해결된 스레드만 "해결 검증".
//     댓글 없는 resolve 는 MR updatedAt 을 안 바꿔서 updatedAt 게이트를 두면 영영 못 잡는다.
import { shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type { Discussion, GitConfig, ReviewItemSummary, StoreSchema } from '../shared/types';
import {
  AutoReviewOrchestrator, createAutoReviewOrchestrator, isResolved, resolveAutoReviewConcurrency,
} from './auto-review/orchestrator';
import type { AutoReviewStatus } from './auto-review/status';
import { mask, postOne, runOne, type AutoReviewPayload, type ReviewOutcome } from './auto-review/pipeline';
import { hasAcceptedVerification } from './auto-review/verify';
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
          failedAt.set(req.key, Date.now());
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

/**
 * 해결(resolved)된 스레드 id 목록 — Pingo 자기 리뷰 스레드도 포함한다.
 * 사람이 지적을 고치고 Pingo 스레드를 해결하는 게 검증의 핵심 신호이기 때문.
 * 무한루프(리뷰 → 봇 자체 해결 → 검증)는 봇이 settleClean 으로 스스로 해결한
 * 스레드 id 를 캐시 resolvedThreadIds 에 기록하는 쪽(postOne)에서 막는다.
 */
export function resolvedIds(discussions: Discussion[]): string[] {
  return discussions.filter(isResolved).map((d) => d.id);
}

/**
 * 지난 리뷰 이후 새로 해결된 스레드가 있는지 — 해결 검증 트리거.
 * 지적을 고치고 스레드를 닫으면 그 스레드만 "진짜 고쳐졌나" 검증해 답글로 남긴다.
 */
export function newlyResolved(cachedIds: string[] | undefined, current: string[]): string[] {
  if (!cachedIds) return []; // 리뷰 이력이 없으면 검증이 아니라 첫 리뷰 경로
  const before = new Set(cachedIds);
  return current.filter((id) => !before.has(id));
}

/** 캐시 항목 중 검증 기준에 쓰는 부분 */
export interface ResolvedRecord {
  resolvedThreadIds?: string[];
  resolvedAt?: Record<string, string>;
}

/**
 * 검증할 스레드: 새로 해결된 것 + 수용 이후 다시 열었다 닫은 것(resolvedAt 이 기록과 다름).
 * id 만 기억하면 재해결이 영영 안 잡힌다(20260914 리포트). GitHub 처럼 resolvedAt 을
 * 모르는 provider 는 id 기준으로만 본다.
 * 단, 수용된 검증 답글이 이미 달린 스레드는 제외 — 닫을 때마다 AI 가 도는 것을 막는다.
 * (검증 답글이 없거나 마지막 판정이 미해결이면 닫을 때마다 검증)
 */
export function threadsToVerify(entry: ResolvedRecord, discussions: Discussion[]): string[] {
  if (!entry.resolvedThreadIds) return [];
  const known = new Set(entry.resolvedThreadIds);
  const at = entry.resolvedAt ?? {};
  return discussions
    .filter(isResolved)
    .filter((d) => !hasAcceptedVerification(d))
    .filter((d) => !known.has(d.id) || (d.resolvedAt !== undefined && at[d.id] !== undefined && at[d.id] !== d.resolvedAt))
    .map((d) => d.id);
}

/**
 * 다시 열린(더 이상 resolved 가 아닌) 스레드를 기록에서 뺀다 — 이후 닫으면 새 해결로 잡힌다.
 * 봇이 "미해결" 로 다시 연 스레드, resolvedAt 을 모르는 provider 의 재해결이 이 경로로 잡힌다.
 */
export function pruneUnresolved(entry: ResolvedRecord, discussions: Discussion[]): ResolvedRecord {
  const stillResolved = new Set(discussions.filter(isResolved).map((d) => d.id));
  const ids = (entry.resolvedThreadIds ?? []).filter((id) => stillResolved.has(id));
  const at: Record<string, string> = {};
  for (const id of ids) {
    const v = entry.resolvedAt?.[id];
    if (v) at[id] = v;
  }
  return { resolvedThreadIds: ids, resolvedAt: at };
}

/**
 * 구버전 캐시(id 만 있고 resolvedAt 없음)에 현재 해결 시각을 채운다 — 이 다음 재해결부터 잡힌다.
 * 알려진 id 중 지금 resolved 이고 시각을 아는 것만 기록한다.
 */
export function seedResolvedAt(entry: ResolvedRecord, discussions: Discussion[]): ResolvedRecord {
  const known = new Set(entry.resolvedThreadIds ?? []);
  const at: Record<string, string> = {};
  for (const d of discussions) {
    if (known.has(d.id) && isResolved(d) && d.resolvedAt) at[d.id] = d.resolvedAt;
  }
  return { resolvedThreadIds: entry.resolvedThreadIds, resolvedAt: at };
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
  const lastFail = failedAt.get(key);
  if (!force && lastFail !== undefined && Date.now() - lastFail < RETRY_BACKOFF_MS) return;

  log.info(`auto-review: queue ${key} (${why}) ${item.title.slice(0, 60)}`);
  failedAt.delete(key);
  orch.submit({ key, payload: { item, cfg, ai: settings.ai, store, verifyThreadIds } });
}

/**
 * 트레이 메뉴에서 사람이 직접 누른 재리뷰 — 이력/스코프/백오프 검사 없이 전체 리뷰를 다시 돌린다.
 * 자동 경로는 첫 리뷰 이후 "해결 검증"만 하므로, 전체 재리뷰는 이 수동 트리거가 유일한 통로.
 */
export function forceAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  submit(store, item, '수동 재리뷰', undefined, true);
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
 *  - 리뷰 이력 있음 → 토론을 조회해 새로 해결된 스레드가 있을 때만 그 스레드의 해결 검증
 *
 * 토론 조회는 리뷰된 대상 MR 마다 tick 당 1회. 같은 MR 의 검증이 이미 돌고 있으면 건너뛴다.
 */
export function maybeAutoReviewOnPoll(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  const settings = store.get('settings');
  if (settings.autoReviewEnabled !== true) return;
  const cached = (store.get('reviewCache') ?? {})[item.id];
  if (!cached) {
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
      const cache = store.get('reviewCache') ?? {};
      const entry = cache[item.id];
      if (!entry) return;
      if (!entry.resolvedThreadIds) {
        // 구버전 캐시(기준 없음)는 지금 상태를 기준으로 — 다음 해결부터 검증이 걸린다
        entry.resolvedThreadIds = resolvedIds(discussions);
        store.set('reviewCache', cache);
        return;
      }
      if (!entry.resolvedAt) {
        // 0.5.8 이전 캐시 — 해결 시각 기준을 지금 채워야 재해결(열었다 닫음)이 잡힌다
        entry.resolvedAt = seedResolvedAt(entry, discussions).resolvedAt;
        store.set('reviewCache', cache);
      }
      // 다시 열린 스레드는 기록에서 제거 — 재해결 시 새 해결로 잡히게
      const pruned = pruneUnresolved(entry, discussions);
      if (pruned.resolvedThreadIds!.length !== entry.resolvedThreadIds.length) {
        entry.resolvedThreadIds = pruned.resolvedThreadIds;
        entry.resolvedAt = pruned.resolvedAt;
        store.set('reviewCache', cache);
      }
      const fresh = threadsToVerify(entry, discussions);
      if (fresh.length === 0) return;
      // 전체 재리뷰가 아니라 해결 검증만 — 재리뷰 댓글이 새 스레드를 만들어
      // 해결 → 리뷰 → 해결 무한 반복이 되는 것을 막는다
      submit(store, item, `스레드 ${fresh.length}건 해결 — 검증`, fresh);
    } catch (err) {
      log.warn(`auto-review: 토론 조회 실패 ${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}
