// main/main.ts — Electron 앱 엔트리포인트 (v2)
import { app, BrowserWindow, Menu, shell } from 'electron';
import * as path from 'path';
import log, { LogMessage } from 'electron-log';
import type {
  AppSettings,
  ConnectionHealth,
  ReviewItemSummary,
  ReviewItemWithChanges,
  TrayState,
} from '../shared/types';
import { createMockTestItem, createMockTestItem2 } from './mock-test-item';
import {
  ITEM_NEW,
  MAX_RECENT_ITEMS,
  MAX_SEEN_ITEM_IDS,
  TRAY_STATE_CHANGED,
} from '../shared/constants';
import { createStore } from './store';
import { createTray, TrayController } from './tray';
import { createPoller, PollerController } from './poller';
import { sendMrNotification } from './notifier';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc';
import { createGitProvider, GitProvider } from './providers/git/git-provider';
import { createAppWindow, WindowDirs } from './windows';
import { silentPreSeed } from './preseed';
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
};

let tray: TrayController | null = null;
let poller: PollerController | null = null;
let reviewWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let lastCheckedAt: Date | null = null;
let lastHealth: ConnectionHealth[] = [];

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

function openReviewWindow(item?: ReviewItemSummary | ReviewItemWithChanges): void {
  if (!reviewWindow || reviewWindow.isDestroyed()) {
    reviewWindow = createAppWindow(WIN_DIRS, 'review/index.html', 'Pingo — AI Review', 1000, 760, true);
    reviewWindow.on('closed', () => { reviewWindow = null; });
  } else {
    reviewWindow.show();
    reviewWindow.focus();
  }
  if (item) {
    const target = reviewWindow;
    const send = (): void => {
      if (target && !target.isDestroyed()) target.webContents.send(ITEM_NEW, item);
    };
    if (target.webContents.isLoading()) {
      target.webContents.once('did-finish-load', send);
    } else {
      send();
    }
  }
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

function rememberNewItems(
  store: ReturnType<typeof createStore>,
  newItems: ReviewItemSummary[],
): void {
  const seen = new Set<string>(store.get('seenItemIds'));
  for (const item of newItems) seen.add(item.id);
  store.set('seenItemIds', Array.from(seen).slice(-MAX_SEEN_ITEM_IDS));

  const prior = store.get('recentItems');
  const merged = [...newItems, ...prior].slice(0, MAX_RECENT_ITEMS);
  store.set('recentItems', merged);
  tray?.updateRecentItems(merged);
}

function handleNewItems(
  store: ReturnType<typeof createStore>,
  newItems: ReviewItemSummary[],
): void {
  rememberNewItems(store, newItems);
  const { notificationEnabled } = store.get('settings');
  if (!notificationEnabled) {
    log.info('main: notifications muted, skipping toast');
    return;
  }
  for (const item of newItems) {
    sendMrNotification(item, (action, clicked) => {
      if (action === 'open') {
        void shell.openExternal(clicked.webUrl);
      } else {
        openReviewWindow(clicked);
      }
    });
  }
  setTrayState('NEW_MR');
}

function reconfigurePoller(
  store: ReturnType<typeof createStore>,
  settings: AppSettings,
  seenIds: Set<string>,
): void {
  const providers = buildProviders(settings);
  if (!poller) {
    poller = createPoller(providers, settings.pollIntervalMs, seenIds, {
      onFound: (newItems: ReviewItemSummary[]): void => {
        for (const item of newItems) seenIds.add(item.id);
        handleNewItems(store, newItems);
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
    });
    if (providers.length > 0) poller.start();
  } else {
    poller.replace(providers, settings.pollIntervalMs);
  }
}

function bootstrap(): void {
  const store = createStore();
  const settings = store.get('settings');
  const seenIds = new Set<string>(store.get('seenItemIds'));
  tray = createTray(ASSETS_DIR, {
    onToggleNotification: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    onOpenSettings: openSettingsWindow,
    onOpenItem: (url: string): void => {
      void shell.openExternal(url);
    },
    onOpenTestReview: (): void => {
      openReviewWindow(createMockTestItem());
    },
    onOpenTestReview2: (): void => {
      openReviewWindow(createMockTestItem2());
    },
    onQuit: (): void => {
      app.quit();
    },
  });

  tray.updateRecentItems(store.get('recentItems'));
  setTrayState(settings.notificationEnabled ? 'ACTIVE' : 'MUTED');

  registerIpcHandlers({
    store,
    getReviewWindow: (): BrowserWindow | null => reviewWindow,
    openReviewWindow,
    rebuildProviders: (): void => {
      // 설정 저장 시 providers 재구성 — 신규 연결은 silent pre-seed 먼저 실행 후 poller restart
      void (async (): Promise<void> => {
        await silentPreSeed(store, seenIds, buildProviders(store.get('settings')));
        reconfigurePoller(store, store.get('settings'), seenIds);
      })();
    },
    rebuildAIProvider: (): void => {
      // AIProvider는 review-runner가 REVIEW_START 시 매번 createAIProvider() 재호출하므로
      // 별도 재구성 불필요. 로그만 남김.
      log.info('main: AI provider config updated (re-created on next review start)');
    },
    onSettingsSaved: (next: AppSettings): void => {
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    onNotificationToggle: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
  });

  // seenItemIds 가 [] 이면 silent pre-seed 후 poller 시작
  void (async (): Promise<void> => {
    const preexistingSeen = store.get('seenItemIds').length;
    if (preexistingSeen === 0 && settings.gitConnections.length > 0) {
      await silentPreSeed(store, seenIds, buildProviders(settings));
    }
    reconfigurePoller(store, store.get('settings'), seenIds);
  })();

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
});

app.on('window-all-closed', () => {
  // 트레이 앱이므로 모든 윈도우가 닫혀도 종료 금지
});

app.on('before-quit', () => {
  log.info('pingo: before-quit');
  poller?.stop();
  tray?.destroy();
  unregisterIpcHandlers();
});
