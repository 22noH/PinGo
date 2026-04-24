// preload.ts — contextBridge 기반 보안 IPC 게이트웨이 (v2 + v3)
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  ReviewStartPayload,
  CommentPostPayload,
  CommentPostResult,
  CommentReplyPayload,
  CommentReplyResult,
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
  ListLoadResult,
  JiraConnectionsLoadResult,
  JiraConnectionsSavePayload,
  JiraConnectionTestPayload,
  JiraConnectionTestResult,
  JiraIssueSummary,
  JiraListLoadResult,
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  ProjectListPayload,
  ProjectListResult,
  ProjectFiltersLoadResult,
  ProjectFiltersSavePayload,
} from './shared/types';
import {
  REVIEW_START,
  REVIEW_ABORT,
  REVIEW_CHUNK,
  REVIEW_DONE,
  REVIEW_ERROR,
  COMMENT_POST,
  COMMENT_REPLY,
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
  TAB_DRAG_START,
  TAB_DRAG_END,
  TAB_DRAG_DROP,
  TAB_DRAG_DETACH,
  LIST_LOAD,
  LIST_OPEN_REVIEW,
  LIST_UPDATED,
  LIST_REFRESH,
  JIRA_CONNECTIONS_LOAD,
  JIRA_CONNECTIONS_SAVE,
  JIRA_CONNECTION_TEST,
  JIRA_WEBHOOK_SECRET_GET,
  JIRA_WEBHOOK_SECRET_REGENERATE,
  JIRA_ISSUE_NEW,
  LIST_JIRA_UPDATED,
  BRANCH_CREATE,
  BRANCH_LIST,
  PROJECT_LIST,
  REVIEW_CACHE_LOAD,
  REVIEW_CACHE_SAVE,
  PROJECT_FILTERS_LOAD,
  PROJECT_FILTERS_SAVE,
} from './shared/constants';

export interface ElectronAPI {
  // ── Renderer → Main (fire-and-forget) ─────────────────────
  startReview: (payload: ReviewStartPayload) => void;
  abortReview: () => void;
  openMrInBrowser: (webUrl: string) => void;
  toggleNotification: () => void;
  tabDragStart: (tabId: string, item: ReviewItem) => void;
  tabDragEnd: () => void;
  tabDragDrop: (tabId: string, item: ReviewItem) => void;

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
  /** Main → Renderer: 커서가 창 밖으로 나감 → 탭 분리 */
  onTabDragDetach: (cb: (tabId: string) => void) => () => void;

  // 목록 윈도우 API
  loadList: () => Promise<ListLoadResult>;
  openReviewForItem: (itemId: string) => void;
  refreshList: (kind?: 'mr' | 'jira' | 'all') => void;
  onListUpdated: (cb: (payload: ListLoadResult) => void) => () => void;

  // AI 리뷰 결과 캐시
  loadReviewCache: (itemId: string) => Promise<{ markdown: string; updatedAt: string } | null>;
  saveReviewCache: (itemId: string, markdown: string) => void;

  // ── v3 신규 — Jira ─────────────────────────────────────
  loadJiraConnections: () => Promise<JiraConnectionsLoadResult>;
  saveJiraConnections: (payload: JiraConnectionsSavePayload) => Promise<void>;
  testJiraConnection: (payload: JiraConnectionTestPayload) => Promise<JiraConnectionTestResult>;
  /** Main → Renderer: 새 Jira 이슈 감지 */
  onJiraIssueNew: (cb: (issue: JiraIssueSummary) => void) => () => void;
  /** Main → Renderer: 리스트 윈도우 Jira 섹션 업데이트 */
  onListJiraUpdated: (cb: (payload: JiraListLoadResult) => void) => () => void;

  // ── v3 신규 — 브랜치 ────────────────────────────────────
  createBranch: (payload: BranchCreatePayload) => Promise<BranchCreateResult>;
  listBranches: (payload: BranchListPayload) => Promise<BranchListResult>;
  listProjects: (payload: ProjectListPayload) => Promise<ProjectListResult>;

  // ── v3 신규 — 댓글 답글 ────────────────────────────────
  postCommentReply: (payload: CommentReplyPayload) => Promise<CommentReplyResult>;

  // ── v3 신규 — 프로젝트 필터 ────────────────────────────
  loadProjectFilters: () => Promise<ProjectFiltersLoadResult>;
  saveProjectFilters: (payload: ProjectFiltersSavePayload) => Promise<void>;

  // ── v3 신규 — Jira 웹훅 토큰 ────────────────────────────
  getJiraWebhookSecret: () => Promise<string>;
  regenerateJiraWebhookSecret: () => Promise<string>;
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
  tabDragStart: (tabId: string, item: ReviewItem): void => {
    ipcRenderer.send(TAB_DRAG_START, { tabId, item });
  },
  tabDragEnd: (): void => {
    ipcRenderer.send(TAB_DRAG_END);
  },
  tabDragDrop: (tabId: string, item: ReviewItem): void => {
    ipcRenderer.send(TAB_DRAG_DROP, { tabId, item });
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
    return (): void => { ipcRenderer.removeListener(TRAY_STATE_CHANGED, handler); };
  },

