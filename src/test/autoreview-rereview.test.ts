// src/test/autoreview-rereview.test.ts
// 자동 재리뷰 트리거 — "지난 리뷰 이후 새로 해결된 스레드가 있을 때만" 이 지켜지는지.
// 이 가드가 느슨해지면 폴링(30초)마다 팀이 보는 MR 에 AI 댓글이 쌓인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyKey } from '../main/auto-review';

// 댓글 없는 resolve 는 GitLab 이 MR updatedAt 을 안 바꾼다 — 그래서 토론은 폴링 tick 마다 본다
// (게이트 없음). 대신 같은 MR 의 검증이 이미 실행/대기 중이면 건너뛴다(auto-review.ts).
test('검증 요청 key 는 전체 리뷰 key 와 다르다 — 서로 덮거나 버리지 않게', () => {
  assert.notEqual(verifyKey('cfg::gitlab::1::42'), 'cfg::gitlab::1::42');
  assert.ok(verifyKey('cfg::gitlab::1::42').startsWith('cfg::gitlab::1::42'));
});

// 검증 대상 판단(어느 스레드를 검증할지)은 auto-review/pending.test.ts 에서 다룬다.
// ── 해결 검증 판정 파싱 ────────────────────────────────────
import { parseVerdict, VERIFY_HEADER } from '../main/auto-review/verify';

test('판정: 해결 → 수용 + 답글', () => {
  const v = parseVerdict('t', '판정: 해결\n사유: null 가드가 추가됨 (a.ts:10)');
  assert.equal(v.fixed, true);
  assert.ok(v.reply.startsWith(VERIFY_HEADER));
});

test('판정: 미해결 → 스레드 다시 연다', () => {
  const v = parseVerdict('t', '판정: 미해결\n사유: b.ts:22 에 같은 패턴이 남아 있음');
  assert.equal(v.fixed, false);
});

test('양식 미준수/변형 표기는 판단 불가 — 사람 판단 존중(수용), 답글로 그 사실을 남긴다', () => {
  assert.equal(parseVerdict('t', '해결된 것 같습니다.').fixed, null);
  assert.equal(parseVerdict('t', '판정: 해결되지 않음').fixed, null, '부정 표기는 해결로 오판하지 않는다');
  assert.equal(parseVerdict('t', '판정: 해결 안 됨').fixed, null);
  assert.equal(parseVerdict('t', '').fixed, null);
  assert.match(parseVerdict('t', '').reply, /판단 불가/, '출력이 비어도 답글은 남긴다');
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
