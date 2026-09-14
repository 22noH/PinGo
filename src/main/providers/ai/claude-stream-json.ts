// providers/ai/claude-stream-json.ts — Claude CLI `--output-format stream-json` 파싱 (순수 로직)
//
// 도구를 허용하고 돌리면(자동 리뷰: 클론 디렉터리에서 Read/Grep/git) CLI 는 도구 호출 사이의
// 진행 서술("I'll start by looking at…")도 assistant 텍스트로 내보낸다. 이걸 전부 이어 붙이면
// 리뷰 댓글 앞머리에 영어 서술이 붙는다(20260914 리포트). result 이벤트의 텍스트가 최종 답변이므로
// 스트리밍은 그대로 하되, 완료 시점엔 finalText() 를 리뷰 본문으로 쓴다.

interface ContentBlock {
  type: string;
  text?: string;
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  text?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  error?: { message?: string };
}

export interface StreamJsonParser {
  /** stdout 한 줄 처리 */
  handleLine(line: string): void;
  /** result 이벤트의 최종 텍스트 — 아직 안 왔으면 undefined */
  finalText(): string | undefined;
  /** 지금까지 onChunk 로 내보낸 텍스트 전체 */
  streamedText(): string;
  /** 에러 이벤트가 있었는지 */
  errored(): boolean;
}

export function createStreamJsonParser(cb: {
  onChunk: (text: string) => void;
  onError: (err: Error) => void;
  /** JSON 이 아닌 줄 (디버그 로그용, 선택) */
  onSkip?: (line: string) => void;
}): StreamJsonParser {
  let streamed = '';
  let final: string | undefined;
  let errored = false;

  const emit = (text: string): void => {
    streamed += text;
    cb.onChunk(text);
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(trimmed) as StreamJsonEvent;
    } catch {
      cb.onSkip?.(trimmed);
      return;
    }
    // 1) assistant 메시지의 content 블록에서 텍스트 추출 (실제 Claude CLI stream-json 포맷)
    if (event.type === 'assistant' && event.message?.content) {
      for (const c of event.message.content) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) emit(c.text);
      }
      return;
    }
    // 2) 레거시/단순 포맷: {type: 'text', text: '...'}
    if (event.type === 'text' && typeof event.text === 'string') {
      emit(event.text);
      return;
    }
    // 3) result — 에러면 전달, 아니면 최종 텍스트 확보. 청크가 없었다면 그것을 유일한 청크로.
    if (event.type === 'result') {
      if (event.is_error) {
        errored = true;
        cb.onError(new Error(event.error?.message ?? event.result ?? 'Claude CLI 오류'));
        return;
      }
      if (typeof event.result === 'string' && event.result.length > 0) {
        final = event.result;
        if (streamed.length === 0) emit(event.result);
      }
      return;
    }
    // 4) 독립 error 이벤트
    if (event.type === 'error') {
      errored = true;
      cb.onError(new Error(event.error?.message ?? 'Claude CLI 오류'));
    }
  };

  return {
    handleLine,
    finalText: () => final,
    streamedText: () => streamed,
    errored: () => errored,
  };
}
