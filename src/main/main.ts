// main/main.ts — Electron 앱 엔트리포인트 (v2)
import { app, BrowserWindow, globalShortcut, Menu, shell } from 'electron';
import * as path from 'path';
import log, { LogMessage } from 'electron-log';
import type {
  AppSettings,
  ConnectionHealth,
  ItemEvent,
  ItemInteraction,
  ReviewItemSummary,
  ReviewItemWithChanges,
  TrayState,
} from '../shared/types';
// TEST: 목업 테스트 시 아래 import 주석 해제
// import { createMockTestItem, createMockTestItem2 } from './mock-test-item';
import {
  DEFAULT_DASHBOARD_HOTKEY,
  ITEM_NEW,
  LIST_UPDATED,
  MAX_RECENT_ITEMS,
  MAX_SEEN_ITEM_IDS,
  TRAY_STATE_CHANGED,
} from '../shared/constants';
import { createStore } from './store';
import { createTray, TrayController } from './tray';
import { createPoller, PollerController, PollerSeenState } from './poller';
import { detectV3ItemEvents } from './poller-events';
import { createJiraBridge, JiraBridgeController } from './main-jira-bridge';
import { sendMrNotification } from './notifier';
import type { JiraEvent, JiraIssueSummary } from '../shared/types';
import { JIRA_ISSUE_NEW, LIST_JIRA_UPDATED } from '../shared/constants';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc';
import { createGitProvider, GitProvider } from './providers/git/git-provider';
import { createAppWindow, WindowDirs } from './windows';
import { silentPreSeed } from './preseed';
import { initAutoUpdater, installUpdateNow } from './updater';
// ── 중복 실행 방지 ──────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
log.transports.file.level = 'info';
// electron-log hook: 토큰/인증 헤더 패턴 로그에서 마스킹
const TOKEN_PATTERN = /glpat-[A-Za-z0-9_-]{20,}/g;
const GITHUB_PATTERN = /gh[ps]_[A-Za-z0-9]{30,}/g;
const HEADER_PATTERN = /(PRIVATE-TOKEN|Authorization|x-api-key):\s*\S+/gi;
log.hooks.push((message: LogMessage): LogMessage => {
  message.data = message.data.map((item: unknown): unknown => {
    if (typeof item === 'string') {
      return item
        .replace(HEADER_PATTERN, '$1: [REDACTED]')
        .replace(TOKEN_PATTERN, 'glpat-[REDACTED]')
        .replace(GITHUB_PATTERN, 'gh?_[REDACTED]');
    }
    return item;
  });
  return message;
});

log.info(`pingo: app starting (electron ${process.versions.electron})`);

const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', '..', 'assets');

const WIN_DIRS: WindowDirs = {
  preloadPath: path.join(__dirname, '..', 'preload.js'),
  rendererDir: app.isPackaged
    ? path.join(process.resourcesPath, 'dist', 'renderer')
    : path.join(__dirname, '..', 'renderer'),
  assetsDir: ASSETS_DIR,
};

let tray: TrayController | null = null;
let poller: PollerController | null = null;
let jiraBridge: JiraBridgeController | null = null;
let reviewWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let listWindow: BrowserWindow | null = null;
let lastCheckedAt: Date | null = null;
let lastHealth: ConnectionHealth[] = [];
let lastOpenItems: ReviewItemSummary[] = [];

function buildProviders(settings: AppSettings): GitProvider[] {
  return settings.gitConnections
    .map((cfg): GitProvider | null => {
      try {
        return createGitProvider(cfg);
      } catch (err) {
        log.error(`main: failed to build provider ${cfg.type}::${cfg.id}: ${String(err)}`);
        return null;
      }
    })
    .filter((p): p is GitProvider => p !== null);
}

function broadcastTrayState(state: TrayState): void {
  const payload = {
    state,
    lastCheckedAt: (lastCheckedAt ?? new Date()).toISOString(),
    connections: lastHealth,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(TRAY_STATE_CHANGED, payload);
  }
}

function setTrayState(next: TrayState): void {
  tray?.setState(next);
  broadcastTrayState(next);
}

