// main/ipc.ts — IPC 핸들러 등록 (v2)
import { BrowserWindow, ipcMain, shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AIAvailabilityTestPayload,
  AIAvailabilityTestResult,
  AIConfig,
  AIConfigLoadResult,
  AIConfigSavePayload,
  AppSettings,
  CommentPostPayload,
  CommentPostResult,
  ConnectionTestResult,
  GitConfig,
  GitConnectionTestPayload,
  GitConnectionsLoadResult,
  GitConnectionsSavePayload,
  OllamaModelsFetchPayload,
  OllamaModelsFetchResult,
  ReviewItemSummary,
  ReviewStartPayload,
  SettingsLoadResult,
  SettingsSavePayload,
  StoreSchema,
} from '../shared/types';
import {
  AI_AVAILABILITY_TEST,
  AI_CONFIG_LOAD,
  AI_CONFIG_SAVE,
  COMMENT_POST,
  GIT_CONNECTIONS_LOAD,
  GIT_CONNECTIONS_SAVE,
  GIT_CONNECTION_TEST,
  NOTIFICATION_TOGGLE,
  OLLAMA_MODELS_FETCH,
  REVIEW_ABORT,
  REVIEW_START,
  SETTINGS_LOAD,
  SETTINGS_SAVE,
  WINDOW_OPEN_MR,
} from '../shared/constants';
import { createAIProvider } from './providers/ai/ai-provider';
import { fetchOllamaModels } from './providers/ai/ollama';
import { createGitProvider } from './providers/git/git-provider';
import { runReviewStart } from './ipc-review';
import type { RunHandle } from './review-runner';

export interface IpcDeps {
  store: Store<StoreSchema>;
  getReviewWindow: () => BrowserWindow | null;
  /** GitConfig[] 변경 시 poller의 providers 재구성 트리거 */
  rebuildProviders: (configs: GitConfig[]) => void;
  /** AIConfig 변경 시 review-runner 재구성 트리거 */
  rebuildAIProvider: (config: AIConfig) => void;
  /** 폴링 간격/알림 토글 등 기타 설정 적용 */
  onSettingsSaved: (settings: AppSettings) => void;
  onNotificationToggle: () => void;
}

let currentRun: RunHandle | null = null;

async function handleCommentPost(
  store: Store<StoreSchema>,
  payload: CommentPostPayload,
): Promise<CommentPostResult> {
  const settings = store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) {
    return { success: false, error: '연결을 찾을 수 없습니다' };
  }
  const provider = createGitProvider(cfg);
  const stub: ReviewItemSummary = {
    id: `${cfg.id}::${cfg.type}::${payload.projectId}::${payload.itemId}`,
    gitConfigId: cfg.id,
    providerType: cfg.type,
    providerLabel: cfg.type === 'gitlab' ? 'GL' : 'GH',
    itemId: payload.itemId,
    title: '',
    description: '',
    author: { id: 0, name: '', username: '', avatar_url: '' },
    webUrl: '',
    sourceBranch: '',
    targetBranch: '',
    projectId: payload.projectId,
    repoFullName: payload.repoFullName,
    createdAt: '',
    updatedAt: '',
  };
  return provider.postComment(stub, payload.body);
}

