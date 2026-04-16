// providers/ai/claude-cli.ts — Claude CLI 스트리밍 실행 (stream-json)
import { spawn, spawnSync } from 'child_process';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  ClaudeCLIConfig,
} from '../../../shared/types';
import { CLAUDE_INSTALL_URL } from '../../../shared/constants';
import type { AIProvider, AIStreamHandle } from './ai-provider';

interface StreamJsonEvent {
  type: 'text' | 'tool_use' | 'message_stop' | 'error' | string;
  text?: string;
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
    const execPath = this.config.execPath ?? 'claude';
    log.info(`claude-cli: spawning ${execPath}`);

    const proc = spawn(
      execPath,
      ['-p', '--output-format', 'stream-json', '--verbose'],
      { stdio: ['pipe', 'pipe', 'pipe'], shell: false },
    );

    let aborted = false;
    let errored = false;
    let lineBuffer = '';

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
      if (event.type === 'text' && typeof event.text === 'string') {
        onChunk(event.text);
      } else if (event.type === 'error') {
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
    const execPath = this.config.execPath ?? 'claude';
    try {
      const res = spawnSync(execPath, ['--version'], {
        timeout: 5_000,
        encoding: 'utf-8',
      });
      if (res.error) {
        const err = res.error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return {
            success: false,
            error: `Claude CLI가 설치되지 않았습니다. ${CLAUDE_INSTALL_URL} 에서 설치하세요.`,
          };
        }
        return { success: false, error: err.message };
      }
      if (res.status !== 0) {
        return { success: false, error: `exit code ${res.status ?? 'null'}` };
      }
      const version = (res.stdout || '').trim() || 'unknown';
      return { success: true, version };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}