function sendItemToWin(win: BrowserWindow, item: ReviewItemSummary | ReviewItemWithChanges): void {
  const send = (): void => { if (!win.isDestroyed()) win.webContents.send(ITEM_NEW, item); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function openReviewWindow(item?: ReviewItemSummary | ReviewItemWithChanges): void {
  if (!reviewWindow || reviewWindow.isDestroyed()) {
    reviewWindow = createAppWindow(WIN_DIRS, 'review/index.html', 'Pingo — AI Review', 1000, 760, true);
    reviewWindow.on('closed', () => { reviewWindow = null; });
  } else {
    reviewWindow.show(); reviewWindow.focus();
  }
  if (item) sendItemToWin(reviewWindow, item);
}

function openDetachedWindow(item: ReviewItemSummary | ReviewItemWithChanges, spawnAt?: { x: number; y: number }): void {
  const win = createAppWindow(WIN_DIRS, 'review/index.html', 'Pingo — AI Review', 1000, 760, true, true, spawnAt);
  win.on('closed', () => { if (reviewWindow === win) reviewWindow = null; });
  if (!reviewWindow || reviewWindow.isDestroyed()) reviewWindow = win;
  sendItemToWin(win, item);
}

function openSettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createAppWindow(WIN_DIRS, 'settings/index.html', 'Pingo — Settings', 640, 640, true, false);
    settingsWindow.on('closed', () => { settingsWindow = null; });
  } else {
    settingsWindow.show();
    settingsWindow.focus();
  }
}

let currentDashboardHotkey: string | null = null;

