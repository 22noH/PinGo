// main/windows.ts — BrowserWindow 생성 헬퍼
import { BrowserWindow } from 'electron';
import * as path from 'path';

export interface WindowDirs {
  preloadPath: string;
  rendererDir: string;
  assetsDir: string;
}

export function createAppWindow(
  dirs: WindowDirs,
  htmlFile: string,
  title: string,
  width: number,
  height: number,
  overlayTitleBar = false,
  maximizable = true,
  spawnAt?: { x: number; y: number },
): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    title,
    show: false,
    ...(spawnAt ? { x: Math.round(spawnAt.x - width / 2), y: spawnAt.y } : {}),
    maximizable,
    backgroundColor: '#1a1b2e',
    icon: path.join(dirs.assetsDir, 'app-icon.png'),
    ...(overlayTitleBar
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#1a1b2e',
            symbolColor: '#cdd6f4',
            height: 42,
          },
        }
      : {}),
    webPreferences: {
      preload: dirs.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(dirs.rendererDir, htmlFile));
  win.once('ready-to-show', () => win.show());
  return win;
}
