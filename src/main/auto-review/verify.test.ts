// main/auto-review/verify.test.ts — 판정 파싱이 AI 출력 변형에 견디는지, 판단 불가도 답글로 드러나는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, unverifiableVerdict, VERIFY_HEADER } from './verify';

test('판정 파싱: 정확한 한 줄', () => {
  assert.equal(parseVerdict('t', '판정: 해결\n사유: 고쳐짐').fixed, true);
  assert.equal(parseVerdict('t', '판정: 미해결\n사유: 남음').fixed, false);
});

test('판정 파싱: 볼드·전각 콜론·접미사·헤딩 변형도 잡는다', () => {
  assert.equal(parseVerdict('t', '**판정: 해결**\n사유: ok').fixed, true);
  assert.equal(parseVerdict('t', '**판정**: 미해결\n사유: 남음').fixed, false);
  assert.equal(parseVerdict('t', '판정： 해결됨\n사유: ok').fixed, true);
  assert.equal(parseVerdict('t', '## 판정: 미해결\n사유: 남음').fixed, false);
  assert.equal(parseVerdict('t', '- 판정: 해결 (원인 제거)\n사유: ok').fixed, true);
});

test('판정 파싱: "해결되지 않음"/"해결 안 됨" 은 해결로 오판하지 않는다', () => {
  assert.equal(parseVerdict('t', '판정: 해결되지 않음').fixed, null);
  assert.equal(parseVerdict('t', '**판정: 해결 안 됨**').fixed, null);
});

test('판정 파싱: 판정 줄이 여러 개면 마지막 것을 쓴다(사고 과정 뒤 최종 판정)', () => {
  const out = '판정: 미해결 인지 확인해보니…\n\n판정: 해결\n사유: 최신 커밋에서 수정됨';
  assert.equal(parseVerdict('t', out).fixed, true);
});

test('판정 파싱: 판정을 못 읽으면 null 이고, 답글에 판단 불가 사유가 드러난다', () => {
  const v = parseVerdict('t', '코드를 확인했으나 애매합니다.');
  assert.equal(v.fixed, null);
  assert.ok(v.reply.startsWith(VERIFY_HEADER));
  assert.match(v.reply, /판단 불가/);
  assert.match(v.reply, /애매합니다/, '원문도 같이 남긴다');
});

test('판정 파싱: 출력이 비어도 판단 불가 답글은 남는다', () => {
  const v = parseVerdict('t', '   ');
  assert.equal(v.fixed, null);
  assert.match(v.reply, /판단 불가/);
});

test('검증 불가(클론 실패): 사람 판단 수용을 답글로 남긴다', () => {
  const v = unverifiableVerdict('t', '저장소 준비 실패');
  assert.equal(v.fixed, null);
  assert.match(v.reply, /저장소 준비 실패/);
  assert.match(v.reply, /수용/);
});
