// main/jira-poller.ts — Jira 폴링 격리 (§20.13.I2)
// Git poller 와 동일 tick 을 공유하지 않고 자체 setInterval.
// 실패 시 Git 폴러에 영향 없음 (Promise.allSettled 로 수신 측에서 격리).
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  JiraConfig,
  JiraEvent,
  JiraIssueSummary,
  StoreSchema,
} from '../shared/types';
import { MAX_SEEN_JIRA_ISSUE_IDS } from '../shared/constants';
import { JiraProvider } from './providers/jira/jira-provider';

export type JiraEventsCallback = (events: JiraEvent[]) => void;
export type JiraIssuesCallback = (issues: JiraIssueSummary[]) => void;
export type JiraErrorCallback = (err: Error, jiraConfigId: string) => void;

export interface JiraPollerController {
  start(): void;
  stop(): void;
  refresh(): void;
  replace(configs: JiraConfig[], intervalMs: number): void;
  /** 외부(웹훅)에서 유입된 이벤트도 중복 제거 + recent 갱신. */
  ingestWebhookEvent(ev: JiraEvent): void;
}

export interface JiraPollerCallbacks {
  onEvents: JiraEventsCallback;
  onIssues: JiraIssuesCallback;
  onError: JiraErrorCallback;
}

function capTail(list: string[], max: number): string[] {
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

export function createJiraPoller(
  initialConfigs: JiraConfig[],
  initialIntervalMs: number,
  store: Store<StoreSchema>,
  { onEvents, onIssues, onError }: JiraPollerCallbacks,
): JiraPollerController {
  let providers: JiraProvider[] = initialConfigs.map((c) => new JiraProvider(c));
  let intervalMs = initialIntervalMs;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let abortController: AbortController | null = null;

  const dedupeAndEmit = (issues: JiraIssueSummary[], kind: JiraEvent['kind']): JiraEvent[] => {
    if (issues.length === 0) return [];
    const seen = new Set(store.get('seenJiraIssueIds') ?? []);
    const events: JiraEvent[] = [];
    for (const it of issues) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      events.push({ kind, issue: it });
    }
    if (events.length > 0) {
      const next = capTail(Array.from(seen), MAX_SEEN_JIRA_ISSUE_IDS);
      store.set('seenJiraIssueIds', next);
    }
    return events;
  };

  /** 폴링 tick 결과는 "현재 열려있는 전체 이슈" 스냅샷 — 치환. */
  const replaceRecent = (issues: JiraIssueSummary[]): void => {
    const sorted = [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const capped = sorted.slice(0, 500);
    store.set('recentJiraIssues', capped);
    onIssues(capped);
  };

  /** 웹훅 단건 수신 — 기존 목록에 머지. */
  const mergeOneIntoRecent = (issue: JiraIssueSummary): void => {
    const prev = store.get('recentJiraIssues') ?? [];
    const byId = new Map(prev.map((i) => [i.id, i]));
    byId.set(issue.id, issue);
    const merged = Array.from(byId.values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 500);
    store.set('recentJiraIssues', merged);
    onIssues(merged);
  };

  const tick = async (): Promise<void> => {
    if (inFlight || providers.length === 0) return;
    inFlight = true;
    abortController = new AbortController();
    const mySignal = abortController.signal;

    try {
      const results = await Promise.allSettled(
        providers.map(async (p) => ({
          assigned: await p.fetchAssignedIssues(mySignal),
          configId: p.config.id,
        })),
      );

      if (mySignal.aborted) return;

      const allIssues: JiraIssueSummary[] = [];
      const assignedEvents: JiraEvent[] = [];

      for (let i = 0; i < results.length; i += 1) {
        const r = results[i];
        const cfgId = providers[i]?.config.id ?? '';
        if (r.status === 'fulfilled') {
          allIssues.push(...r.value.assigned);
          assignedEvents.push(...dedupeAndEmit(r.value.assigned, 'jira_issue_assigned'));
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          log.warn(`jira-poller[${cfgId.slice(0, 8)}]: ${msg.slice(0, 200)}`);
          onError(r.reason instanceof Error ? r.reason : new Error(msg), cfgId);
        }
      }

      replaceRecent(allIssues);
      const events = [...assignedEvents];
      if (events.length > 0) {
        log.info(`jira-poller: events=${events.length}`);
        onEvents(events);
      }
    } finally {
      inFlight = false;
      if (abortController?.signal === mySignal) abortController = null;
    }
  };

  const scheduleNext = (): void => {
    if (timer) clearInterval(timer);
    timer = setInterval((): void => { void tick(); }, intervalMs);
  };

  return {
    start: (): void => {
      log.info(`jira-poller: start (configs=${providers.length}, interval=${intervalMs}ms)`);
      void tick();
      scheduleNext();
    },
    stop: (): void => {
      log.info('jira-poller: stop');
      if (abortController) { abortController.abort(); abortController = null; }
      if (timer) { clearInterval(timer); timer = null; }
    },
    refresh: (): void => { void tick(); },
    replace: (nextConfigs: JiraConfig[], nextInterval: number): void => {
      log.info(`jira-poller: replace (configs=${nextConfigs.length})`);
      if (abortController) { abortController.abort(); abortController = null; }
      providers = nextConfigs.map((c) => new JiraProvider(c));
      intervalMs = nextInterval;
      if (timer) clearInterval(timer);
      void tick();
      scheduleNext();
    },
    ingestWebhookEvent: (ev: JiraEvent): void => {
      const seen = new Set(store.get('seenJiraIssueIds') ?? []);
      if (seen.has(ev.issue.id)) return;
      seen.add(ev.issue.id);
      store.set('seenJiraIssueIds', capTail(Array.from(seen), MAX_SEEN_JIRA_ISSUE_IDS));
      mergeOneIntoRecent(ev.issue);
      onEvents([ev]);
    },
  };
}