async function handleGitConnectionTest(
  payload: GitConnectionTestPayload,
): Promise<ConnectionTestResult> {
  try {
    const provider = createGitProvider(payload.config);
    return await provider.testConnection();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleAIAvailabilityTest(
  payload: AIAvailabilityTestPayload,
): Promise<AIAvailabilityTestResult> {
  try {
    const provider = createAIProvider(payload.config);
    return await provider.testAvailability();
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function handleOllamaModelsFetch(
  payload: OllamaModelsFetchPayload,
): Promise<OllamaModelsFetchResult> {
  return fetchOllamaModels(payload.baseUrl);
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.on(REVIEW_START, (_e, payload: ReviewStartPayload) => {
    void (async (): Promise<void> => {
      const next = await runReviewStart(
        { store: deps.store, getReviewWindow: deps.getReviewWindow },
        payload,
        currentRun,
      );
      currentRun = next;
    })();
  });

  ipcMain.on(REVIEW_ABORT, () => {
    if (currentRun) {
      currentRun.abort();
      currentRun = null;
      log.info('ipc: review aborted by renderer');
    }
  });

  ipcMain.on(WINDOW_OPEN_MR, (_e, webUrl: string) => {
    if (typeof webUrl !== 'string' || !/^https?:\/\//.test(webUrl)) {
      log.warn(`ipc: invalid webUrl ignored: ${webUrl}`);
      return;
    }
    void shell.openExternal(webUrl);
  });

  ipcMain.on(NOTIFICATION_TOGGLE, () => {
    deps.onNotificationToggle();
  });

  ipcMain.handle(
    COMMENT_POST,
    (_e, payload: CommentPostPayload): Promise<CommentPostResult> =>
      handleCommentPost(deps.store, payload),
  );

  // ── 전체 설정 저장/로드 ─────────────────────────────────
  ipcMain.handle(SETTINGS_LOAD, (): SettingsLoadResult => {
    return { settings: deps.store.get('settings') };
  });

  ipcMain.handle(SETTINGS_SAVE, (_e, payload: SettingsSavePayload): void => {
    deps.store.set('settings', payload.settings);
    log.info('ipc: settings saved (full)');
    deps.rebuildProviders(payload.settings.gitConnections);
    deps.rebuildAIProvider(payload.settings.ai);
    deps.onSettingsSaved(payload.settings);
  });

  // ── Git 연결 전용 IPC ───────────────────────────────────
  ipcMain.handle(GIT_CONNECTIONS_LOAD, (): GitConnectionsLoadResult => {
    return { gitConnections: deps.store.get('settings').gitConnections };
  });

  ipcMain.handle(
    GIT_CONNECTIONS_SAVE,
    (_e, payload: GitConnectionsSavePayload): void => {
      const current = deps.store.get('settings');
      const next: AppSettings = {
        ...current,
        gitConnections: payload.gitConnections,
      };
      deps.store.set('settings', next);

      // ── orphan pruning: 삭제된 gitConfigId 에 연결된 recentItems/seenItemIds 제거
      const validIds = new Set(payload.gitConnections.map((c) => c.id));
      const prunedRecent = deps.store
        .get('recentItems')
        .filter((it) => validIds.has(it.gitConfigId));
      deps.store.set('recentItems', prunedRecent);

      const prunedSeen = deps.store
        .get('seenItemIds')
        .filter((id) => {
          const [gitConfigId] = id.split('::');
          return validIds.has(gitConfigId);
        });
      deps.store.set('seenItemIds', prunedSeen);

      log.info(
        `ipc: gitConnections saved (count=${payload.gitConnections.length}, recent=${prunedRecent.length}, seen=${prunedSeen.length})`,
      );
      deps.rebuildProviders(payload.gitConnections);
      deps.onSettingsSaved(next);
    },
  );

  ipcMain.handle(
    GIT_CONNECTION_TEST,
    (_e, payload: GitConnectionTestPayload): Promise<ConnectionTestResult> =>
      handleGitConnectionTest(payload),
  );

  // ── AI 설정 전용 IPC ────────────────────────────────────
  ipcMain.handle(AI_CONFIG_LOAD, (): AIConfigLoadResult => {
    return { ai: deps.store.get('settings').ai };
  });

  ipcMain.handle(AI_CONFIG_SAVE, (_e, payload: AIConfigSavePayload): void => {
    const current = deps.store.get('settings');
    const next: AppSettings = { ...current, ai: payload.ai };
    deps.store.set('settings', next);
    log.info(`ipc: AI config saved (type=${payload.ai.type})`);
    deps.rebuildAIProvider(payload.ai);
    deps.onSettingsSaved(next);
  });

  ipcMain.handle(
    AI_AVAILABILITY_TEST,
    (_e, payload: AIAvailabilityTestPayload): Promise<AIAvailabilityTestResult> =>
      handleAIAvailabilityTest(payload),
  );

  ipcMain.handle(
    OLLAMA_MODELS_FETCH,
    (_e, payload: OllamaModelsFetchPayload): Promise<OllamaModelsFetchResult> =>
      handleOllamaModelsFetch(payload),
  );

  log.info('ipc: handlers registered (v2)');
}

export function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(COMMENT_POST);
  ipcMain.removeHandler(SETTINGS_LOAD);
  ipcMain.removeHandler(SETTINGS_SAVE);
  ipcMain.removeHandler(GIT_CONNECTIONS_LOAD);
  ipcMain.removeHandler(GIT_CONNECTIONS_SAVE);
  ipcMain.removeHandler(GIT_CONNECTION_TEST);
  ipcMain.removeHandler(AI_CONFIG_LOAD);
  ipcMain.removeHandler(AI_CONFIG_SAVE);
  ipcMain.removeHandler(AI_AVAILABILITY_TEST);
  ipcMain.removeHandler(OLLAMA_MODELS_FETCH);
  ipcMain.removeAllListeners(REVIEW_START);
  ipcMain.removeAllListeners(REVIEW_ABORT);
  ipcMain.removeAllListeners(WINDOW_OPEN_MR);
  ipcMain.removeAllListeners(NOTIFICATION_TOGGLE);
  if (currentRun) {
    currentRun.abort();
    currentRun = null;
  }
}
