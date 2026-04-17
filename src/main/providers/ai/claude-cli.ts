// providers/ai/claude-cli.ts — Claude CLI 스트리밍 실행 (stream-json)
import { spawn, spawnSync } from 'child_process';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  ClaudeCLIConfig,
} from '../../../shared/types';
import { CLAUDE_INSTALL_URL } from '../../../shared/constants';
import type { AIProvider, AIStreamHandle } from './ai-provider';
import { resolveCliExecPath, needsShell } from './cli-resolver';

interface StreamJsonContentBlock {
  type: string;
  text?: string;
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  text?: string;
  message?: {
    content?: StreamJsonContentBlock[];
  };
  result?: string;
  is_error?: boolean;
  error?: { message?: string };
}

export class ClaudeCLIProvider implements AIProvider {
  readonly config: ClaudeCLIConfig;

  constructor(config: ClaudeCLIConfig) {
    this.config = config;
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle {
    const execPath = resolveCliExecPath('claude', this.config.execPath);
    const useShell = needsShell(execPath);
    log.info(`claude-cli: spawning ${execPath}${useShell ? ' (via shell)' : ''}`);

    const proc = spawn(
      execPath,
      ['-p', '--output-format', 'stream-json', '--verbose'],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: useShell },
    );

    let aborted = false;
    let errored = false;
    let lineBuffer = '';

    let emittedAny = false;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: StreamJsonEvent;
      try {
        event = JSON.parse(trimmed) as StreamJsonEvent;
      } catch {
        log.debug(`claude-cli: non-JSON line skipped: ${trimmed.slice(0, 200)}`);
        return;
      }
      // 1) assistant 메시지의 content 블록에서 텍스트 추출 (실제 Claude CLI stream-json 포맷)
      if (event.type === 'assistant' && event.message?.content) {
        for (const c of event.message.content) {
          if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) {
            onChunk(c.text);
            emittedAny = true;
          }
        }
        return;
      }
      // 2) 레거시/단순 포맷: {type: 'text', text: '...'}
      if (event.type === 'text' && typeof event.text === 'string') {
        onChunk(event.text);
        emittedAny = true;
        return;
      }
      // 3) result 이벤트 — 에러면 여기서 전달, chunk를 못 받았다면 result.result를 마지막 청크로 보냄
      if (event.type === 'result') {
        if (event.is_error) {
          errored = true;
          onError(new Error(event.error?.message ?? event.result ?? 'Claude CLI 오류'));
          return;
        }
        if (!emittedAny && typeof event.result === 'string' && event.result.length > 0) {
          onChunk(event.result);
          emittedAny = true;
        }
        return;
      }
      // 4) 독립 error 이벤트
      if (event.type === 'error') {
        errored = true;
        onError(new Error(event.error?.message ?? 'Claude CLI 오류'));
      }
    };

    proc.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString('utf-8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    proc.stderr.on('data', (data: Buffer) => {
      log.warn(`claude-cli[stderr]: ${data.toString('utf-8').trim()}`);
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      errored = true;
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
      if (lineBuffer.length > 0) {
        handleLine(lineBuffer);
        lineBuffer = '';
      }
      if (aborted) {
        log.info('claude-cli: aborted by user');
        return;
      }
      if (errored) return;
      if (code === 0) onDone();
      else onError(new Error(`claude exited with code ${code ?? 'null'}`));
    });

    try {
      proc.stdin.write(prompt, 'utf-8');
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
