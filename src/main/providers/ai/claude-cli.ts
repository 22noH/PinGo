// providers/ai/claude-cli.ts — Claude CLI 스트리밍 실행 (stream-json)
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  ClaudeCLIConfig,
} from '../../../shared/types';
import { CLAUDE_INSTALL_URL } from '../../../shared/constants';
import type { AIProvider, AIStreamHandle } from './ai-provider';
import { createStreamJsonParser } from './claude-stream-json';
import { resolveCliExecPath, needsShell } from './cli-resolver';

/**
 * system 지시문을 임시 파일로 써서 `--append-system-prompt-file` 로 넘긴다.
 * 인자로 직접 주면 Windows 에서 .cmd 경유(shell) 실행 시 줄바꿈·따옴표에 깨진다.
 * @returns 파일 경로와 정리 함수. 쓰기 실패면 null — 프롬프트 앞머리로 폴백.
 */
function writeSystemPromptFile(system: string): { file: string; cleanup: () => void } | null {
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'pingo-sys-'));
    const file = path.join(dir, 'system.md');
    writeFileSync(file, system, 'utf-8');
    return {
      file,
      cleanup: (): void => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 임시 파일 — 무시 */ }
      },
    };
  } catch (err) {
    log.warn(`claude-cli: system prompt 파일 생성 실패 — 프롬프트 앞머리로 폴백: ${String(err)}`);
    return null;
  }
}

export class ClaudeCLIProvider implements AIProvider {
  readonly config: ClaudeCLIConfig;

  constructor(config: ClaudeCLIConfig) {
    this.config = config;
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: (finalText?: string) => void,
    onError: (err: Error) => void,
    cwd?: string,
    system?: string,
  ): AIStreamHandle {
    const execPath = resolveCliExecPath('claude', this.config.execPath);
    const useShell = needsShell(execPath);

    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
    const model = (this.config.model ?? '').trim();
    if (model) args.push('--model', model);
    const effort = (this.config.effort ?? '').trim();
    if (effort) args.push('--effort', effort);
    // 자동 리뷰가 클론한 저장소에서 실행될 때만 — 파일 열람과 git diff 를 프롬프트 없이 허용.
    // 이게 없으면 -p(비대화) 모드에서 도구 사용이 막혀 "확인하지 못한 파일" 로만 끝난다.
    if (cwd) {
      args.push(
        '--allowedTools', 'Read', 'Grep', 'Glob',
        'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)',
      );
    }
    // 역할·한국어·양식 지시는 시스템 프롬프트에 덧붙인다. 사용자 메시지(diff 수만 자)에 섞어
    // 보내면 CLI 자체 시스템 프롬프트(영어·간결체)에 밀려 영어 리뷰가 나온다.
    const sysFile = system ? writeSystemPromptFile(system) : null;
    if (sysFile) args.push('--append-system-prompt-file', sysFile.file);
    const stdinText = system && !sysFile ? `${system}\n\n${prompt}` : prompt;

    log.info(
      `claude-cli: spawning ${execPath}${useShell ? ' (via shell)' : ''} ` +
      `model=${model || '(default)'} effort=${effort || '(default)'}` +
      `${cwd ? ` cwd=${cwd}` : ''}${sysFile ? ' system=file' : ''}`,
    );

    const proc = spawn(
      execPath,
      args,
      { stdio: ['pipe', 'pipe', 'pipe'], shell: useShell, cwd },
    );

    let aborted = false;
    let errored = false;
    let lineBuffer = '';

    const parser = createStreamJsonParser({
      onChunk,
      onError: (err): void => {
        errored = true;
        onError(err);
      },
      onSkip: (line): void => {
        log.debug(`claude-cli: non-JSON line skipped: ${line.slice(0, 200)}`);
      },
    });

    proc.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) parser.handleLine(line);
    });

    proc.stderr.on('data', (data: Buffer) => {
      log.warn(`claude-cli[stderr]: ${data.toString('utf-8').trim()}`);
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      errored = true;
      sysFile?.cleanup();
      if (err.code === 'ENOENT') {
        onError(
          new Error(
            `Claude CLI가 설치되지 않았습니다. ${CLAUDE_INSTALL_URL} 에서 설치하세요.`,
          ),
        );
      } else {
        log.error(`claude-cli: spawn error: ${err.message}`);
        onError(err);
      }
    });

    proc.on('close', (code: number | null) => {
      sysFile?.cleanup();
      if (lineBuffer.length > 0) {
        parser.handleLine(lineBuffer);
        lineBuffer = '';
      }
      if (aborted) {
        log.info('claude-cli: aborted by user');
        return;
      }
      if (errored) return;
      if (code === 0) {
        const final = parser.finalText();
        if (final !== undefined && final !== parser.streamedText()) {
          log.info(`claude-cli: 도구 사용 중 진행 서술 ${parser.streamedText().length - final.length}자 제외 — result 텍스트를 본문으로`);
        }
        onDone(final);
      } else {
        onError(new Error(`claude exited with code ${code ?? 'null'}`));
      }
    });

    try {
      proc.stdin.write(stdinText, 'utf-8');
      proc.stdin.end();
    } catch (err) {
      errored = true;
      onError(err instanceof Error ? err : new Error('stdin write failed'));
      proc.kill('SIGTERM');
    }

    return {
      abort: (): void => {
        if (proc.exitCode !== null) return;
        aborted = true;
        proc.kill('SIGTERM');
        log.info('claude-cli: SIGTERM sent');
      },
    };
  }

  async testAvailability(): Promise<AIAvailabilityTestResult> {
    const execPath = resolveCliExecPath('claude', this.config.execPath);
    const useShell = needsShell(execPath);
    log.info(`claude-cli: testAvailability → ${execPath}${useShell ? ' (shell)' : ''}`);
    try {
      const res = spawnSync(execPath, ['--version'], {
        timeout: 8_000,
        encoding: 'utf-8',
        shell: useShell,
      });
      if (res.error) {
        const err = res.error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return {
            success: false,
            error:
              `Claude CLI 실행 파일을 찾지 못했습니다 (시도 경로: ${execPath}). ` +
              `설정에서 전체 경로를 지정하거나 ${CLAUDE_INSTALL_URL} 에서 설치하세요.`,
          };
        }
        return { success: false, error: `${err.message} (경로: ${execPath})` };
      }
      if (res.status !== 0) {
        const stderr = (res.stderr || '').trim().slice(0, 200);
        return {
          success: false,
          error: `exit code ${res.status ?? 'null'}${stderr ? ` — ${stderr}` : ''} (경로: ${execPath})`,
        };
      }
      const version = (res.stdout || '').trim() || 'unknown';
      return { success: true, version: `${version} (${execPath})` };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}
