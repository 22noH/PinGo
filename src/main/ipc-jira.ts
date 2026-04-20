// main/ipc-jira.ts — Jira IPC 핸들러 (v3)
import { ipcMain } from 'electron';
import log from 'electron-log';
import crypto from 'crypto';
import type Store from 'electron-store';
import type {
  AppSettings,
  JiraConfig,
  JiraConnectionTestPayload,
  JiraConnectionTestResult,
  JiraConnectionsLoadResult,
  JiraConnectionsSavePayload,
  StoreSchema,
} from '../shared/types';
import {
  JIRA_CONNECTIONS_LOAD,
  JIRA_CONNECTIONS_SAVE,
  JIRA_CONNECTION_TEST,
  JIRA_WEBHOOK_SECRET_GET,
  JIRA_WEBHOOK_SECRET_REGENERATE,
} from '../shared/constants';
import { JiraProvider } from './providers/jira/jira-provider';

export interface JiraIpcDeps {
  store: Store<StoreSchema>;
  /** JiraConfig[] 변경 시 poller + webhook 서버 재구성 */
  rebuildJira: (configs: JiraConfig[]) => void;
}

async function handleTest(
  payload: JiraConnectionTestPayload,
): Promise<JiraConnectionTestResult> {
  try {
    const provider = new JiraProvider(payload.config);
    return await provider.testConnection();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerJiraHandlers(deps: JiraIpcDeps): void {
  ipcMain.handle(JIRA_CONNECTIONS_LOAD, (): JiraConnectionsLoadResult => {
    const s = deps.store.get('settings');
    return { jiraConnections: s.jiraConnections ?? [] };
  });

  ipcMain.handle(
    JIRA_CONNECTIONS_SAVE,
    (_e, payload: JiraConnectionsSavePayload): void => {
      const current = deps.store.get('settings');
      const next: AppSettings = {
        ...current,
        jiraConnections: payload.jiraConnections,
      };
      deps.store.set('settings', next);

      // orphan pruning — 삭제된 jiraConfigId 의 seen/recent 제거
      const validIds = new Set(payload.jiraConnections.map((c) => c.id));
      const prunedSeen = (deps.store.get('seenJiraIssueIds') ?? []).filter((id) => {
        const [jiraConfigId] = id.split('::');
        return validIds.has(jiraConfigId);
      });
      deps.store.set('seenJiraIssueIds', prunedSeen);
      const prunedRecent = (deps.store.get('recentJiraIssues') ?? []).filter(
        (it) => validIds.has(it.jiraConfigId),
      );
      deps.store.set('recentJiraIssues', prunedRecent);

      log.info(
        `ipc-jira: connections saved (count=${payload.jiraConnections.length}, seen=${prunedSeen.length})`,
      );
      deps.rebuildJira(payload.jiraConnections);
    },
  );

  ipcMain.handle(
    JIRA_CONNECTION_TEST,
    (_e, payload: JiraConnectionTestPayload): Promise<JiraConnectionTestResult> =>
      handleTest(payload),
  );

  ipcMain.handle(JIRA_WEBHOOK_SECRET_GET, (): string => {
    let token = deps.store.get('jiraWebhookToken') ?? '';
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      deps.store.set('jiraWebhookToken', token);
    }
    return token;
  });

  ipcMain.handle(JIRA_WEBHOOK_SECRET_REGENERATE, (): string => {
    const token = crypto.randomBytes(32).toString('hex');
    deps.store.set('jiraWebhookToken', token);
    // webhook 서버 재시작 — rebuildJira 가 현재 JiraConfig[] 로 reconfigure 트리거.
    deps.rebuildJira(deps.store.get('settings').jiraConnections ?? []);
    log.info('ipc-jira: webhook token rotated + bridge reconfigured');
    return token;
  });

  log.info('ipc-jira: handlers registered');
}

export function unregisterJiraHandlers(): void {
  ipcMain.removeHandler(JIRA_CONNECTIONS_LOAD);
  ipcMain.removeHandler(JIRA_CONNECTIONS_SAVE);
  ipcMain.removeHandler(JIRA_CONNECTION_TEST);
  ipcMain.removeHandler(JIRA_WEBHOOK_SECRET_GET);
  ipcMain.removeHandler(JIRA_WEBHOOK_SECRET_REGENERATE);
}
