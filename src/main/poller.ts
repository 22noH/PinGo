// main/poller.ts — Multi-provider 병렬 폴러 (v2)
import axios from 'axios';
import log from 'electron-log';
import type {
  ConnectionHealth,
  DiscussionNote,
  ItemEvent,
  ReviewItemSummary,
} from '../shared/types';
import { PROVIDER_DISPLAY_NAME } from '../shared/constants';
import type { GitProvider } from './providers/git/git-provider';

export type EventsFoundCallback = (events: ItemEvent[]) => void;
export type PollErrorCallback = (error: Error) => void;
export type PollTickCallback = (at: Date, health: ConnectionHealth[]) => void;
/** 매 tick 마다 현재 열려있는 아이템 전체 목록 (updatedAt desc 정렬) */
export type OpenItemsCallback = (items: ReviewItemSummary[]) => void;

export interface PollerSeenState {
  /** 이미 본 MR/PR id 집합 (신규 MR 감지) */
  items: Set<string>;
  /** 이미 "리뷰어 지정"을 알림받은 MR/PR id 집합 */
  reviewerAssigned: Set<string>;
  /** item id → 마지막으로 본 note의 ISO 타임스탬프 */
  lastSeenNoteAt: Map<string, string>;
}

export interface PollerController {
  start(): void;
  stop(): void;
  /** 사용자 요청에 의한 즉시 폴링 (timer는 건드리지 않음) */
  refresh(): void;
  /** providers 교체 + interval 갱신 */
  replace(providers: GitProvider[], pollIntervalMs: number): void;
}

export interface PollerCallbacks {
  onEvents: EventsFoundCallback;
  onError: PollErrorCallback;
  onTick?: PollTickCallback;
  onOpenItems?: OpenItemsCallback;
  /**
   * v3 확장 — 기본 이벤트 검출 후 추가 훅.
   * pipeline/approval/issue 등 optional v3 이벤트 수집기. 반환된 배열은 onEvents 로 합산 전달.
   * signal 은 현재 tick abort 용.
   */
  detectExtraEvents?: (openItems: ReviewItemSummary[], signal: AbortSignal) => Promise<ItemEvent[]>;
}

function connectionLabel(provider: GitProvider): string {
  const cfg = provider.config;
  if (cfg.label) return cfg.label;
  return PROVIDER_DISPLAY_NAME[cfg.type];
}

function isNoteRelevant(
  note: DiscussionNote,
  item: ReviewItemSummary,
  provider: GitProvider,
): boolean {
  // 내가 단 댓글은 알림 대상 아님
  const cfg = provider.config;
  if (cfg.type === 'gitlab' && note.author.id === cfg.userId) return false;
  if (cfg.type === 'github' && note.author.username.toLowerCase() === cfg.username.toLowerCase())
    return false;
  void item;
  // 멘션된 댓글만 알림 대상 (일반 댓글은 스킵)
  return note.mentionsCurrentUser;
}

