// main/ipc-actions.ts — MR 액션 IPC (파이프라인 실행 / AI 충돌 머지)
import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  MergeAIProgressPayload,
  MergeAIPushResult,
  MergeAIStartResult,
  PipelineRunResult,
  ReviewItemSummary,
  StoreSchema,
} from '../shared/types';
import {
  MERGE_AI_PROGRESS,
  MERGE_AI_PUSH,
  MERGE_AI_START,
  PIPELINE_RUN,
} from '../shared/constants';
import { createAIProvider } from './providers/ai/ai-provider';
import { createGitProvider } from './providers/git/git-provider';
import { pushAiMerge, startAiMerge } from './merge-resolver';

export interface ActionsDeps {
  store: Store<StoreSchema>;
  getReviewWindow: () => BrowserWindow | null;
}

function isItemSummary(v: unknown): v is ReviewItemSummary {
  if (!v || typeof v !== 'object') return false;
  const it = v as Partial<ReviewItemSummary>;
  return typeof it.gitConfigId === 'string'
    && typeof it.projectId === 'number'
    && typeof it.itemId === 'number';
}

async function handlePipelineRun(
  deps: ActionsDeps,
  item: ReviewItemSummary,
): Promise<PipelineRunResult> {
  const cfg = deps.store.get('settings').gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다' };
  const provider = createGitProvider(cfg);
  if (!provider.runPipeline) {
    return { success: false, error: 'GitLab 연결에서만 지원됩니다' };
  }
  return provider.runPipeline(item);
}

async function handleMergeAiStart(
  deps: ActionsDeps,
  item: ReviewItemSummary,
): Promise<MergeAIStartResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다' };
  if (cfg.type !== 'gitlab') {
    return { success: false, error: 'AI 머지는 현재 GitLab 연결에서만 지원됩니다' };
  }
  const provider = createGitProvider(cfg);
  if (!provider.fetchRepoCloneUrl) {
    return { success: false, error: '이 provider 는 clone URL 조회를 지원하지 않습니다' };
  }

  try {
    const rawUrl = await provider.fetchRepoCloneUrl(item);
    const u = new URL(rawUrl);
    u.username = 'oauth2';
    u.password = cfg.token;

    const ai = createAIProvider(settings.ai);
    const onProgress = (line: string): void => {
      const win = deps.getReviewWindow();
      if (!win || win.isDestroyed()) return;
      const payload: MergeAIProgressPayload = { line };
      win.webContents.send(MERGE_AI_PROGRESS, payload);
    };
    return await startAiMerge(item, u.toString(), cfg.token, ai, onProgress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ipc-actions: merge start failed: ${msg.slice(0, 200)}`);
    return { success: false, error: msg };
  }
}

export function registerActionHandlers(deps: ActionsDeps): void {
  ipcMain.handle(PIPELINE_RUN, (_e, item: unknown): Promise<PipelineRunResult> => {
    if (!isItemSummary(item)) {
      return Promise.resolve({ success: false, error: '잘못된 요청입니다' });
    }
    return handlePipelineRun(deps, item);
  });

  ipcMain.handle(MERGE_AI_START, (_e, item: unknown): Promise<MergeAIStartResult> => {
    if (!isItemSummary(item)) {
      return Promise.resolve({ success: false, error: '잘못된 요청입니다' });
    }
    return handleMergeAiStart(deps, item);
  });

  ipcMain.handle(MERGE_AI_PUSH, (): Promise<MergeAIPushResult> => pushAiMerge());
}

export function unregisterActionHandlers(): void {
  ipcMain.removeHandler(PIPELINE_RUN);
  ipcMain.removeHandler(MERGE_AI_START);
  ipcMain.removeHandler(MERGE_AI_PUSH);
}
