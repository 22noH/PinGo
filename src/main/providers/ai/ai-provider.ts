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
   * 프롬프트를 스트리밍으로 실행. onChunk 는 여러 번, onDone / onError 중 하나만 최종 호출.
   *
   * @param onDone finalText 가 오면 그것이 최종 본문이다 — 도구를 쓰는 CLI 는 진행 서술까지
   *   청크로 내보내므로, 스트리밍한 텍스트와 다를 수 있다. 없으면 청크 합이 본문.
   * @param cwd CLI 계열 provider 의 작업 디렉터리 — 자동 리뷰가 클론한 저장소를 넘겨
   *   AI 가 diff 밖 파일까지 읽게 한다. API 계열(anthropic/openai/ollama)은 무시.
   * @param system 역할·언어·양식 지시문. CLI 는 시스템 프롬프트에 덧붙이고(자체 시스템 프롬프트에
   *   밀리지 않게), API 계열은 system 메시지 또는 프롬프트 앞머리로 보낸다.
   */
  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: (finalText?: string) => void,
    onError: (err: Error) => void,
    cwd?: string,
    system?: string,
  ): AIStreamHandle;

  /** CLI 설치 확인 / API 키 ping / Ollama 모델 목록 조회 */
  testAvailability(): Promise<AIAvailabilityTestResult>;
}

/** system 을 프롬프트 앞에 붙인다 — 시스템 메시지를 따로 못 보내는 provider 용 */
export function withSystem(prompt: string, system?: string): string {
  return system ? `${system}\n\n${prompt}` : prompt;
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
