// providers/ai/anthropic-api.ts — @anthropic-ai/sdk 기반 스트리밍
import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import type {
  AIAvailabilityTestResult,
  AnthropicAPIConfig,
} from '../../../shared/types';
import type { AIProvider, AIStreamHandle } from './ai-provider';

/**
 * Anthropic Messages API 를 공식 SDK(`@anthropic-ai/sdk`)로 호출.
 * SDK 의 `messages.stream()` 이벤트:
 *   - 'text'  → delta 텍스트
 *   - 'end'   → 정상 종료
 *   - 'error' → 스트림 오류
 *
 * abort: `stream.controller.abort()` 사용 (AbortController 통합 지원).
 */
export class AnthropicAPIProvider implements AIProvider {
  readonly config: AnthropicAPIConfig;
  private client: Anthropic;

  constructor(config: AnthropicAPIConfig) {
    this.config = config;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle {
    let aborted = false;
    let settled = false;
    const stream = this.client.messages.stream({
      model: this.config.model,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    stream.on('text', (textDelta: string): void => {
      if (aborted || settled) return;
      onChunk(textDelta);
    });

    stream.on('end', (): void => {
      if (aborted || settled) return;
      settled = true;
      onDone();
    });

    stream.on('error', (err: unknown): void => {
      if (aborted || settled) return;
      settled = true;
      const e = err instanceof Error ? err : new Error(String(err));
      onError(e);
    });

    return {
      abort: (): void => {
        if (settled) return;
        aborted = true;
        settled = true;
        try {
          stream.controller.abort();
        } catch (err) {
          log.debug(`anthropic-api: abort error: ${String(err)}`);
        }
        log.info('anthropic-api: aborted');
      },
    };
  }

  async testAvailability(): Promise<AIAvailabilityTestResult> {
    if (!this.config.apiKey) {
      return { success: false, error: 'API 키가 비어 있습니다' };
    }
    try {
      // 최소 ping — SDK 가 HTTP 레벨 에러(401/403 등)를 예외로 throw 해줌
      await this.client.messages.create({
        model: this.config.model || 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { success: true, version: this.config.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}
