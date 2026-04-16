// main/windows.ts — BrowserWindow 생성 헬퍼
import { BrowserWindow } from 'electron';
import * as path from 'path';

export interface WindowDirs {
  preloadPath: string;
  rendererDir: string;
}

export function createAppWindow(
  dirs: WindowDirs,
  htmlFile: string,
  title: string,
  width: number,
  height: number,
): BrowserWindow {
  const win = new BrowserWindow({
    width,
    height,
    title,
    show: false,
    backgroundColor: '#1e1e2e',
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
