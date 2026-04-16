// preload.ts — contextBridge 기반 보안 IPC 게이트웨이 (v2)
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  ReviewStartPayload,
  CommentPostPayload,
  CommentPostResult,
  SettingsSavePayload,
  SettingsLoadResult,
  ReviewChunkPayload,
  ReviewErrorPayload,
  ReviewItem,
  TrayStateChangedPayload,
  GitConnectionsLoadResult,
  GitConnectionsSavePayload,
  GitConnectionTestPayload,
  ConnectionTestResult,
  AIConfigLoadResult,
  AIConfigSavePayload,
  AIAvailabilityTestPayload,
  AIAvailabilityTestResult,
  OllamaModelsFetchPayload,
  OllamaModelsFetchResult,
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
  WINDOW_OPEN_MR,
  NOTIFICATION_TOGGLE,
  ITEM_NEW,
  TRAY_STATE_CHANGED,
  GIT_CONNECTIONS_LOAD,
  GIT_CONNECTIONS_SAVE,
  GIT_CONNECTION_TEST,
  AI_CONFIG_LOAD,
  AI_CONFIG_SAVE,
  AI_AVAILABILITY_TEST,
  OLLAMA_MODELS_FETCH,
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

  // v2 신규 — Git 연결 관리
  loadGitConnections: () => Promise<GitConnectionsLoadResult>;
  saveGitConnections: (payload: GitConnectionsSavePayload) => Promise<void>;
  testGitConnection: (
    payload: GitConnectionTestPayload,
  ) => Promise<ConnectionTestResult>;

  // v2 신규 — AI 설정 관리
  loadAIConfig: () => Promise<AIConfigLoadResult>;
  saveAIConfig: (payload: AIConfigSavePayload) => Promise<void>;
  testAIAvailability: (
    payload: AIAvailabilityTestPayload,
  ) => Promise<AIAvailabilityTestResult>;
  fetchOllamaModels: (
    payload: OllamaModelsFetchPayload,
  ) => Promise<OllamaModelsFetchResult>;

  // ── Main → Renderer (이벤트 구독, 언서브스크라이브 함수 반환) ─
  onReviewChunk: (cb: (payload: ReviewChunkPayload) => void) => () => void;
  onReviewDone: (cb: () => void) => () => void;
  onReviewError: (cb: (payload: ReviewErrorPayload) => void) => () => void;
  /**
   * ITEM_NEW는 두 번 수신될 수 있음:
   *  1) 리뷰 윈도우 오픈 시 — ReviewItemSummary (changes 없음, 헤더 초기화용)
   *  2) REVIEW_START 처리 중 fetchChanges 완료 후 — ReviewItemWithChanges (파일 목록 갱신용)
   * renderer는 `'changes' in item`로 분기하여 처리.
   */
  onItemNew: (cb: (item: ReviewItem) => void) => () => void;
  /** @deprecated onItemNew 사용 — ITEM_NEW와 동일 채널 구독 (v1 alias 유지) */
  onMrNew: (cb: (item: ReviewItem) => void) => () => void;
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

  loadGitConnections: (): Promise<GitConnectionsLoadResult> =>
    ipcRenderer.invoke(GIT_CONNECTIONS_LOAD) as Promise<GitConnectionsLoadResult>,

  saveGitConnections: (payload: GitConnectionsSavePayload): Promise<void> =>
    ipcRenderer.invoke(GIT_CONNECTIONS_SAVE, payload) as Promise<void>,

  testGitConnection: (
    payload: GitConnectionTestPayload,
  ): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke(GIT_CONNECTION_TEST, payload) as Promise<ConnectionTestResult>,

  loadAIConfig: (): Promise<AIConfigLoadResult> =>
    ipcRenderer.invoke(AI_CONFIG_LOAD) as Promise<AIConfigLoadResult>,

  saveAIConfig: (payload: AIConfigSavePayload): Promise<void> =>
    ipcRenderer.invoke(AI_CONFIG_SAVE, payload) as Promise<void>,

  testAIAvailability: (
    payload: AIAvailabilityTestPayload,
  ): Promise<AIAvailabilityTestResult> =>
    ipcRenderer.invoke(AI_AVAILABILITY_TEST, payload) as Promise<AIAvailabilityTestResult>,

  fetchOllamaModels: (
    payload: OllamaModelsFetchPayload,
  ): Promise<OllamaModelsFetchResult> =>
    ipcRenderer.invoke(OLLAMA_MODELS_FETCH, payload) as Promise<OllamaModelsFetchResult>,

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

  onItemNew: (cb: (item: ReviewItem) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, item: ReviewItem): void => cb(item);
    ipcRenderer.on(ITEM_NEW, handler);
    return (): void => {
      ipcRenderer.removeListener(ITEM_NEW, handler);
    };
  },

  // v1 alias — ITEM_NEW와 동일 채널 구독 (기존 renderer 코드 호환용)
  onMrNew: (cb: (item: ReviewItem) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, item: ReviewItem): void => cb(item);
    ipcRenderer.on(ITEM_NEW, handler);
    return (): void => {
      ipcRenderer.removeListener(ITEM_NEW, handler);
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
