// providers/ai/claude-stream-json.test.ts — stream-json 파싱: 도구 사용 중 진행 서술을 리뷰 본문으로
// 잘못 잇지 않고, result 의 최종 텍스트를 리뷰로 삼는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamJsonParser } from './claude-stream-json';

const ev = (o: unknown): string => JSON.stringify(o);
const assistantText = (text: string): string =>
  ev({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function harness() {
  const chunks: string[] = [];
  const errors: string[] = [];
  const parser = createStreamJsonParser({
    onChunk: (t) => { chunks.push(t); },
    onError: (e) => { errors.push(e.message); },
  });
  return { parser, chunks, errors };
}

test('assistant 텍스트는 스트리밍 청크로 내보낸다', () => {
  const h = harness();
  h.parser.handleLine(assistantText('## 종합 평가'));
  h.parser.handleLine(assistantText('\n문제 없음'));
  assert.deepEqual(h.chunks, ['## 종합 평가', '\n문제 없음']);
  assert.equal(h.errors.length, 0);
});

test('도구 사용 뒤 최종 답변이 오면 result 의 텍스트가 최종본이다 (진행 서술 제외)', () => {
  const h = harness();
  h.parser.handleLine(assistantText("I'll start by looking at the controller file."));
  h.parser.handleLine(ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }));
  h.parser.handleLine(ev({ type: 'user', message: { content: [{ type: 'tool_result' }] } }));
  h.parser.handleLine(assistantText('## 종합 평가\n✅ 머지 가능'));
  h.parser.handleLine(ev({ type: 'result', subtype: 'success', result: '## 종합 평가\n✅ 머지 가능' }));
  assert.equal(h.parser.finalText(), '## 종합 평가\n✅ 머지 가능');
  assert.equal(h.parser.streamedText(), "I'll start by looking at the controller file.## 종합 평가\n✅ 머지 가능");
});

test('도구 사용 없이 끝나면 최종본과 스트리밍 텍스트가 같다', () => {
  const h = harness();
  h.parser.handleLine(assistantText('리뷰 본문'));
  h.parser.handleLine(ev({ type: 'result', subtype: 'success', result: '리뷰 본문' }));
  assert.equal(h.parser.finalText(), '리뷰 본문');
  assert.equal(h.parser.streamedText(), '리뷰 본문');
});

test('청크가 하나도 없었으면 result 텍스트를 청크로 내보낸다', () => {
  const h = harness();
  h.parser.handleLine(ev({ type: 'result', subtype: 'success', result: '늦게 온 본문' }));
  assert.deepEqual(h.chunks, ['늦게 온 본문']);
});

test('result 가 에러면 onError', () => {
  const h = harness();
  h.parser.handleLine(ev({ type: 'result', is_error: true, result: '한도 초과' }));
  assert.deepEqual(h.errors, ['한도 초과']);
  assert.equal(h.parser.errored(), true);
});

test('JSON 이 아닌 줄과 빈 줄은 무시한다', () => {
  const h = harness();
  h.parser.handleLine('');
  h.parser.handleLine('not json');
  assert.equal(h.chunks.length, 0);
  assert.equal(h.errors.length, 0);
});