  onTabDragDetach: (cb: (tabId: string) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, tabId: string): void => cb(tabId);
    ipcRenderer.on(TAB_DRAG_DETACH, handler);
    return (): void => { ipcRenderer.removeListener(TAB_DRAG_DETACH, handler); };
  },

  loadList: (): Promise<ListLoadResult> =>
    ipcRenderer.invoke(LIST_LOAD) as Promise<ListLoadResult>,
  openReviewForItem: (itemId: string): void => {
    ipcRenderer.send(LIST_OPEN_REVIEW, itemId);
  },
  refreshList: (kind?: 'mr' | 'jira' | 'all'): void => {
    ipcRenderer.send(LIST_REFRESH, kind ?? 'all');
  },
  onListUpdated: (cb: (payload: ListLoadResult) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: ListLoadResult): void => cb(payload);
    ipcRenderer.on(LIST_UPDATED, handler);
    return (): void => { ipcRenderer.removeListener(LIST_UPDATED, handler); };
  },

  // ── v3 — Jira ─────────────────────────────────────────
  loadJiraConnections: (): Promise<JiraConnectionsLoadResult> =>
    ipcRenderer.invoke(JIRA_CONNECTIONS_LOAD) as Promise<JiraConnectionsLoadResult>,
  saveJiraConnections: (payload: JiraConnectionsSavePayload): Promise<void> =>
    ipcRenderer.invoke(JIRA_CONNECTIONS_SAVE, payload) as Promise<void>,
  testJiraConnection: (payload: JiraConnectionTestPayload): Promise<JiraConnectionTestResult> =>
    ipcRenderer.invoke(JIRA_CONNECTION_TEST, payload) as Promise<JiraConnectionTestResult>,
  onJiraIssueNew: (cb: (issue: JiraIssueSummary) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, issue: JiraIssueSummary): void => cb(issue);
    ipcRenderer.on(JIRA_ISSUE_NEW, handler);
    return (): void => { ipcRenderer.removeListener(JIRA_ISSUE_NEW, handler); };
  },
  onListJiraUpdated: (cb: (payload: JiraListLoadResult) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, payload: JiraListLoadResult): void => cb(payload);
    ipcRenderer.on(LIST_JIRA_UPDATED, handler);
    return (): void => { ipcRenderer.removeListener(LIST_JIRA_UPDATED, handler); };
  },

  // ── v3 — 브랜치 ───────────────────────────────────────
  createBranch: (payload: BranchCreatePayload): Promise<BranchCreateResult> =>
    ipcRenderer.invoke(BRANCH_CREATE, payload) as Promise<BranchCreateResult>,
  listBranches: (payload: BranchListPayload): Promise<BranchListResult> =>
    ipcRenderer.invoke(BRANCH_LIST, payload) as Promise<BranchListResult>,
  listProjects: (payload: ProjectListPayload): Promise<ProjectListResult> =>
    ipcRenderer.invoke(PROJECT_LIST, payload) as Promise<ProjectListResult>,

  // AI 리뷰 결과 캐시
  loadReviewCache: (itemId: string): Promise<{ markdown: string; updatedAt: string } | null> =>
    ipcRenderer.invoke(REVIEW_CACHE_LOAD, itemId) as Promise<{ markdown: string; updatedAt: string } | null>,
  saveReviewCache: (itemId: string, markdown: string): void => {
    ipcRenderer.send(REVIEW_CACHE_SAVE, { itemId, markdown });
  },

  // ── v3 — 댓글 답글 ────────────────────────────────────
  postCommentReply: (payload: CommentReplyPayload): Promise<CommentReplyResult> =>
    ipcRenderer.invoke(COMMENT_REPLY, payload) as Promise<CommentReplyResult>,

  // ── v3 — 프로젝트 필터 ────────────────────────────────
  loadProjectFilters: (): Promise<ProjectFiltersLoadResult> =>
    ipcRenderer.invoke(PROJECT_FILTERS_LOAD) as Promise<ProjectFiltersLoadResult>,
  saveProjectFilters: (payload: ProjectFiltersSavePayload): Promise<void> =>
    ipcRenderer.invoke(PROJECT_FILTERS_SAVE, payload) as Promise<void>,

  // ── v3 — Jira 웹훅 토큰 ──────────────────────────────
  getJiraWebhookSecret: (): Promise<string> =>
    ipcRenderer.invoke(JIRA_WEBHOOK_SECRET_GET) as Promise<string>,
  regenerateJiraWebhookSecret: (): Promise<string> =>
    ipcRenderer.invoke(JIRA_WEBHOOK_SECRET_REGENERATE) as Promise<string>,
};

contextBridge.exposeInMainWorld('electronAPI', api);
