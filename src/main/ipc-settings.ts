// main/ipc-settings.ts — settings / AI / Git 연결 / Ollama IPC 핸들러 (ipc.ts 분리, Phase 4 V1)
import { ipcMain } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AIAvailabilityTestPayload,
  AIAvailabilityTestResult,
  AIConfig,
  AIConfigLoadResult,
  AIConfigSavePayload,
  AppSettings,
  ConnectionTestResult,
  GitConfig,
  GitConnectionTestPayload,
  GitConnectionsLoadResult,
  GitConnectionsSavePayload,
  OllamaModelsFetchPayload,
  OllamaModelsFetchResult,
  SettingsLoadResult,
  SettingsSavePayload,
  StoreSchema,
} from '../shared/types';
import {
  AI_AVAILABILITY_TEST,
  AI_CONFIG_LOAD,
  AI_CONFIG_SAVE,
  GIT_CONNECTIONS_LOAD,
  GIT_CONNECTIONS_SAVE,
  GIT_CONNECTION_TEST,
  OLLAMA_MODELS_FETCH,
  SETTINGS_LOAD,
  SETTINGS_SAVE,
} from '../shared/constants';
import { createAIProvider } from './providers/ai/ai-provider';
import { fetchOllamaModels } from './providers/ai/ollama';
import { createGitProvider } from './providers/git/git-provider';

export interface SettingsIpcDeps {
  store: Store<StoreSchema>;
  rebuildProviders: (configs: GitConfig[]) => void;
  rebuildAIProvider: (config: AIConfig) => void;
  onSettingsSaved: (settings: AppSettings) => void;
  applyStartup: (enabled: boolean) => void;
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

export function registerSettingsHandlers(deps: SettingsIpcDeps): void {
  ipcMain.handle(SETTINGS_LOAD, (): SettingsLoadResult => {
    return { settings: deps.store.get('settings') };
  });

  ipcMain.handle(SETTINGS_SAVE, (_e, payload: SettingsSavePayload): void => {
    deps.store.set('settings', payload.settings);
    log.info('ipc-settings: settings saved (full)');
    deps.rebuildProviders(payload.settings.gitConnections);
    deps.rebuildAIProvider(payload.settings.ai);
    deps.applyStartup(payload.settings.launchOnStartup ?? false);
    deps.onSettingsSaved(payload.settings);
  });

  ipcMain.handle(GIT_CONNECTIONS_LOAD, (): GitConnectionsLoadResult => {
    return { gitConnections: deps.store.get('settings').gitConnections };
  });

  ipcMain.handle(
    GIT_CONNECTIONS_SAVE,
    (_e, payload: GitConnectionsSavePayload): void => {
      const current = deps.store.get('settings');
      const next: AppSettings = { ...current, gitConnections: payload.gitConnections };
      deps.store.set('settings', next);

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
        `ipc-settings: gitConnections saved (count=${payload.gitConnections.length}, recent=${prunedRecent.length}, seen=${prunedSeen.length})`,
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

  ipcMain.handle(AI_CONFIG_LOAD, (): AIConfigLoadResult => {
    return { ai: deps.store.get('settings').ai };
  });

  ipcMain.handle(AI_CONFIG_SAVE, (_e, payload: AIConfigSavePayload): void => {
    const current = deps.store.get('settings');
    const next: AppSettings = { ...current, ai: payload.ai };
    deps.store.set('settings', next);
    log.info(`ipc-settings: AI config saved (type=${payload.ai.type})`);
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
}

export function unregisterSettingsHandlers(): void {
  ipcMain.removeHandler(SETTINGS_LOAD);
  ipcMain.removeHandler(SETTINGS_SAVE);
  ipcMain.removeHandler(GIT_CONNECTIONS_LOAD);
  ipcMain.removeHandler(GIT_CONNECTIONS_SAVE);
  ipcMain.removeHandler(GIT_CONNECTION_TEST);
  ipcMain.removeHandler(AI_CONFIG_LOAD);
  ipcMain.removeHandler(AI_CONFIG_SAVE);
  ipcMain.removeHandler(AI_AVAILABILITY_TEST);
  ipcMain.removeHandler(OLLAMA_MODELS_FETCH);
}
