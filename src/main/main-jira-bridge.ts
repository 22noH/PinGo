// main/main-jira-bridge.ts — Jira poller + webhook server 생명주기 (main.ts 분리)
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AppSettings,
  JiraConfig,
  JiraEvent,
  JiraIssueSummary,
  StoreSchema,
} from '../shared/types';
import { DEFAULT_JIRA_WEBHOOK_PORT } from '../shared/constants';
import { createJiraPoller, JiraPollerController } from './jira-poller';
import {
  createJiraWebhookServer,
  JiraWebhookController,
} from './providers/jira/jira-webhook-server';

export interface JiraBridgeCallbacks {
  /** 새 Jira 이벤트 수신 (poll 또는 webhook) */
  onEvent: (ev: JiraEvent) => void;
  /** recentJiraIssues 갱신 시 리스트 윈도우에 브로드캐스트 */
  onIssues: (issues: JiraIssueSummary[]) => void;
  /** provider 실패 — 헬스 상태 업데이트용 */
  onError: (err: Error, jiraConfigId: string) => void;
}

export interface JiraBridgeController {
  start(settings: AppSettings): void;
  stop(): Promise<void>;
  /** AppSettings 변경 시 전체 재구성 (poller + webhook 서버 on/off) */
  reconfigure(settings: AppSettings): Promise<void>;
  /** 즉시 Jira 폴링 tick 1회 실행 */
  refresh(): void;
}

function pickPrimaryConfig(configs: JiraConfig[]): JiraConfig | null {
  return configs[0] ?? null;
}

export function createJiraBridge(
  store: Store<StoreSchema>,
  cb: JiraBridgeCallbacks,
): JiraBridgeController {
  let poller: JiraPollerController | null = null;
  let webhook: JiraWebhookController | null = null;

  const teardownWebhook = async (): Promise<void> => {
    if (!webhook) return;
    try {
      await webhook.stop();
    } catch (err) {
      log.warn(`jira-bridge: webhook stop failed: ${String(err).slice(0, 200)}`);
    }
    webhook = null;
  };

  const setupWebhook = async (settings: AppSettings): Promise<void> => {
    const enabled = settings.jiraWebhookEnabled === true;
    const port = settings.jiraWebhookPort ?? DEFAULT_JIRA_WEBHOOK_PORT;
    const token = store.get('jiraWebhookToken') ?? '';
    const primary = pickPrimaryConfig(settings.jiraConnections ?? []);
    if (!enabled || !token || !primary) {
      await teardownWebhook();
      return;
    }
    await teardownWebhook();
    webhook = createJiraWebhookServer({
      port,
      token,
      onEvent: (ev) => {
        cb.onEvent(ev);
        poller?.ingestWebhookEvent(ev);
      },
      onTokenRotate: async (newToken: string): Promise<void> => {
        store.set('jiraWebhookToken', newToken);
      },
      resolveJiraConfigId: () => primary.id,
      resolveBaseUrl: () => primary.url,
    });
    try {
      await webhook.start();
    } catch (err) {
      log.warn(`jira-bridge: webhook start failed (fallback to polling only): ${String(err).slice(0, 200)}`);
      webhook = null;
    }
  };

  const setupPoller = (settings: AppSettings): void => {
    const configs = settings.jiraConnections ?? [];
    const interval = settings.pollIntervalMs;
    if (!poller) {
      poller = createJiraPoller(configs, interval, store, {
        onEvents: (events): void => events.forEach(cb.onEvent),
        onIssues: cb.onIssues,
        onError: cb.onError,
      });
      if (configs.length > 0) poller.start();
      return;
    }
    poller.replace(configs, interval);
  };

  return {
    start: (settings: AppSettings): void => {
      setupPoller(settings);
      void setupWebhook(settings);
    },
    stop: async (): Promise<void> => {
      poller?.stop();
      poller = null;
      await teardownWebhook();
    },
    reconfigure: async (settings: AppSettings): Promise<void> => {
      setupPoller(settings);
      await setupWebhook(settings);
    },
    refresh: (): void => {
      poller?.refresh();
    },
  };
}
