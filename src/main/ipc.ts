// main/ipc.ts — IPC 핸들러 등록 (v2 + v3 루트) — settings/AI/Git 은 ipc-settings 로 분리.
import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AIConfig,
  AppSettings,
  CommentPostPayload,
  CommentPostResult,
  CommentReplyPayload,
  CommentReplyResult,
  GitConfig,
  JiraConfig,
  ListLoadResult,
  ProjectFiltersLoadResult,
  ProjectFiltersSavePayload,
  ReviewItem,
  ReviewItemSummary,
  ReviewStartPayload,
  StoreSchema,
} from '../shared/types';
import {
  COMMENT_POST,
  COMMENT_REPLY,
  ITEM_NEW,
  LIST_LOAD,
  LIST_OPEN_REVIEW,
  LIST_REFRESH,
  PROJECT_FILTERS_LOAD,
  PROJECT_FILTERS_SAVE,
  TAB_DRAG_START,
  TAB_DRAG_END,
  TAB_DRAG_DROP,
  TAB_DRAG_DETACH,
  NOTIFICATION_TOGGLE,
  REVIEW_ABORT,
  REVIEW_CACHE_LOAD,
  REVIEW_CACHE_SAVE,
  REVIEW_START,
  WINDOW_OPEN_MR,
} from '../shared/constants';
import { registerJiraHandlers, unregisterJiraHandlers } from './ipc-jira';
import { registerBranchHandlers, unregisterBranchHandlers } from './ipc-branch';
import { registerSettingsHandlers, unregisterSettingsHandlers } from './ipc-settings';
import { createGitProvider } from './providers/git/git-provider';
import { runReviewStart } from './ipc-review';
import type { RunHandle } from './review-runner';

export interface IpcDeps {
  store: Store<StoreSchema>;
  getReviewWindow: () => BrowserWindow | null;
  openReviewWindow: (item: ReviewItem) => void;
  openDetachedWindow: (item: ReviewItem, spawnAt?: { x: number; y: number }) => void;
  /** GitConfig[] 변경 시 poller의 providers 재구성 트리거 */
  rebuildProviders: (configs: GitConfig[]) => void;
  /** AIConfig 변경 시 review-runner 재구성 트리거 */
  rebuildAIProvider: (config: AIConfig) => void;
  /** JiraConfig[] 변경 시 Jira 폴링/웹훅 재구성 (v3) */
  rebuildJira: (configs: JiraConfig[]) => void;
  /** 폴링 간격/알림 토글 등 기타 설정 적용 */
  onSettingsSaved: (settings: AppSettings) => void;
  onNotificationToggle: () => void;
  applyStartup: (enabled: boolean) => void;
  /** 사용자 인터랙션 기록 (리뷰 완료/댓글 등록 시 호출) */
  recordInteraction: (itemId: string, kind: 'opened' | 'reviewed' | 'commented') => void;
  /** 목록 윈도우 데이터 공급 */
  getListSnapshot: () => ListLoadResult;
  /** 목록 윈도우에서 특정 item id로 AI 리뷰 열기 요청 */
  openReviewById: (itemId: string) => void;
  /** 즉시 폴링 요청 */
  refreshPoller: () => void;
  /** 즉시 Jira 폴링 요청 */
  refreshJiraBridge: () => void;
}

let currentRun: RunHandle | null = null;

async function handleCommentPost(
  deps: IpcDeps,
  payload: CommentPostPayload,
): Promise<CommentPostResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) {
    return { success: false, error: '연결을 찾을 수 없습니다' };
  }
  const provider = createGitProvider(cfg);
  const compositeId = `${cfg.id}::${cfg.type}::${payload.projectId}::${payload.itemId}`;
  const stub: ReviewItemSummary = {
    id: compositeId,
    gitConfigId: cfg.id,
    providerType: cfg.type,
    providerLabel: cfg.type === 'gitlab' ? 'GL' : 'GH',
    itemId: payload.itemId,
    title: '',
    description: '',
    author: { id: 0, name: '', username: '', avatar_url: '' },
    reviewers: [],
    viewerIsReviewer: false,
    webUrl: '',
    sourceBranch: '',
    targetBranch: '',
    projectId: payload.projectId,
    repoFullName: payload.repoFullName,
    createdAt: '',
    updatedAt: '',
  };
  const result = await provider.postComment(stub, payload.body);
  if (result.success) {
    deps.recordInteraction(compositeId, 'commented');
  }
  return result;
}

