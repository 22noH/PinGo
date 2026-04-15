// main/ipc.ts — IPC 핸들러 전체
import { BrowserWindow, ipcMain, shell } from 'electron';
import axios from 'axios';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AppSettings,
  CommentPostPayload,
  CommentPostResult,
  ConnectionTestResult,
  ReviewChunkPayload,
  ReviewErrorPayload,
  ReviewStartPayload,
  SettingsLoadResult,
  SettingsSavePayload,
  StoreSchema,
} from '../shared/types';
import {
  COMMENT_POST,
  MR_NEW,
  NOTIFICATION_TOGGLE,
  REVIEW_ABORT,
  REVIEW_CHUNK,
  REVIEW_DONE,
  REVIEW_ERROR,
  REVIEW_START,
  SETTINGS_LOAD,
  SETTINGS_SAVE,
  SETTINGS_TEST,
  WINDOW_OPEN_MR,
} from '../shared/constants';
import { classifyError, fetchCurrentUser, fetchMrChanges } from './poller';
import { buildPrompt, RunHandle, runClaudeReview } from './review-runner';

export interface IpcDeps {
  store: Store<StoreSchema>;
  getReviewWindow: () => BrowserWindow | null;
  onSettingsSaved: (settings: AppSettings) => void;
  onNotificationToggle: () => void;
}

let currentRun: RunHandle | null = null;

function sendToReview(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed()) return;
  if (payload === undefined) {
    win.webContents.send(channel);
  } else {
    win.webContents.send(channel, payload);
  }
}

async function handleReviewStart(deps: IpcDeps, payload: ReviewStartPayload): Promise<void> {
  const { mr } = payload;
  const win = deps.getReviewWindow();
  const settings = deps.store.get('settings');

  if (currentRun) {
    log.warn('ipc: previous review still running, aborting it first');
    currentRun.abort();
    currentRun = null;
  }

  try {
    const full = await fetchMrChanges(
      settings.gitlabUrl,
      settings.token,
      mr.project_id,
      mr.iid,
    );
    // changes 포함 전체 MR을 renderer에 재전송 → Frontend가 파일 목록 업데이트
    sendToReview(win, MR_NEW, full);
    const prompt = buildPrompt(full);
    currentRun = runClaudeReview(
      prompt,
      (chunk: string): void => {
        const payloadChunk: ReviewChunkPayload = { chunk };
        sendToReview(win, REVIEW_CHUNK, payloadChunk);
      },
      (): void => {
        sendToReview(win, REVIEW_DONE);
        currentRun = null;
      },
      (err: Error): void => {
        const payloadErr: ReviewErrorPayload = { message: err.message };
        sendToReview(win, REVIEW_ERROR, payloadErr);
        currentRun = null;
      },
    );
  } catch (err) {
    const msg = classifyError(err).message;
    log.error(`ipc: review start failed: ${msg}`);
    const payloadErr: ReviewErrorPayload = { message: msg };
    sendToReview(win, REVIEW_ERROR, payloadErr);
  }
}

async function handleCommentPost(
  store: Store<StoreSchema>,
  payload: CommentPostPayload,
): Promise<CommentPostResult> {
  const settings = store.get('settings');
  if (!settings.token || !settings.gitlabUrl) {
    return { success: false, error: '설정이 완료되지 않았습니다.' };
  }
  const url = `${settings.gitlabUrl.replace(/\/$/, '')}/api/v4/projects/${payload.projectId}/merge_requests/${payload.iid}/discussions`;
  try {
    const res = await axios.post<{ id: string }>(
      url,
      { body: payload.body },
      { headers: { 'PRIVATE-TOKEN': settings.token }, timeout: 15_000 },
    );
    log.info(`ipc: comment posted mr=#${payload.iid} discussion=${res.data.id}`);
    return { success: true, discussionId: res.data.id };
  } catch (err) {
    const msg = classifyError(err).message;
    log.error(`ipc: comment post failed: ${msg}`);
    return { success: false, error: msg };
  }
}

async function handleSettingsTest(store: Store<StoreSchema>): Promise<ConnectionTestResult> {
  const s = store.get('settings');
  if (!s.gitlabUrl || !s.token) {
    return { success: false, error: 'gitlabUrl/token이 비어 있습니다' };
  }
  try {
    const user = await fetchCurrentUser(s.gitlabUrl, s.token);
    log.info(`ipc: connection test ok user=${user.username}(${user.id})`);
    return { success: true, userId: user.id };
  } catch (err) {
    const msg = classifyError(err).message;
    log.warn(`ipc: connection test failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.on(REVIEW_START, (_e, payload: ReviewStartPayload) => {
    void handleReviewStart(deps, payload);
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

  ipcMain.handle(SETTINGS_LOAD, (): SettingsLoadResult => {
    return { settings: deps.store.get('settings') };
  });

  ipcMain.handle(SETTINGS_SAVE, (_e, payload: SettingsSavePayload): void => {
    deps.store.set('settings', payload.settings);
    log.info('ipc: settings saved');
    deps.onSettingsSaved(payload.settings);
  });

  ipcMain.handle(SETTINGS_TEST, (): Promise<ConnectionTestResult> =>
    handleSettingsTest(deps.store),
  );

  log.info('ipc: handlers registered');
}

export function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(COMMENT_POST);
  ipcMain.removeHandler(SETTINGS_LOAD);
  ipcMain.removeHandler(SETTINGS_SAVE);
  ipcMain.removeHandler(SETTINGS_TEST);
  ipcMain.removeAllListeners(REVIEW_START);
  ipcMain.removeAllListeners(REVIEW_ABORT);
  ipcMain.removeAllListeners(WINDOW_OPEN_MR);
  ipcMain.removeAllListeners(NOTIFICATION_TOGGLE);
  if (currentRun) {
    currentRun.abort();
    currentRun = null;
  }
}