export function createPoller(
  initialProviders: GitProvider[],
  initialPollIntervalMs: number,
  seen: PollerSeenState,
  { onEvents, onError, onTick, onOpenItems, detectExtraEvents }: PollerCallbacks,
): PollerController {
  let providers: GitProvider[] = [...initialProviders];
  let pollIntervalMs = initialPollIntervalMs;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let abortController: AbortController | null = null;

  const abortInFlight = (reason: string): void => {
    if (abortController) {
      log.info(`poller: aborting in-flight request (${reason})`);
      abortController.abort();
      abortController = null;
    }
  };

  const providerById = (id: string): GitProvider | undefined =>
    providers.find((p) => p.config.id === id);

  // 각 item 의 updatedAt > lastSeenNoteAt 만 조회, 첫 조회는 seed 만 (기존 댓글 오인 방지).
  const detectCommentEvents = async (
    items: ReviewItemSummary[],
    signal: AbortSignal,
  ): Promise<ItemEvent[]> => {
    const candidates = items.filter((item) => {
      const last = seen.lastSeenNoteAt.get(item.id);
      if (!last) return true;
      return item.updatedAt > last;
    });
    if (candidates.length === 0) return [];
    const results = await Promise.allSettled(
      candidates.map(async (item): Promise<ItemEvent | null> => {
        const provider = providerById(item.gitConfigId);
        if (!provider) return null;
        const discussions = await provider.fetchDiscussions(item, signal);
        const allNotes = discussions
          .flatMap((d) => d.notes)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (allNotes.length === 0) return null;
        const newest = allNotes[allNotes.length - 1].createdAt;
        const lastSeen = seen.lastSeenNoteAt.get(item.id);
        if (!lastSeen) { seen.lastSeenNoteAt.set(item.id, newest); return null; }
        const newNotes = allNotes.filter(
          (n) => n.createdAt > lastSeen && isNoteRelevant(n, item, provider),
        );
        seen.lastSeenNoteAt.set(item.id, newest);
        if (newNotes.length === 0) return null;
        return { kind: 'new_comments', item, newNotes };
      }),
    );
    const events: ItemEvent[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) events.push(r.value);
      else if (r.status === 'rejected') log.warn(`poller: discussion fetch failed: ${String(r.reason)}`);
    }
    return events;
  };

  const tick = async (): Promise<void> => {
    if (inFlight) {
      log.debug('poller: previous tick still running, skipping');
      return;
    }
    if (providers.length === 0) {
      log.debug('poller: no providers configured, skipping tick');
      return;
    }

    inFlight = true;
    abortController = new AbortController();
    const mySignal = abortController.signal;

    try {
      const results = await Promise.allSettled(
        providers.map((p) => p.fetchOpenItems(mySignal)),
      );

      // abort된 tick은 recentItems 갱신/이벤트 방출에서 제외 (빈 데이터로 overwrite 방지)
      if (mySignal.aborted) {
        log.debug('poller: tick aborted, skipping events/update');
        return;
      }

      const now = new Date();
      const health: ConnectionHealth[] = [];
      const collected: ReviewItemSummary[] = [];
      let anyError = false;
      let anyFulfilled = false;

      for (let i = 0; i < providers.length; i += 1) {
        const provider = providers[i];
        const result = results[i];
        const base: ConnectionHealth = {
          gitConfigId: provider.config.id,
          providerType: provider.config.type,
          label: connectionLabel(provider),
          ok: false,
          lastCheckedAt: now.toISOString(),
        };
        if (result.status === 'fulfilled') {
          collected.push(...result.value);
          health.push({ ...base, ok: true });
          anyFulfilled = true;
        } else {
          const err = result.reason;
          if (mySignal.aborted || (axios.isCancel && axios.isCancel(err))) {
            health.push({ ...base, ok: true });
          } else {
            anyError = true;
            const msg = err instanceof Error ? err.message : String(err);
            health.push({ ...base, ok: false, error: msg });
            log.warn(`poller[${provider.config.type}:${provider.config.id.slice(0, 8)}]: ${msg}`);
            onError(err instanceof Error ? err : new Error(msg));
          }
        }
      }

      onTick?.(now, health);

      // 중복 제거 (id 기준) — 같은 MR이 author+reviewer 양쪽에서 돌아올 수 있음
      const uniq = new Map<string, ReviewItemSummary>();
      for (const item of collected) uniq.set(item.id, item);
      const unique = Array.from(uniq.values()).sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      );

      // 전 provider가 실패한 경우 trayRecent 유지 (일시적 네트워크 이슈로 리스트가 비워지지 않도록)
      if (anyFulfilled) {
        onOpenItems?.(unique);
      }

      const events: ItemEvent[] = [];

      // 1) 신규 MR/PR 감지 (기존 로직)
      for (const item of unique) {
        if (!seen.items.has(item.id)) {
          events.push({ kind: 'new_item', item });
        }
      }

      // 2) 리뷰어 지정 감지 (기존 item이면서 내가 리뷰어에 들어옴)
      for (const item of unique) {
        const provider = providerById(item.gitConfigId);
        if (!provider) continue;
        const iAmReviewer = provider.isCurrentUserReviewer(item);
        if (iAmReviewer) {
          if (!seen.reviewerAssigned.has(item.id) && seen.items.has(item.id)) {
            events.push({ kind: 'reviewer_assigned', item });
          }
          seen.reviewerAssigned.add(item.id);
        } else {
          // 리뷰어에서 빠지면 재지정 시 다시 알림 받을 수 있도록 제거
          seen.reviewerAssigned.delete(item.id);
        }
      }

      // 3) 새 댓글 감지 (비동기, item 상관없이 내가 관련된 모든 MR)
      const commentEvents = await detectCommentEvents(unique, mySignal);
      events.push(...commentEvents);

      // 4) v3 확장 — pipeline / approval / issue 훅 (optional)
      if (detectExtraEvents) {
        try {
          const extra = await detectExtraEvents(unique, mySignal);
          events.push(...extra);
        } catch (err) {
          log.warn(`poller: v3 extra events failed: ${String(err).slice(0, 200)}`);
        }
      }

      if (events.length > 0) {
        log.info(`poller: events detected — total=${events.length}`);
        onEvents(events);
      } else {
        log.debug(
          `poller: no events (total open: ${unique.length}, providers: ${providers.length}, anyErr: ${anyError})`,
        );
      }
    } finally {
      inFlight = false;
      if (abortController && abortController.signal === mySignal) {
        abortController = null;
      }
    }
  };

  const scheduleNext = (): void => {
    if (timer) clearInterval(timer);
    timer = setInterval((): void => {
      void tick();
    }, pollIntervalMs);
  };

  return {
    start: (): void => {
      log.info(
        `poller: start (providers=${providers.length}, interval=${pollIntervalMs}ms)`,
      );
      void tick();
      scheduleNext();
    },
    stop: (): void => {
      log.info('poller: stop');
      abortInFlight('stop');
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    refresh: (): void => {
      log.info('poller: manual refresh');
      void tick();
    },
    replace: (nextProviders: GitProvider[], nextInterval: number): void => {
      log.info(
        `poller: replace (providers=${nextProviders.length}, interval=${nextInterval}ms)`,
      );
      abortInFlight('replace');
      providers = [...nextProviders];
      pollIntervalMs = nextInterval;
      if (timer) clearInterval(timer);
      void tick();
      scheduleNext();
    },
  };
}
