// src/test/autoreview-rereview.test.ts
// 자동 재리뷰 트리거 — "새 커밋이 푸시됐을 때만" 이 지켜지는지.
// 이 가드가 느슨해지면 폴링(30초)마다 팀이 보는 MR 에 AI 댓글이 쌓인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasNewCommits } from '../main/auto-review';

test('새 커밋이 들어오면 재리뷰', () => {
  assert.equal(hasNewCommits({ headSha: 'aaa111' }, { headSha: 'bbb222' }), true);
});

test('같은 커밋이면 재리뷰 안 함 — 폴링마다 댓글이 쌓이지 않아야 한다', () => {
  assert.equal(hasNewCommits({ headSha: 'aaa111' }, { headSha: 'aaa111' }), false);
});

test('리뷰 이력이 없으면 재리뷰 경로 아님 (첫 리뷰가 담당)', () => {
  assert.equal(hasNewCommits(undefined, { headSha: 'aaa111' }), false);
});

test('SHA 를 모르면 판단 불가 → 재리뷰 안 함', () => {
  assert.equal(hasNewCommits({ headSha: undefined }, { headSha: 'bbb222' }), false,
    '캐시에 SHA 가 없으면 비교 불가');
  assert.equal(hasNewCommits({ headSha: 'aaa111' }, { headSha: undefined }), false,
    '아이템에 SHA 가 없으면 비교 불가');
  assert.equal(hasNewCommits({}, {}), false);
});

// ── 클론 폴더 이름 충돌 ─────────────────────────────────────
// 동시 리뷰 상한이 5 라 최대 5개가 같은 작업 폴더 안에서 병렬로 클론된다.
// MR 번호는 프로젝트마다 따로 매겨지므로 번호만으로는 갈리지 않는다.
import { worktreeLabel } from '../main/auto-review';
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

test('다른 프로젝트의 같은 MR 번호·같은 브랜치는 다른 폴더를 쓴다', () => {
  const a = worktreeLabel(item(38, 42, 'feature/x'));
  const b = worktreeLabel(item(99, 42, 'feature/x'));
  assert.notEqual(a, b, '같으면 동시 클론이 서로를 덮어쓴다');
});

test('같은 MR 은 같은 폴더 — 재리뷰 시 덮어쓰기', () => {
  assert.equal(worktreeLabel(item(38, 42, 'feature/x')), worktreeLabel(item(38, 42, 'feature/x')));
});

test('동시 5건은 서로 다른 폴더', () => {
  const labels = [101, 102, 103, 104, 105].map((n) => worktreeLabel(item(38, n, 'feat/a')));
  assert.equal(new Set(labels).size, 5);
});

// ── 리뷰 대상 범위 ─────────────────────────────────────────
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
