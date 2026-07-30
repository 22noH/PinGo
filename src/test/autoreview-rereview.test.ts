// src/test/autoreview-rereview.test.ts
// 자동 재리뷰 트리거 — "지난 리뷰 이후 새로 해결된 스레드가 있을 때만" 이 지켜지는지.
// 이 가드가 느슨해지면 폴링(30초)마다 팀이 보는 MR 에 AI 댓글이 쌓인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newlyResolved, resolvedIds } from '../main/auto-review';
import type { Discussion } from '../shared/types';

const thread = (id: string, resolved: boolean | undefined): Discussion => ({
  id, resolved, notes: [],
} as unknown as Discussion);

test('지난 리뷰 이후 새로 해결된 스레드를 잡아낸다', () => {
  const now = resolvedIds([thread('a', true), thread('b', true), thread('c', false)]);
  assert.deepEqual(now, ['a', 'b']);
  assert.deepEqual(newlyResolved(['a'], now), ['b'], 'b 가 새로 해결됨');
});

test('해결 상태에 변화가 없으면 재리뷰 안 함 — 폴링마다 댓글이 쌓이지 않아야 한다', () => {
  assert.deepEqual(newlyResolved(['a', 'b'], ['a', 'b']), []);
});

test('스레드를 다시 열어(unresolve) 개수가 줄어도 재리뷰 안 함', () => {
  assert.deepEqual(newlyResolved(['a', 'b'], ['a']), []);
});

test('리뷰 이력이 없으면 재리뷰 경로 아님 (첫 리뷰가 담당)', () => {
  assert.deepEqual(newlyResolved(undefined, ['a', 'b']), []);
});

test('resolved 가 undefined 인 일반 코멘트는 해결로 치지 않는다', () => {
  assert.deepEqual(resolvedIds([thread('x', undefined)]), []);
});

test('Pingo 자기 리뷰 스레드 해결은 트리거가 아니다 — 무한루프 방지', () => {
  const own = {
    id: 'p', resolved: true,
    notes: [{ id: '1', body: '🤖 **Pingo 자동 AI 리뷰**\n\n지적...' }],
  } as unknown as Discussion;
  assert.deepEqual(resolvedIds([own, thread('h', true)]), ['h'], '사람 스레드만 트리거');
  assert.deepEqual(newlyResolved([], resolvedIds([own])), [], '자기 댓글 해결 → 재리뷰 없음');
});

// ── 지적 없음 판정 ─────────────────────────────────────────
import { isCleanReview } from '../main/auto-review/clean';

test('✅ 머지 가능 단독이면 깨끗한 리뷰 — 봇이 해결/승인까지 한다', () => {
  assert.equal(isCleanReview('## 종합 평가\n문제 없음. ✅ 머지 가능\n\n## 🐛 버그 위험\n- 없음'), true);
});

test('⚠️/❌ 가 섞이면 깨끗하지 않다 — 사람이 판단', () => {
  assert.equal(isCleanReview('✅ 머지 가능\n다만 ⚠️ 수정 권장'), false);
  assert.equal(isCleanReview('❌ 수정 필요'), false);
  assert.equal(
    isCleanReview('머지 가능 여부: ✅ 머지 가능 / ⚠️ 수정 권장 / ❌ 수정 필요'),
    false,
    '양식 선택지를 그대로 복사한 출력은 판정 불가 → 승인 안 함',
  );
  assert.equal(isCleanReview('## 종합 평가\n괜찮습니다'), false, '판정 표기 없으면 승인 안 함');
});

// ── 리뷰 대상 범위 ─────────────────────────────────────────
import type { ReviewItemSummary } from '../shared/types';

const item = (projectId: number, itemId: number, branch: string): ReviewItemSummary => ({
  id: `cfg::gitlab::${projectId}::${itemId}`,
  gitConfigId: 'cfg', providerType: 'gitlab', providerLabel: 'GL', itemId,
  title: '', description: '',
  author: { id: 1, name: 'a', username: 'a', avatar_url: '' },
  reviewers: [], viewerIsReviewer: true, webUrl: '',
  sourceBranch: branch, targetBranch: 'main', projectId,
  createdAt: '', updatedAt: '',
});
import { isReviewTarget } from '../main/auto-review';
import type { GitLabConfig } from '../shared/types';

const cfg: GitLabConfig = { type: 'gitlab', id: 'cfg', url: 'http://x', token: 't', userId: 15 };
const mine = { ...item(38, 1, 'b'), author: { id: 15, name: 'me', username: 'me', avatar_url: '' } };
// 남이 쓰고 나는 리뷰어도 아닌 MR — viewerIsReviewer 를 반드시 false 로 둬야 '남의 MR' 이 된다
const others = {
  ...item(38, 2, 'b'),
  author: { id: 99, name: 'x', username: 'x', avatar_url: '' },
  viewerIsReviewer: false,
};
const assignedToMe = { ...others, viewerIsReviewer: true };

test("기본('mine'): 내 MR 과 내가 리뷰어인 MR 만", () => {
  assert.equal(isReviewTarget(undefined, cfg, mine), true);
  assert.equal(isReviewTarget('mine', cfg, assignedToMe), true);
  assert.equal(isReviewTarget('mine', cfg, others), false, '남의 MR 은 제외');
});

test("'all': 남의 MR 도 대상", () => {
  assert.equal(isReviewTarget('all', cfg, others), true);
  assert.equal(isReviewTarget('all', cfg, mine), true);
});