async function handleCommentReply(
  deps: IpcDeps,
  payload: CommentReplyPayload,
): Promise<CommentReplyResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다' };
  const provider = createGitProvider(cfg);
  if (!provider.postReply) {
    return { success: false, error: '이 provider 는 답글을 지원하지 않습니다' };
  }
  const compositeId = `${cfg.id}::${cfg.type}::${payload.projectId}::${payload.itemId}`;
  const stub: ReviewItemSummary = {
    id: compositeId,
    gitConfigId: cfg.id,
    providerType: cfg.type,
    providerLabel: cfg.type === 'gitlab' ? 'GL' : 'GH',
    itemId: payload.itemId,
    title: '', description: '',
    author: { id: 0, name: '', username: '', avatar_url: '' },
    reviewers: [], viewerIsReviewer: false,
    webUrl: '', sourceBranch: '', targetBranch: '',
    projectId: payload.projectId,
    repoFullName: payload.repoFullName,
    createdAt: '', updatedAt: '',
  };
  const res = await provider.postReply(stub, payload);
  if (res.success) deps.recordInteraction(compositeId, 'commented');
  return res;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  ipcMain.on(REVIEW_START, (_e, payload: ReviewStartPayload) => {
    void (async (): Promise<void> => {
      const next = await runReviewStart(
        {
          store: deps.store,
          getReviewWindow: deps.getReviewWindow,
          recordInteraction: deps.recordInteraction,
        },
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

  // ── 목록 윈도우 IPC ──────────────────────────────────────
  ipcMain.handle(LIST_LOAD, (): ListLoadResult => deps.getListSnapshot());

  ipcMain.on(LIST_OPEN_REVIEW, (_e, itemId: string) => {
    if (typeof itemId !== 'string') return;
    deps.openReviewById(itemId);
  });

  ipcMain.on(LIST_REFRESH, (_e, kind: unknown) => {
    const k = kind === 'mr' || kind === 'jira' || kind === 'all' ? kind : 'all';
    if (k === 'mr' || k === 'all') deps.refreshPoller();
    if (k === 'jira' || k === 'all') deps.refreshJiraBridge();
  });

  // ── AI 리뷰 결과 캐시 ─────────────────────────────────────
  ipcMain.handle(
    REVIEW_CACHE_LOAD,
    (_e, itemId: unknown): { markdown: string; updatedAt: string } | null => {
      if (typeof itemId !== 'string') return null;
      const cache = deps.store.get('reviewCache') ?? {};
      return cache[itemId] ?? null;
    },
  );
  ipcMain.on(
    REVIEW_CACHE_SAVE,
    (_e, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return;
      const { itemId, markdown } = payload as { itemId?: unknown; markdown?: unknown };
      if (typeof itemId !== 'string' || typeof markdown !== 'string') return;
      const cache = deps.store.get('reviewCache') ?? {};
      // 최대 200KB 캡
      const trimmed = markdown.length > 200_000
        ? markdown.slice(markdown.length - 200_000)
        : markdown;
      cache[itemId] = { markdown: trimmed, updatedAt: new Date().toISOString() };
      // 항목 수 캡 200 — 오래된 것부터 제거
      const entries = Object.entries(cache);
      if (entries.length > 200) {
        entries.sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
        for (let i = 0; i < entries.length - 200; i += 1) delete cache[entries[i][0]];
      }
      deps.store.set('reviewCache', cache);
    },
  );

  // ── 탭 드래그: 릴리즈 시점에 드롭 위치 판단 ─────────────────
  ipcMain.on(TAB_DRAG_START, () => { /* drag 시작 알림 — 현재 main 쪽은 no-op */ });
  ipcMain.on(TAB_DRAG_END,   () => { /* 드래그 취소 (pointercancel) — no-op */ });

  ipcMain.on(TAB_DRAG_DROP, (e, payload: { tabId: string; item: ReviewItem }) => {
    const sourceWin = BrowserWindow.fromWebContents(e.sender);
    if (!sourceWin || sourceWin.isDestroyed()) return;
    const { tabId, item } = payload;

    const cur = screen.getCursorScreenPoint();
    const sb  = sourceWin.getBounds();
    const onSource = cur.x >= sb.x && cur.x <= sb.x + sb.width
                  && cur.y >= sb.y && cur.y <= sb.y + sb.height;
    if (onSource) return; // 같은 창 위에 드롭 → 취소

    // 다른 BrowserWindow 위에 드롭됐는지 확인
    const targetWin = BrowserWindow.getAllWindows().find((w) => {
      if (w === sourceWin || w.isDestroyed()) return false;
      const b = w.getBounds();
      return cur.x >= b.x && cur.x <= b.x + b.width
          && cur.y >= b.y && cur.y <= b.y + b.height;
    });

    if (targetWin) {
      // 기존 창으로 병합
      targetWin.webContents.send(ITEM_NEW, item);
      targetWin.show();
      targetWin.focus();
    } else {
      // 빈 공간에 드롭 → 커서 위치에 새 창 생성
      deps.openDetachedWindow(item, cur);
    }
    // 원본 창에서 탭 제거
    sourceWin.webContents.send(TAB_DRAG_DETACH, tabId);
  });

  ipcMain.handle(
    COMMENT_POST,
    (_e, payload: CommentPostPayload): Promise<CommentPostResult> =>
      handleCommentPost(deps, payload),
  );

  // ── v3: COMMENT_REPLY ─────────────────────────────────
  ipcMain.handle(
    COMMENT_REPLY,
    (_e, payload: CommentReplyPayload): Promise<CommentReplyResult> =>
      handleCommentReply(deps, payload),
  );

  // ── v3: PROJECT_FILTERS ───────────────────────────────
  ipcMain.handle(PROJECT_FILTERS_LOAD, (): ProjectFiltersLoadResult => {
    return { projectFilters: deps.store.get('settings').projectFilters ?? [] };
  });
  ipcMain.handle(
    PROJECT_FILTERS_SAVE,
    (_e, payload: ProjectFiltersSavePayload): void => {
      const cur = deps.store.get('settings');
      const next: AppSettings = { ...cur, projectFilters: payload.projectFilters };
      deps.store.set('settings', next);
      log.info(`ipc: projectFilters saved (count=${payload.projectFilters.length})`);
      deps.onSettingsSaved(next);
    },
  );

  // ── v3: Jira / Branch / Settings sub-handlers ─────────
  registerJiraHandlers({ store: deps.store, rebuildJira: deps.rebuildJira });
  registerBranchHandlers({ store: deps.store });
  registerSettingsHandlers({
    store: deps.store,
    rebuildProviders: deps.rebuildProviders,
    rebuildAIProvider: deps.rebuildAIProvider,
    onSettingsSaved: deps.onSettingsSaved,
    applyStartup: deps.applyStartup,
  });

  log.info('ipc: handlers registered (v2 + v3)');
}

export function unregisterIpcHandlers(): void {
  ipcMain.removeHandler(COMMENT_POST);
  ipcMain.removeAllListeners(REVIEW_START);
  ipcMain.removeHandler(REVIEW_CACHE_LOAD);
  ipcMain.removeAllListeners(REVIEW_CACHE_SAVE);
  ipcMain.removeAllListeners(REVIEW_ABORT);
  ipcMain.removeAllListeners(WINDOW_OPEN_MR);
  ipcMain.removeAllListeners(NOTIFICATION_TOGGLE);
  ipcMain.removeAllListeners(TAB_DRAG_START);
  ipcMain.removeAllListeners(TAB_DRAG_END);
  ipcMain.removeAllListeners(TAB_DRAG_DROP);
  ipcMain.removeAllListeners(LIST_OPEN_REVIEW);
  ipcMain.removeAllListeners(LIST_REFRESH);
  ipcMain.removeHandler(LIST_LOAD);
  ipcMain.removeHandler(COMMENT_REPLY);
  ipcMain.removeHandler(PROJECT_FILTERS_LOAD);
  ipcMain.removeHandler(PROJECT_FILTERS_SAVE);
  unregisterJiraHandlers();
  unregisterBranchHandlers();
  unregisterSettingsHandlers();
  if (currentRun) {
    currentRun.abort();
    currentRun = null;
  }
}
