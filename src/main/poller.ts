// main/poller.ts — Multi-provider 병렬 폴러 (v2)
import axios from 'axios';
import log from 'electron-log';
import type {
  ConnectionHealth,
  ReviewItemSummary,
} from '../shared/types';
import { PROVIDER_DISPLAY_NAME } from '../shared/constants';
import type { GitProvider } from './providers/git/git-provider';

export type ItemsFoundCallback = (newItems: ReviewItemSummary[]) => void;
export type PollErrorCallback = (error: Error) => void;
export type PollTickCallback = (at: Date, health: ConnectionHealth[]) => void;

export interface PollerController {
  start(): void;
  stop(): void;
  /** providers 교체 + interval 갱신 */
  replace(providers: GitProvider[], pollIntervalMs: number): void;
}

export interface PollerCallbacks {
  onFound: ItemsFoundCallback;
  onError: PollErrorCallback;
  onTick?: PollTickCallback;
}

function connectionLabel(provider: GitProvider): string {
  const cfg = provider.config;
  if (cfg.label) return cfg.label;
  return PROVIDER_DISPLAY_NAME[cfg.type];
}

export function createPoller(
  initialProviders: GitProvider[],
  initialPollIntervalMs: number,
  seenIds: Set<string>,
  { onFound, onError, onTick }: PollerCallbacks,
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

      const now = new Date();
      const health: ConnectionHealth[] = [];
      const collected: ReviewItemSummary[] = [];
      let anyError = false;

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
        } else {
          const err = result.reason;
          if (mySignal.aborted || (axios.isCancel && axios.isCancel(err))) {
            // 요청 취소는 에러로 보지 않음
            health.push({ ...base, ok: true });
          } else {
            anyError = true;
            const msg = err instanceof Error ? err.message : String(err);
            health.push({ ...base, ok: false, error: msg });
            log.warn(
              `poller[${provider.config.type}:${provider.config.id.slice(0, 8)}]: ${msg}`,
            );
            onError(err instanceof Error ? err : new Error(msg));
          }
        }
      }

      onTick?.(now, health);

      // 중복 제거 (id 기준)
      const uniq = new Map<string, ReviewItemSummary>();
      for (const item of collected) uniq.set(item.id, item);

      const newItems = Array.from(uniq.values()).filter((m) => !seenIds.has(m.id));
      if (newItems.length > 0) {
        log.info(`poller: ${newItems.length} new item(s) detected`);
        onFound(newItems);
      } else {
        log.debug(
          `poller: no new items (total open: ${uniq.size}, providers: ${providers.length}, anyErr: ${anyError})`,
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

