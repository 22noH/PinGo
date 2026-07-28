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
