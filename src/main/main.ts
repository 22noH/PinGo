// main/main.ts — Electron 앱 엔트리포인트
import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import log, { LogMessage } from 'electron-log';
import type {
  AppSettings,
  MergeRequestSummary,
  TrayState,
} from '../shared/types';
import { MAX_RECENT_MRS, MAX_SEEN_MR_IDS, MR_NEW, TRAY_STATE_CHANGED } from '../shared/constants';
import { createStore } from './store';
import { createTray, TrayController } from './tray';
import { createPoller, PollerController } from './poller';
import { sendMrNotification } from './notifier';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc';

// ── 중복 실행 방지 (트레이 앱이므로 단일 인스턴스 보장) ────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  // 이후 초기화 로직이 실행되지 않도록 즉시 종료 (quit은 비동기이므로 가드 필요)
  process.exit(0);
}

log.transports.file.level = 'info';

// electron-log hook: 토큰/인증 헤더 패턴 로그에서 마스킹
const TOKEN_PATTERN = /glpat-[A-Za-z0-9_-]{20,}/g;
const HEADER_PATTERN = /(PRIVATE-TOKEN|Authorization):\s*\S+/g;
log.hooks.push((message: LogMessage): LogMessage => {
  message.data = message.data.map((item: unknown): unknown => {
    if (typeof item === 'string') {
      return item
        .replace(HEADER_PATTERN, '$1: [REDACTED]')
        .replace(TOKEN_PATTERN, 'glpat-[REDACTED]');
    }
    return item;
  });
  return message;
});

log.info(`pingo: app starting (electron ${process.versions.electron})`);

const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '..', '..', 'assets');

const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const RENDERER_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'src', 'renderer')
  : path.join(__dirname, '..', '..', 'src', 'renderer');

let tray: TrayController | null = null;
let poller: PollerController | null = null;
let reviewWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let lastCheckedAt: Date | null = null;

function broadcastTrayState(state: TrayState): void {
  const payload = {
    state,
    lastCheckedAt: (lastCheckedAt ?? new Date()).toISOString(),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(TRAY_STATE_CHANGED, payload);
    }
  }
}

function setTrayState(next: TrayState): void {
  tray?.setState(next);
  broadcastTrayState(next);
}

function createBrowserWindow(htmlFile: string, title: string, width: number, height: number): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    title,
    show: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(RENDERER_DIR, htmlFile));
  win.once('ready-to-show', () => win.show());
  return win;
}

function openReviewWindow(mr?: MergeRequestSummary): void {
  if (!reviewWindow || reviewWindow.isDestroyed()) {
    reviewWindow = createBrowserWindow('review/index.html', 'Pingo — AI Review', 1000, 760);
    reviewWindow.on('closed', () => {
      reviewWindow = null;
    });
  } else {
    reviewWindow.show();
    reviewWindow.focus();
  }
  if (mr) {
    const target = reviewWindow;
    const send = (): void => {
      if (target && !target.isDestroyed()) target.webContents.send(MR_NEW, mr);
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
    settingsWindow = createBrowserWindow('settings/index.html', 'Pingo — Settings', 560, 520);
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  } else {
    settingsWindow.show();
    settingsWindow.focus();
  }
}

function rememberNewMrs(store: ReturnType<typeof createStore>, newMrs: MergeRequestSummary[]): void {
  const seen = new Set<number>(store.get('seenMrIds'));
  for (const mr of newMrs) seen.add(mr.id);
  store.set('seenMrIds', Array.from(seen).slice(-MAX_SEEN_MR_IDS));

  const prior = store.get('recentMrs');
  const merged = [...newMrs, ...prior].slice(0, MAX_RECENT_MRS);
  store.set('recentMrs', merged);
  tray?.updateRecentMrs(merged);
}

function handleNewMrs(
  store: ReturnType<typeof createStore>,
  newMrs: MergeRequestSummary[],
): void {
  rememberNewMrs(store, newMrs);
  const { notificationEnabled } = store.get('settings');

  if (notificationEnabled) {
    for (const mr of newMrs) {
      sendMrNotification(mr, (action, clicked) => {
        if (action === 'open') {
          void shell.openExternal(clicked.web_url);
        } else {
          openReviewWindow(clicked as MergeRequestSummary);
        }
      });
    }
    setTrayState('NEW_MR');
  } else {
    log.info('main: notifications muted, skipping toast');
  }
}

function bootstrap(): void {
  const store = createStore();
  const settings = store.get('settings');
  const seenIds = new Set<number>(store.get('seenMrIds'));

  tray = createTray(ASSETS_DIR, {
    onToggleNotification: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    onOpenSettings: openSettingsWindow,
    onOpenMr: (url: string): void => {
      void shell.openExternal(url);
    },
    onQuit: (): void => {
      app.quit();
    },
  });

  tray.updateRecentMrs(store.get('recentMrs'));
  setTrayState(settings.notificationEnabled ? 'ACTIVE' : 'MUTED');

  poller = createPoller(
    settings,
    seenIds,
    (newMrs: MergeRequestSummary[]): void => {
      for (const m of newMrs) seenIds.add(m.id);
      handleNewMrs(store, newMrs);
    },
    (err: Error): void => {
      log.error(`main: poll error — ${err.message}`);
      setTrayState('ERROR');
    },
    (at: Date): void => {
      lastCheckedAt = at;
      tray?.updateLastChecked(at);
      // ERROR 상태였다가 성공했으면 복원
      if (tray?.getState() === 'ERROR') {
        const s = store.get('settings');
        setTrayState(s.notificationEnabled ? 'ACTIVE' : 'MUTED');
      }
    },
  );

  registerIpcHandlers({
    store,
    getReviewWindow: (): BrowserWindow | null => reviewWindow,
    onSettingsSaved: (next: AppSettings): void => {
      poller?.restart(next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
    onNotificationToggle: (): void => {
      const s = store.get('settings');
      const next: AppSettings = { ...s, notificationEnabled: !s.notificationEnabled };
      store.set('settings', next);
      setTrayState(next.notificationEnabled ? 'ACTIVE' : 'MUTED');
    },
  });

  // 토큰 미설정 → 설정 창 자동 오픈
  if (!settings.token || !settings.gitlabUrl || !settings.userId) {
    log.info('main: settings incomplete, opening settings window');
    openSettingsWindow();
  } else {
    poller.start();
  }
}

app.on('second-instance', () => {
  // 두 번째 인스턴스 실행 시: 설정 창이 열려 있으면 포커스, 아니면 트레이 사용자 안내
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
  bootstrap();
});

// 트레이 앱이므로 모든 윈도우 닫혀도 종료 금지
app.on('window-all-closed', () => {
  // no-op
});

app.on('before-quit', () => {
  log.info('pingo: before-quit');
  poller?.stop();
  tray?.destroy();
  unregisterIpcHandlers();
});
