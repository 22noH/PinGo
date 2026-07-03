// main/tray.ts — 트레이 아이콘 + 상태 머신 + 컨텍스트 메뉴 (v2)
import { Menu, MenuItemConstructorOptions, nativeImage, Tray } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import type {
  ConnectionHealth,
  ItemInteraction,
  ReviewItemSummary,
  TrayState,
} from '../shared/types';
import { MAX_RECENT_ITEMS, NEW_MR_BLINK_INTERVAL_MS } from '../shared/constants';

export interface TrayController {
  getState(): TrayState;
  setState(state: TrayState): void;
  updateRecentItems(items: ReviewItemSummary[]): void;
  updateInteractions(interactions: Record<string, ItemInteraction>): void;
  updateLastChecked(at: Date): void;
  updateHealth(health: ConnectionHealth[]): void;
  /** 다운로드 완료된 업데이트 버전 표시 (null 이면 항목 숨김) */
  setUpdateReady(version: string | null): void;
  destroy(): void;
}

interface TrayHandlers {
  onToggleNotification: () => void;
  onOpenSettings: () => void;
  onOpenList: () => void;
  onOpenItem: (item: ReviewItemSummary) => void;
  onReviewItem: (item: ReviewItemSummary) => void;
  onInstallUpdate: () => void;
  onCheckUpdate: () => void;
  onOpenReleaseNotes: (version: string | null) => void;
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
  let interactions: Record<string, ItemInteraction> = {};
  let lastCheckedAt: Date | null = null;
  let health: ConnectionHealth[] = [];
  let updateReadyVersion: string | null = null;
  let blinkTimer: NodeJS.Timeout | null = null;
  let blinkToggle = false;

  const formatItemLabel = (item: ReviewItemSummary): string => {
    const itx = interactions[item.id];
    // prefix: ● 안 본 것 / (space) 열어본 것
    const prefix = itx?.openedAt ? ' ' : '●';
    // 리뷰어 태그
    const roleTag = item.viewerIsReviewer ? '👤 ' : '   ';
    // suffix: ✓ 리뷰 완료, 💬 댓글 등록
    const suffixParts: string[] = [];
    if (itx?.reviewedAt) suffixParts.push('✓');
    if (itx?.commentedAt) suffixParts.push('💬');
    const suffix = suffixParts.length > 0 ? `  ${suffixParts.join(' ')}` : '';
    const body = `[${item.providerLabel}] #${item.itemId}  ${item.sourceBranch || item.title}`;
    return `${prefix} ${roleTag}${body}${suffix}`;
  };

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
    items.push({
      label: '📋 전체 목록 열기…',
      click: (): void => handlers.onOpenList(),
    });
    items.push({ type: 'separator' });
    items.push({ label: '최근 MR/PR', enabled: false });

    if (recentItems.length === 0) {
      items.push({ label: '  (없음)', enabled: false });
    } else {
      for (const item of recentItems) {
        const label = formatItemLabel(item);
        items.push({
          label,
          submenu: [
            {
              label: '🧠 AI 리뷰',
              click: (): void => handlers.onReviewItem(item),
            },
            {
              label: '🌐 브라우저로 열기',
              click: (): void => handlers.onOpenItem(item),
            },
          ],
        });
      }
    }

    items.push({ type: 'separator' });
    items.push({ label: '⚙️  설정', click: (): void => handlers.onOpenSettings() });
    items.push({ type: 'separator' });
    if (updateReadyVersion) {
      items.push({
        label: `⬆️  v${updateReadyVersion} 업데이트 — 재시작하여 적용`,
        click: (): void => handlers.onInstallUpdate(),
      });
      items.push({
        label: `📄  v${updateReadyVersion} 변경사항 보기`,
        click: (): void => handlers.onOpenReleaseNotes(updateReadyVersion),
      });
    } else {
      items.push({
        label: '⬆️  업데이트 확인',
        click: (): void => handlers.onCheckUpdate(),
      });
      items.push({
        label: '📄  릴리스 노트',
        click: (): void => handlers.onOpenReleaseNotes(null),
      });
    }
    items.push({ type: 'separator' });
    items.push({ label: '종료', click: (): void => handlers.onQuit() });

    return Menu.buildFromTemplate(items);
  };

  const refreshMenu = (): void => {
    tray.setContextMenu(buildMenu());
  };

  // 좌클릭은 아무 동작 없음 (이전엔 컨텍스트 메뉴를 띄웠는데, 더블클릭 후에도
  // 잔상처럼 남아 거슬린다는 피드백으로 제거). 메뉴는 우클릭 전용.
  // 우클릭은 tray.setContextMenu(...) 덕분에 Windows/macOS에서 자동으로 동작.
  tray.on('double-click', () => {
    handlers.onOpenList();
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
      recentItems = items.slice(0, MAX_RECENT_ITEMS);
      refreshMenu();
    },
    updateInteractions: (next: Record<string, ItemInteraction>): void => {
      interactions = next;
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
    setUpdateReady: (version: string | null): void => {
      updateReadyVersion = version;
      refreshMenu();
    },
    destroy: (): void => {
      stopBlink();
      tray.destroy();
    },
  };
}
