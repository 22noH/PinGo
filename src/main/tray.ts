// main/tray.ts — 트레이 아이콘 + 상태 머신 + 컨텍스트 메뉴 (v2)
import { Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import type {
  ConnectionHealth,
  ReviewItemSummary,
  TrayState,
} from '../shared/types';
import { NEW_MR_BLINK_INTERVAL_MS } from '../shared/constants';

export interface TrayController {
  getState(): TrayState;
  setState(state: TrayState): void;
  updateRecentItems(items: ReviewItemSummary[]): void;
  updateLastChecked(at: Date): void;
  updateHealth(health: ConnectionHealth[]): void;
  destroy(): void;
}

interface TrayHandlers {
  onToggleNotification: () => void;
  onOpenSettings: () => void;
  onOpenItem: (webUrl: string) => void;
  onOpenTestReview: () => void;
  onOpenTestReview2: () => void;
  onQuit: () => void;
}

const ICON_FILES: Record<TrayState, string> = {
  ACTIVE: 'icon-active.png',
  MUTED: 'icon-muted.png',
  NEW_MR: 'icon-new-mr.png',
  ERROR: 'icon-error.png',
};

function formatSince(from: Date | null): string {
  if (!from) return '아직 확인 전';
  const diffSec = Math.floor((Date.now() - from.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}초 전`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전`;
}

function healthSummary(health: ConnectionHealth[]): string {
  if (health.length === 0) return '연결 없음';
  return health
    .map((h) => `${h.label} ${h.ok ? '✓' : '✗'}`)
    .join(' · ');
}

function statusLabel(
  state: TrayState,
  lastCheckedAt: Date | null,
  health: ConnectionHealth[],
): string {
  const since = formatSince(lastCheckedAt);
  const healthStr = healthSummary(health);
  switch (state) {
    case 'ACTIVE':
      return `🟢 폴링 중 — ${healthStr} (${since})`;
    case 'MUTED':
      return `🔕 알림 꺼짐 — ${healthStr} (${since})`;
    case 'NEW_MR':
      return `🟡 새 MR/PR 있음 — ${healthStr} (${since})`;
    case 'ERROR':
      return `⚫ 연결 실패 — ${healthStr} (${since})`;
  }
}

export function createTray(iconDir: string, handlers: TrayHandlers): TrayController {
  let state: TrayState = 'ACTIVE';
  let recentItems: ReviewItemSummary[] = [];
  let lastCheckedAt: Date | null = null;
  let health: ConnectionHealth[] = [];
  let blinkTimer: NodeJS.Timeout | null = null;
  let blinkToggle = false;

  const loadIcon = (file: string): Electron.NativeImage => {
    const img = nativeImage.createFromPath(path.join(iconDir, file));
    if (img.isEmpty()) {
      log.warn(`tray: icon not found or empty: ${file}`);
    }
    return img;
  };

  const tray = new Tray(loadIcon(ICON_FILES.ACTIVE));
  tray.setToolTip('pingo');

  const stopBlink = (): void => {
    if (blinkTimer) {
      clearInterval(blinkTimer);
      blinkTimer = null;
    }
    blinkToggle = false;
  };

  const startBlink = (): void => {
    stopBlink();
    blinkTimer = setInterval(() => {
      blinkToggle = !blinkToggle;
      tray.setImage(loadIcon(blinkToggle ? ICON_FILES.ACTIVE : ICON_FILES.NEW_MR));
    }, NEW_MR_BLINK_INTERVAL_MS);
  };

  const applyIcon = (): void => {
    if (state === 'NEW_MR') {
      startBlink();
      return;
    }
    stopBlink();
    tray.setImage(loadIcon(ICON_FILES[state]));
  };

  const buildMenu = (): Menu => {
    const items: MenuItemConstructorOptions[] = [];
    items.push({
      label: statusLabel(state, lastCheckedAt, health),
      enabled: false,
    });
    items.push({ type: 'separator' });

    const toggleLabel = state === 'MUTED' ? '🔕 알림 꺼짐' : '🔔 알림 켜짐';
    items.push({
      label: toggleLabel,
      type: 'checkbox',
      checked: state !== 'MUTED',
      click: (): void => handlers.onToggleNotification(),
    });

    items.push({ type: 'separator' });
    items.push({ label: '최근 MR/PR', enabled: false });

    if (recentItems.length === 0) {
      items.push({ label: '  (없음)', enabled: false });
    } else {
      for (const item of recentItems) {
        const label = `  [${item.providerLabel}] #${item.itemId}  ${item.sourceBranch || item.title}`;
        items.push({
          label,
          click: (): void => handlers.onOpenItem(item.webUrl),
        });
      }
    }

    items.push({ type: 'separator' });
    items.push({ label: '⚙️  설정', click: (): void => handlers.onOpenSettings() });
    items.push({ label: '🧪  테스트 리뷰 #1 (GitLab)', click: (): void => handlers.onOpenTestReview() });
    items.push({ label: '🧪  테스트 리뷰 #2 (GitHub)', click: (): void => handlers.onOpenTestReview2() });
    items.push({ type: 'separator' });
    items.push({ label: '종료', click: (): void => handlers.onQuit() });

    return Menu.buildFromTemplate(items);
  };

  const refreshMenu = (): void => {
    tray.setContextMenu(buildMenu());
  };

  tray.on('click', () => {
    tray.popUpContextMenu(buildMenu());
  });

  applyIcon();
  refreshMenu();

  return {
    getState: (): TrayState => state,
    setState: (next: TrayState): void => {
      if (state === next) return;
      log.info(`tray: state ${state} → ${next}`);
      state = next;
      applyIcon();
      refreshMenu();
    },
    updateRecentItems: (items: ReviewItemSummary[]): void => {
      recentItems = items.slice(0, 5);
      refreshMenu();
    },
    updateLastChecked: (at: Date): void => {
      lastCheckedAt = at;
      refreshMenu();
    },
    updateHealth: (next: ConnectionHealth[]): void => {
      health = next;
      refreshMenu();
    },
    destroy: (): void => {
      stopBlink();
      tray.destroy();
    },
  };
}
