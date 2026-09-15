// main/auto-review/verify.test.ts — 판정 파싱이 AI 출력 변형에 견디는지, 판단 불가도 답글로 드러나는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, VERIFY_HEADER } from './verify';

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

// ── 게시 실패는 수용이 아니다 ──────────────────────────────
// 답글을 못 달았는데 수용으로 기록하면 그 스레드는 댓글 없이 영영 남는다(20260914 리포트).
// 실패로 던져서 오케스트레이터가 이력에 남기고, 백오프 후 다시 검증·게시하게 한다.
import { postVerdicts } from './verify';
import type Store from 'electron-store';
import type { GitProvider } from '../providers/git/git-provider';
import type { ReviewItemSummary, StoreSchema } from '../../shared/types';

const ITEM = {
  id: 'cfg::gitlab::1::7', gitConfigId: 'cfg', providerType: 'gitlab', providerLabel: 'GL', itemId: 7,
  title: '', description: '', author: { id: 1, name: 'a', username: 'a', avatar_url: '' },
  reviewers: [], viewerIsReviewer: true, webUrl: '', sourceBranch: 'b', targetBranch: 'main',
  projectId: 1, createdAt: '', updatedAt: '',
} as ReviewItemSummary;

function fakeStore(): { store: Store<StoreSchema>; cache: () => Record<string, { resolvedThreadIds?: string[] }> } {
  const data: Record<string, unknown> = { reviewCache: { [ITEM.id]: { markdown: '', updatedAt: '', resolvedThreadIds: [] } } };
  const store = {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => { data[k] = v; },
  } as unknown as Store<StoreSchema>;
  return { store, cache: () => data.reviewCache as Record<string, { resolvedThreadIds?: string[] }> };
}

test('답글 게시 실패 → 수용하지 않고 실패로 던진다 (다음 검증에서 다시 시도)', async () => {
  const provider = {
    postReply: () => Promise.reject(new Error('403 forbidden')),
  } as unknown as GitProvider;
  const { store, cache } = fakeStore();
  await assert.rejects(
    () => postVerdicts(provider, ITEM, [{ threadId: 't', fixed: true, reply: 'r' }], store),
    /403 forbidden/,
  );
  assert.deepEqual(cache()[ITEM.id].resolvedThreadIds, [], '실패한 스레드는 기록되지 않는다');
});

test('일부만 실패하면 성공한 것은 수용하고, 실패는 던진다', async () => {
  let calls = 0;
  const provider = {
    postReply: () => { calls += 1; return calls === 1 ? Promise.resolve({ success: true }) : Promise.reject(new Error('timeout')); },
  } as unknown as GitProvider;
  const { store, cache } = fakeStore();
  await assert.rejects(() => postVerdicts(provider, ITEM, [
    { threadId: 'ok', fixed: true, reply: 'r' },
    { threadId: 'bad', fixed: true, reply: 'r' },
  ], store), /timeout/);
  assert.deepEqual(cache()[ITEM.id].resolvedThreadIds, ['ok']);
});
