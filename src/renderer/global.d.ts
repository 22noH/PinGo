// global.d.ts — renderer 전역 타입 선언
// settings/review 윈도우에서 window.electronAPI 에 타입 적용.
import type { ElectronAPI } from '../preload';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