function applyDashboardHotkey(accel: string | undefined): void {
  const next = (accel ?? '').trim();
  if (currentDashboardHotkey && currentDashboardHotkey !== next) {
    try { globalShortcut.unregister(currentDashboardHotkey); } catch { /* noop */ }
    currentDashboardHotkey = null;
  }
  if (!next) return;
  if (currentDashboardHotkey === next) return;
  try {
    const ok = globalShortcut.register(next, (): void => { openListWindow(); });
    if (!ok) {
      log.warn(`main: globalShortcut register failed (hotkey=${next}) — 이미 다른 앱이 점유 중일 수 있음`);
      return;
    }
    currentDashboardHotkey = next;
    log.info(`main: dashboard hotkey registered (${next})`);
  } catch (err) {
    log.warn(`main: globalShortcut register error (${next}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function openListWindow(): void {
  if (!listWindow || listWindow.isDestroyed()) {
    listWindow = createAppWindow(WIN_DIRS, 'list/index.html', 'Pingo — 대시보드', 900, 680, true);
    listWindow.on('closed', () => { listWindow = null; });
    // createAppWindow 가 ready-to-show 로 show() 까지는 걸어두지만, 트레이 클릭에서
    // 호출되면 포커스가 바로 오지 않아 "첫 클릭에선 안 뜸" 처럼 보이는 문제가 있었음.
    // → ready-to-show 시 show + focus + moveTop 한 번 더 보장.
    listWindow.once('ready-to-show', () => {
      if (!listWindow || listWindow.isDestroyed()) return;
      listWindow.show();
      listWindow.focus();
      listWindow.moveTop();
    });
  } else {
    if (listWindow.isMinimized()) listWindow.restore();
    listWindow.show();
    listWindow.focus();
    listWindow.moveTop();
  }
  // 열리자마자 최신 데이터 반영되도록 poller/bridge 에 refresh 요청.
  poller?.refresh();
  jiraBridge?.refresh();
}

function broadcastListUpdate(store: ReturnType<typeof createStore>): void {
  if (!listWindow || listWindow.isDestroyed()) return;
  const payload = {
    items: lastOpenItems,
    interactions: store.get('interactions') ?? {},
  };
  if (!listWindow.webContents.isLoading()) {
    listWindow.webContents.send(LIST_UPDATED, payload);
  } else {
    listWindow.webContents.once('did-finish-load', () => {
      if (listWindow && !listWindow.isDestroyed()) {
        listWindow.webContents.send(LIST_UPDATED, payload);
      }
    });
  }
}

function persistSeenState(
  store: ReturnType<typeof createStore>,
  seen: PollerSeenState,
): void {
  store.set('seenItemIds', Array.from(seen.items).slice(-MAX_SEEN_ITEM_IDS));
  store.set('seenReviewerItemIds', Array.from(seen.reviewerAssigned).slice(-MAX_SEEN_ITEM_IDS));
  store.set('lastSeenNoteAt', Object.fromEntries(seen.lastSeenNoteAt));
}

function updateRecentFromOpenItems(
  store: ReturnType<typeof createStore>,
  openItems: ReviewItemSummary[],
): void {
  // 안 본 MR 우선 → 그 다음 updatedAt desc. 새 MR이 캡에서 밀려나지 않도록.
  const interactions = store.get('interactions') ?? {};
  const isUnseen = (it: ReviewItemSummary): boolean => !interactions[it.id]?.openedAt;
  const sorted = [...openItems].sort((a, b) => {
    const aUnseen = isUnseen(a);
    const bUnseen = isUnseen(b);
    if (aUnseen !== bUnseen) return aUnseen ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
  const recent = sorted.slice(0, MAX_RECENT_ITEMS);
  store.set('recentItems', recent);
  tray?.updateRecentItems(recent);
  // 전체 open list 도 따로 보관 — 목록 윈도우에서 사용
  lastOpenItems = sorted;
  broadcastListUpdate(store);
  // MR/PR 이 merged/closed 되어 open 목록에서 사라지면 해당 리뷰 캐시/인터랙션도 정리.
  // 안전장치: openItems 가 비어 있으면(폴링 실패/미설정) 실행 안 함.
  if (openItems.length > 0) pruneStaleData(store, openItems);
}

function pruneStaleData(
  store: ReturnType<typeof createStore>,
  openItems: ReviewItemSummary[],
): void {
  const openIds = new Set(openItems.map((it) => it.id));
  // 리뷰 캐시 정리
  const cache = store.get('reviewCache') ?? {};
  let cacheChanged = false;
  for (const id of Object.keys(cache)) {
    if (!openIds.has(id)) {
      delete cache[id];
      cacheChanged = true;
    }
  }
  if (cacheChanged) store.set('reviewCache', cache);
  // 인터랙션 기록(읽음/리뷰/댓글) 도 함께 정리 — UI 뱃지 stale 방지.
  const interactions = store.get('interactions') ?? {};
  let ixChanged = false;
  for (const id of Object.keys(interactions)) {
    if (!openIds.has(id)) {
      delete interactions[id];
      ixChanged = true;
    }
  }
  if (ixChanged) store.set('interactions', interactions);
  if (cacheChanged || ixChanged) {
    log.info(`main: pruned stale data — cache=${cacheChanged} interactions=${ixChanged}`);
  }
}

type InteractionKind = 'opened' | 'reviewed' | 'commented';

function recordInteraction(
  store: ReturnType<typeof createStore>,
  itemId: string,
  kind: InteractionKind,
): void {
  const now = new Date().toISOString();
  const all = { ...store.get('interactions') };
  const cur: ItemInteraction = all[itemId] ?? {};
  const next: ItemInteraction =
    kind === 'opened'    ? { ...cur, openedAt: now } :
    kind === 'reviewed'  ? { ...cur, openedAt: cur.openedAt ?? now, reviewedAt: now } :
                           { ...cur, openedAt: cur.openedAt ?? now, commentedAt: now };
  all[itemId] = next;
  store.set('interactions', all);
  tray?.updateInteractions(all);
  broadcastListUpdate(store);
}

function handleEvents(
  store: ReturnType<typeof createStore>,
  seen: PollerSeenState,
  events: ItemEvent[],
): void {
  // seen.items 갱신 (이번 tick에 본 것들)
  for (const ev of events) {
    seen.items.add(ev.item.id);
  }

  persistSeenState(store, seen);

  const settings = store.get('settings');
  if (!settings.notificationEnabled) {
    log.info('main: notifications muted, skipping toasts');
    return;
  }

  let anyToastShown = false;
  for (const ev of events) {
    if (ev.kind === 'new_comments' && !settings.commentNotificationsEnabled) {
      log.debug(`main: comment notifications disabled, skipping ${ev.item.id}`);
      continue;
    }
    sendMrNotification(
      ev.item,
      { reason: ev.kind, newNotes: ev.newNotes },
      (action, clicked) => {
        recordInteraction(store, clicked.id, 'opened');
        if (action === 'open') {
          void shell.openExternal(clicked.webUrl);
        } else {
          openReviewWindow(clicked);
        }
      },
    );
    anyToastShown = true;
  }
  if (anyToastShown) setTrayState('NEW_MR');
}

function reconfigurePoller(
  store: ReturnType<typeof createStore>,
  settings: AppSettings,
  seen: PollerSeenState,
): void {
  const providers = buildProviders(settings);
  if (!poller) {
    poller = createPoller(providers, settings.pollIntervalMs, seen, {
      onEvents: (events: ItemEvent[]): void => {
        handleEvents(store, seen, events);
      },
      onOpenItems: (openItems: ReviewItemSummary[]): void => {
        updateRecentFromOpenItems(store, openItems);
      },
      onError: (err: Error): void => {
        log.error(`main: poll error — ${err.message}`);
      },
      onTick: (at: Date, health: ConnectionHealth[]): void => {
        lastCheckedAt = at;
        lastHealth = health;
        tray?.updateLastChecked(at);
        tray?.updateHealth(health);
        const anyFailure = health.some((h) => !h.ok);
        const s = store.get('settings');
        if (anyFailure) {
          setTrayState('ERROR');
        } else if (tray?.getState() === 'ERROR') {
          setTrayState(s.notificationEnabled ? 'ACTIVE' : 'MUTED');
        }
      },
      detectExtraEvents: (openItems, signal) =>
        detectV3ItemEvents(
          buildProviders(store.get('settings')),
          openItems,
          store,
          store.get('settings'),
          signal,
        ),
    });
    if (providers.length > 0) poller.start();
  } else {
    poller.replace(providers, settings.pollIntervalMs);
  }
}

function bootstrap(): void {
  const store = createStore();
  const settings = store.get('settings');
  // 저장된 단축키 등록 (없으면 기본값 사용)
  applyDashboardHotkey(settings.dashboardHotkey ?? DEFAULT_DASHBOARD_HOTKEY);
  // 저장된 recent 스냅샷을 즉시 복원 — 첫 폴링 완료 전에 목록 창을 열어도 빈 화면 안 보이게.
  lastOpenItems = store.get('recentItems') ?? [];
  const seen: PollerSeenState = {
    items: new Set<string>(store.get('seenItemIds')),
    reviewerAssigned: new Set<string>(store.get('seenReviewerItemIds')),
    lastSeenNoteAt: new Map<string, string>(
      Object.entries(store.get('lastSeenNoteAt') ?? {}),
    ),
  };
  tray = createTray(ASSETS_DIR, {
    onToggleNotification: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    onOpenSettings: openSettingsWindow,
    onOpenList: openListWindow,
    onOpenItem: (item: ReviewItemSummary): void => {
      recordInteraction(store, item.id, 'opened');
      void shell.openExternal(item.webUrl);
    },
    onReviewItem: (item: ReviewItemSummary): void => {
      recordInteraction(store, item.id, 'opened');
      openReviewWindow(item);
    },
    // TEST: 트레이 메뉴에서 목업 리뷰 테스트 시 아래 주석 해제 + TrayHandlers에 콜백 복구
    // onOpenTestReview:  () => openReviewWindow(createMockTestItem()),
    // onOpenTestReview2: () => openReviewWindow(createMockTestItem2()),
    onInstallUpdate: (): void => {
      installUpdateNow();
    },
    onQuit: (): void => {
      app.quit();
    },
  });

  tray.updateRecentItems(store.get('recentItems'));
  tray.updateInteractions(store.get('interactions') ?? {});
  setTrayState(settings.notificationEnabled ? 'ACTIVE' : 'MUTED');

  registerIpcHandlers({
    store,
    getReviewWindow: (): BrowserWindow | null => reviewWindow,
    openReviewWindow,
    openDetachedWindow: (item, spawnAt) => openDetachedWindow(item, spawnAt),
    applyStartup: (enabled: boolean): void => {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        path: process.execPath,
      });
      log.info(`main: launchOnStartup set to ${String(enabled)}`);
    },
    rebuildProviders: (): void => {
      // 설정 저장 시 providers 재구성 — 신규 연결은 silent pre-seed 먼저 실행 후 poller restart
      void (async (): Promise<void> => {
        await silentPreSeed(store, seen, buildProviders(store.get('settings')));
        reconfigurePoller(store, store.get('settings'), seen);
      })();
    },
    rebuildAIProvider: (): void => {
      // AIProvider는 review-runner가 REVIEW_START 시 매번 createAIProvider() 재호출하므로
      // 별도 재구성 불필요. 로그만 남김.
      log.info('main: AI provider config updated (re-created on next review start)');
    },
    rebuildJira: (configs): void => {
      log.info(`main: jira connections updated (count=${configs.length})`);
      void jiraBridge?.reconfigure(store.get('settings'));
    },
    onSettingsSaved: (next: AppSettings): void => {
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
      applyDashboardHotkey(next.dashboardHotkey ?? DEFAULT_DASHBOARD_HOTKEY);
    },
    onNotificationToggle: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    recordInteraction: (itemId, kind): void => {
      recordInteraction(store, itemId, kind);
    },
    getListSnapshot: () => ({
      items: lastOpenItems,
      interactions: store.get('interactions') ?? {},
      jiraIssues: store.get('recentJiraIssues') ?? [],
    }),
    openReviewById: (itemId: string): void => {
      const target = lastOpenItems.find((it) => it.id === itemId);
      if (!target) {
        log.warn(`main: openReviewById — item not found: ${itemId}`);
        return;
      }
      recordInteraction(store, itemId, 'opened');
      openReviewWindow(target);
      // 백그라운드 pre-fetch: 변경 파일 + 토론 가져와서 ITEM_NEW 한 번 더 송신.
      // → 사용자가 "리뷰 시작" 누르기 전에도 파일 목록/댓글이 표시되고,
      //   캐시된 AI 리뷰가 있으면 자동 복원됨.
      void (async (): Promise<void> => {
        const cfg = store.get('settings').gitConnections.find((c) => c.id === target.gitConfigId);
        if (!cfg) return;
        try {
          const provider = createGitProvider(cfg);
          const [full, discussions] = await Promise.all([
            provider.fetchChanges(target),
            provider.fetchDiscussions(target).catch((): [] => []),
          ]);
          full.discussions = discussions;
          if (reviewWindow && !reviewWindow.isDestroyed()) {
            sendItemToWin(reviewWindow, full);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`main: openReviewById pre-fetch failed: ${msg.slice(0, 200)}`);
        }
      })();
    },
    refreshPoller: (): void => {
      poller?.refresh();
    },
    refreshJiraBridge: (): void => {
      jiraBridge?.refresh();
    },
  });

  // seenItemIds 가 [] 이면 silent pre-seed 후 poller 시작
  void (async (): Promise<void> => {
    const preexistingSeen = store.get('seenItemIds').length;
    if (preexistingSeen === 0 && settings.gitConnections.length > 0) {
      await silentPreSeed(store, seen, buildProviders(settings));
    }
    reconfigurePoller(store, store.get('settings'), seen);
  })();

  // v3 — Jira bridge (polling + webhook) 기동
  jiraBridge = createJiraBridge(store, {
    onEvent: (ev: JiraEvent): void => {
      const s = store.get('settings');
      if (!s.notificationEnabled) return;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(JIRA_ISSUE_NEW, ev.issue);
      }
    },
    onIssues: (issues: JiraIssueSummary[]): void => {
      if (!listWindow || listWindow.isDestroyed()) return;
      listWindow.webContents.send(LIST_JIRA_UPDATED, { issues });
    },
    onError: (err: Error, cfgId: string): void => {
      log.warn(`main: jira bridge error (${cfgId.slice(0, 8)}): ${err.message.slice(0, 200)}`);
    },
  });
  jiraBridge.start(store.get('settings'));

  if (settings.gitConnections.length === 0) {
    log.info('main: no git connections, opening settings window');
    openSettingsWindow();
  }
}

app.on('second-instance', () => {
  const existing = settingsWindow;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  log.info('main: second instance detected, already running in tray');
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.pingo.app');
  }
  Menu.setApplicationMenu(null);
  bootstrap();
  initAutoUpdater((version: string): void => {
    tray?.setUpdateReady(version);
  });
});

app.on('window-all-closed', () => {
  // 트레이 앱이므로 모든 윈도우가 닫혀도 종료 금지
});

app.on('before-quit', () => {
  log.info('pingo: before-quit');
  poller?.stop();
  void jiraBridge?.stop();
  tray?.destroy();
  try { globalShortcut.unregisterAll(); } catch { /* noop */ }
  unregisterIpcHandlers();
});
