// main/updater.ts — electron-updater 자동 업데이트
// GitHub Release 의 latest.yml 을 확인 → 백그라운드 다운로드 → 앱 종료/재시작 시 설치.
// 다운로드 완료 시 트레이/대시보드에 "재시작하여 업데이트" 진입점이 노출되고,
// installUpdateNow() 로 즉시(사일런트 설치 + 자동 재실행) 적용할 수 있다.
import { app, BrowserWindow, Notification } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import { UPDATE_READY } from '../shared/constants';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간

let readyVersion: string | null = null;

/** 다운로드 완료되어 설치 대기 중인 버전 — 없으면 null */
export function getUpdateReadyVersion(): string | null {
  return readyVersion;
}

/** 즉시 적용: 앱 종료 → 사일런트 설치 → 자동 재실행 (Claude Code 방식) */
export function installUpdateNow(): void {
  if (!readyVersion) {
    log.warn('updater: installUpdateNow called but no update ready');
    return;
  }
  log.info(`updater: quitAndInstall v${readyVersion}`);
  autoUpdater.quitAndInstall(true, true);
}

/** 트레이 메뉴에서 수동 업데이트 확인 — 결과를 토스트로 알림 */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    log.info('updater: dev 모드 — 수동 확인 스킵');
    return;
  }
  void (async (): Promise<void> => {
    try {
      const res = await autoUpdater.checkForUpdatesAndNotify();
      const latest = res?.updateInfo?.version;
      // 새 버전이면 update-downloaded 이벤트 쪽에서 알림/메뉴 갱신이 처리됨
      if (!latest || latest === app.getVersion()) {
        new Notification({
          title: 'Pingo 업데이트',
          body: `현재 최신 버전입니다 (v${app.getVersion()})`,
        }).show();
      }
    } catch (err) {
      new Notification({
        title: 'Pingo 업데이트',
        body: `업데이트 확인 실패: ${String(err).slice(0, 120)}`,
      }).show();
    }
  })();
}

export function initAutoUpdater(onUpdateReady?: (version: string) => void): void {
  if (!app.isPackaged) {
    log.info('updater: dev 모드 — 자동 업데이트 스킵');
    return;
  }
  autoUpdater.logger = log;

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    log.info(`updater: update downloaded v${info.version}`);
    onUpdateReady?.(info.version);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(UPDATE_READY, info.version);
    }
  });

  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      // 오프라인/rate limit 등은 치명적이지 않음 — 다음 주기에 재시도
      log.warn(`updater: check failed: ${String(err).slice(0, 200)}`);
    });
  };

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
