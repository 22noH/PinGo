// providers/ai/cli-resolver.ts — CLI 실행 파일 경로 탐색 + shell 판정 공용 헬퍼
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Windows/macOS/Linux 에서 CLI 실행 파일 탐색.
 * 우선순위:
 *   1) explicit (사용자 설정 경로) — 존재하면 그대로 사용
 *   2) PATH 조회 (where/which, shell 경유)
 *   3) 알려진 설치 경로들 폴백
 * 못 찾으면 bin 이름 그대로 반환 (spawn이 ENOENT 로 처리).
 */
export function resolveCliExecPath(binName: string, explicit?: string): string {
  // 1) 사용자 지정 경로 — 존재하면 우선 사용
  if (explicit && explicit.trim().length > 0) {
    const trimmed = explicit.trim();
    // 상대 경로/bin 이름만 줘도 그대로 전달 (shell 에서 해석 가능)
    // 절대 경로인데 존재하지 않으면 그래도 사용자 의도 존중해서 그대로 반환
    return trimmed;
  }

  // 2) PATH 조회
  try {
    const isWin = process.platform === 'win32';
    const lookup = spawnSync(isWin ? 'where' : 'which', [binName], {
      encoding: 'utf-8',
      shell: true,
      timeout: 3_000,
    });
    if (lookup.status === 0 && typeof lookup.stdout === 'string') {
      const line = lookup.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (line && fs.existsSync(line)) return line;
    }
  } catch { /* ignore */ }

  // 3) 알려진 설치 위치
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', `${binName}.exe`),
        path.join(home, '.local', 'bin', `${binName}.cmd`),
        path.join(appData, 'npm', `${binName}.cmd`),
        path.join(appData, 'npm', `${binName}.ps1`),
        path.join(localAppData, 'Programs', binName, `${binName}.exe`),
      ]
    : [
        path.join(home, '.local', 'bin', binName),
        `/usr/local/bin/${binName}`,
        `/opt/homebrew/bin/${binName}`,
        path.join(home, '.npm-global', 'bin', binName),
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return binName;
}

/** .cmd / .bat / .ps1 은 Windows 에서 shell 경유 실행 필요 */
export function needsShell(execPath: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(execPath);
}
