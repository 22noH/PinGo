// preload.ts — contextBridge 기반 보안 IPC 게이트웨이
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  ReviewStartPayload,
  CommentPostPayload,
  CommentPostResult,
  SettingsSavePayload,
  SettingsLoadResult,
  ReviewChunkPayload,
  ReviewErrorPayload,
  MergeRequest,
  TrayStateChangedPayload,
  ConnectionTestResult,
} from './shared/types';
import {
  REVIEW_START,
  REVIEW_ABORT,
  REVIEW_CHUNK,
  REVIEW_DONE,
  REVIEW_ERROR,
  COMMENT_POST,
  SETTINGS_SAVE,
  SETTINGS_LOAD,
  SETTINGS_TEST,
  WINDOW_OPEN_MR,
  NOTIFICATION_TOGGLE,
  MR_NEW,
  TRAY_STATE_CHANGED,
} from './shared/constants';

export interface ElectronAPI {
  // ── Renderer → Main (fire-and-forget) ─────────────────────
  startReview: (payload: ReviewStartPayload) => void;
  abortReview: () => void;
  openMrInBrowser: (webUrl: string) => void;
  toggleNotification: () => void;

  // ── Renderer → Main (invoke, 응답 대기) ───────────────────
  postComment: (payload: CommentPostPayload) => Promise<CommentPostResult>;
  saveSettings: (payload: SettingsSavePayload) => Promise<void>;
  loadSettings: () => Promise<SettingsLoadResult>;
  /** GitLab GET /api/v4/user 호출하여 토큰/URL 유효성 확인 */
  testConnection: () => Promise<ConnectionTestResult>;

  // ── Main → Renderer (이벤트 구독, 언서브스크라이브 함수 반환) ─
  onReviewChunk: (cb: (payload: ReviewChunkPayload) => void) => () => void;
  onReviewDone: (cb: () => void) => () => void;
  onReviewError: (cb: (payload: ReviewErrorPayload) => void) => () => void;
  /**
   * MR_NEW는 두 번 수신될 수 있음:
   *  1) 리뷰 윈도우 오픈 시 — MergeRequestSummary (changes 없음, 헤더 초기화용)
   *  2) REVIEW_START 처리 중 fetchMrChanges 완료 후 — MergeRequestWithChanges (파일 목록 갱신용)
   * renderer는 `'changes' in mr`로 분기하여 처리.
   */
  onMrNew: (cb: (mr: MergeRequest) => void) => () => void;
  onTrayStateChanged: (cb: (payload: TrayStateChangedPayload) => void) => () => void;
}

const api: ElectronAPI = {
  startReview: (payload: ReviewStartPayload): void => {
    ipcRenderer.send(REVIEW_START, payload);
  },
  abortReview: (): void => {
    ipcRenderer.send(REVIEW_ABORT);
  },
  openMrInBrowser: (webUrl: string): void => {
    ipcRenderer.send(WINDOW_OPEN_MR, webUrl);
  },
  toggleNotification: (): void => {
    ipcRenderer.send(NOTIFICATION_TOGGLE);
  },

  postComment: (payload: CommentPostPayload): Promise<CommentPostResult> =>
    ipcRenderer.invoke(COMMENT_POST, payload) as Promise<CommentPostResult>,

  saveSettings: (payload: SettingsSavePayload): Promise<void> =>
    ipcRenderer.invoke(SETTINGS_SAVE, payload) as Promise<void>,

  loadSettings: (): Promise<SettingsLoadResult> =>
    ipcRenderer.invoke(SETTINGS_LOAD) as Promise<SettingsLoadResult>,

  testConnection: (): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke(SETTINGS_TEST) as Promise<ConnectionTestResult>,

  onReviewChunk: (cb: (payload: ReviewChunkPayload) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: ReviewChunkPayload): void => cb(payload);
    ipcRenderer.on(REVIEW_CHUNK, handler);
    return (): void => {
      ipcRenderer.removeListener(REVIEW_CHUNK, handler);
    };
  },

  onReviewDone: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(REVIEW_DONE, handler);
    return (): void => {
      ipcRenderer.removeListener(REVIEW_DONE, handler);
    };
  },

  onReviewError: (cb: (payload: ReviewErrorPayload) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: ReviewErrorPayload): void => cb(payload);
    ipcRenderer.on(REVIEW_ERROR, handler);
    return (): void => {
      ipcRenderer.removeListener(REVIEW_ERROR, handler);
    };
  },

  onMrNew: (cb: (mr: MergeRequest) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, mr: MergeRequest): void => cb(mr);
    ipcRenderer.on(MR_NEW, handler);
    return (): void => {
      ipcRenderer.removeListener(MR_NEW, handler);
    };
  },

  onTrayStateChanged: (cb: (payload: TrayStateChangedPayload) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: TrayStateChangedPayload): void => cb(payload);
    ipcRenderer.on(TRAY_STATE_CHANGED, handler);
    return (): void => {
      ipcRenderer.removeListener(TRAY_STATE_CHANGED, handler);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
