// providers/ai/ollama.ts — Ollama /api/generate NDJSON 스트리밍
import log from 'electron-log';
import type { IncomingMessage } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import type {
  AIAvailabilityTestResult,
  OllamaConfig,
} from '../../../shared/types';
import type { AIProvider, AIStreamHandle } from './ai-provider';

interface OllamaGenerateChunk {
  response?: string;
  done?: boolean;
  error?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

type HttpRequestFn = typeof httpsRequest;

function pickRequest(url: URL): HttpRequestFn {
  return (url.protocol === 'http:' ? httpRequest : httpsRequest) as HttpRequestFn;
}

export class OllamaProvider implements AIProvider {
  readonly config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle {
    const url = new URL(`${this.getBaseUrl()}/api/generate`);
    const body = JSON.stringify({
      model: this.config.model,
      prompt,
      stream: true,
    });

    let aborted = false;
    let errored = false;
    let buffer = '';
    const requestFn = pickRequest(url);

    const req = requestFn(
      {
        method: 'POST',
        host: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          accept: 'application/x-ndjson',
        },
      },
      (res: IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = '';
          res.setEncoding('utf-8');
          res.on('data', (c: string) => { errBody += c; });
          res.on('end', () => {
            errored = true;
            onError(new Error(`Ollama ${res.statusCode}: ${errBody.slice(0, 500)}`));
          });
          return;
        }
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as OllamaGenerateChunk;
              if (parsed.error) {
                errored = true;
                onError(new Error(parsed.error));
                return;
              }
              if (typeof parsed.response === 'string' && parsed.response.length > 0) {
                onChunk(parsed.response);
              }
            } catch {
              log.debug(`ollama: non-JSON line: ${trimmed.slice(0, 200)}`);
            }
          }
        });
        res.on('end', () => {
          if (aborted || errored) return;
          onDone();
        });
        res.on('error', (err: Error) => {
          if (aborted) return;
          errored = true;
          onError(err);
        });
      },
    );

    req.on('error', (err: Error) => {
      if (aborted) return;
      errored = true;
      onError(err);
    });

    req.write(body);
    req.end();

    return {
      abort: (): void => {
        aborted = true;
        req.destroy();
        log.info('ollama: aborted');
      },
    };
  }

  async testAvailability(): Promise<AIAvailabilityTestResult> {
    const models = await this.fetchModels();
    if (!models.success) {
      return { success: false, error: models.error };
    }
    if (this.config.model && models.models && !models.models.includes(this.config.model)) {
      return {
        success: false,
        error: `모델 "${this.config.model}" 이 Ollama에 없습니다. 사용 가능: ${models.models.slice(0, 5).join(', ')}`,
      };
    }
    return { success: true, version: this.config.model || 'unknown' };
  }

  async fetchModels(): Promise<{
    success: boolean;
    models?: string[];
    error?: string;
  }> {
    const url = new URL(`${this.getBaseUrl()}/api/tags`);
    const requestFn = pickRequest(url);
    return new Promise((resolve) => {
      const req = requestFn(
        {
          method: 'GET',
          host: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          headers: { accept: 'application/json' },
          timeout: 5_000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (c: string) => { data += c; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode < 400) {
              try {
                const parsed = JSON.parse(data) as OllamaTagsResponse;
                const models = (parsed.models ?? []).map((m) => m.name);
                resolve({ success: true, models });
              } catch (err) {
                resolve({
                  success: false,
                  error: err instanceof Error ? err.message : 'parse error',
                });
              }
            } else {
              resolve({
                success: false,
                error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}`,
              });
            }
          });
        },
      );
      req.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'timeout' });
      });
      req.end();
    });
  }
}

/** Ollama 모델 목록 조회 — IPC 핸들러에서 baseUrl만으로 호출 */
export async function fetchOllamaModels(
  baseUrl: string,
): Promise<{ success: boolean; models?: string[]; error?: string }> {
  const provider = new OllamaProvider({ type: 'ollama', baseUrl, model: '' });
  return provider.fetchModels();
}
