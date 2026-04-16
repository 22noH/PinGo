// providers/ai/openai-api.ts — openai SDK 기반 스트리밍
import OpenAI from 'openai';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  OpenAIAPIConfig,
} from '../../../shared/types';
import { DEFAULT_OPENAI_BASE_URL } from '../../../shared/constants';
import type { AIProvider, AIStreamHandle } from './ai-provider';

/**
 * OpenAI 호환 Chat Completions API 를 공식 SDK(`openai`)로 호출.
 * `baseUrl` 지정 시 Azure OpenAI / OpenRouter / Groq 등 호환 엔드포인트 사용 가능.
 *
 * 스트리밍: `chat.completions.create({ stream: true })` 가 `AsyncIterable<ChatCompletionChunk>` 반환.
 * abort: `AbortController` 전달 → `controller.abort()` 로 즉시 중단.
 */
export class OpenAIAPIProvider implements AIProvider {
  readonly config: OpenAIAPIConfig;
  private client: OpenAI;

  constructor(config: OpenAIAPIConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: (config.baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, ''),
    });
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle {
    const controller = new AbortController();
    let aborted = false;
    let settled = false;

    const run = async (): Promise<void> => {
      try {
        const stream = await this.client.chat.completions.create(
          {
            model: this.config.model,
            stream: true,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal: controller.signal },
        );
        for await (const chunk of stream) {
          if (aborted) return;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            onChunk(delta);
          }
        }
        if (aborted || settled) return;
        settled = true;
        onDone();
      } catch (err) {
        if (aborted || settled) return;
        settled = true;
        const e = err instanceof Error ? err : new Error(String(err));
        onError(e);
      }
    };

    void run();

    return {
      abort: (): void => {
        if (settled) return;
        aborted = true;
        settled = true;
        try {
          controller.abort();
        } catch (err) {
          log.debug(`openai-api: abort error: ${String(err)}`);
        }
        log.info('openai-api: aborted');
      },
    };
  }

  async testAvailability(): Promise<AIAvailabilityTestResult> {
    if (!this.config.apiKey) {
      return { success: false, error: 'API 키가 비어 있습니다' };
    }
    try {
      // SDK 의 models.list() 로 API 키/엔드포인트 유효성 확인
      await this.client.models.list();
      return { success: true, version: this.config.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}
