// providers/ai/codex-cli.ts — OpenAI Codex CLI 스트리밍 실행
import { spawn, spawnSync } from 'child_process';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  CodexCLIConfig,
} from '../../../shared/types';
import { CODEX_INSTALL_URL } from '../../../shared/constants';
import type { AIProvider, AIStreamHandle } from './ai-provider';
import { resolveCliExecPath, needsShell } from './cli-resolver';

/**
 * Codex CLI (`codex -p <prompt>`) 는 stdout으로 평문 텍스트를 스트리밍.
 * stream-json 포맷 미지원이므로 Buffer를 UTF-8로 디코드하여 그대로 청크 전달.
 */
export class CodexCLIProvider implements AIProvider {
  readonly config: CodexCLIConfig;

  constructor(config: CodexCLIConfig) {
    this.config = config;
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle {
    const execPath = resolveCliExecPath('codex', this.config.execPath);
    const useShell = needsShell(execPath);
    log.info(`codex-cli: spawning ${execPath}${useShell ? ' (via shell)' : ''}`);

    const proc = spawn(execPath, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    });

    let aborted = false;
    let errored = false;

    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => {
      onChunk(chunk);
    });

    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => {
      log.warn(`codex-cli[stderr]: ${chunk.trim()}`);
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      errored = true;
      if (err.code === 'ENOENT') {
        onError(
          new Error(
            `Codex CLI가 설치되지 않았습니다. ${CODEX_INSTALL_URL} 을 참고하세요.`,
          ),
        );
      } else {
        onError(err);
      }
    });

    proc.on('close', (code: number | null) => {
      if (aborted) {
        log.info('codex-cli: aborted by user');
        return;
      }
      if (errored) return;
      if (code === 0) onDone();
      else onError(new Error(`codex exited with code ${code ?? 'null'}`));
    });

    return {
      abort: (): void => {
        if (proc.exitCode !== null) return;
        aborted = true;
        proc.kill('SIGTERM');
        log.info('codex-cli: SIGTERM sent');
      },
    };
  }

  async testAvailability(): Promise<AIAvailabilityTestResult> {
    const execPath = resolveCliExecPath('codex', this.config.execPath);
    const useShell = needsShell(execPath);
    log.info(`codex-cli: testAvailability → ${execPath}${useShell ? ' (shell)' : ''}`);
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
              `Codex CLI 실행 파일을 찾지 못했습니다 (시도 경로: ${execPath}). ` +
              `설정에서 전체 경로를 지정하거나 ${CODEX_INSTALL_URL} 을 참고하세요.`,
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
