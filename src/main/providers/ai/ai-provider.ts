// providers/ai/ai-provider.ts — AIProvider interface + factory
import type { AIConfig, AIAvailabilityTestResult } from '../../../shared/types';
import { AnthropicAPIProvider } from './anthropic-api';
import { ClaudeCLIProvider } from './claude-cli';
import { CodexCLIProvider } from './codex-cli';
import { OllamaProvider } from './ollama';
import { OpenAIAPIProvider } from './openai-api';

export interface AIStreamHandle {
  abort(): void;
}

export interface AIProvider {
  readonly config: AIConfig;
  /**
   * 프롬프트를 스트리밍으로 실행. onChunk / onDone / onError 중 정확히 하나만
   * 최종적으로 호출됨. AbortHandle 을 반환.
   */
  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): AIStreamHandle;

  /** CLI 설치 확인 / API 키 ping / Ollama 모델 목록 조회 */
  testAvailability(): Promise<AIAvailabilityTestResult>;
}

export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.type) {
    case 'claude-cli':
      return new ClaudeCLIProvider(config);
    case 'codex-cli':
      return new CodexCLIProvider(config);
    case 'anthropic-api':
      return new AnthropicAPIProvider(config);
    case 'openai-api':
      return new OpenAIAPIProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    default: {
      // exhaustiveness — 새 AIProviderType 추가 시 컴파일 에러로 알림
      const _exhaustive: never = config;
      throw new Error(`Unknown AIConfig.type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
