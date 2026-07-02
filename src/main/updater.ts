// main/updater.ts — electron-updater 자동 업데이트
// GitHub Release 의 latest.yml 을 확인 → 백그라운드 다운로드 → 앱 종료/재시작 시 설치.
import { app } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간

export function initAutoUpdater(): void {
  if (!app.isPackaged) {
    log.info('updater: dev 모드 — 자동 업데이트 스킵');
    return;
  }
  autoUpdater.logger = log;

  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
      // 오프라인/rate limit 등은 치명적이지 않음 — 다음 주기에 재시도
      log.warn(`updater: check failed: ${String(err).slice(0, 200)}`);
    });
  };

  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
