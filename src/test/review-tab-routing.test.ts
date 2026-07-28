// src/test/review-tab-routing.test.ts
// 20260728 버그: 탭2에서 리뷰를 돌리고 탭1로 가 있으면 탭2 리뷰가 탭1에 찍혔다.
// 원인은 IPC 이벤트에 itemId 가 없어 "활성 탭"으로 흘려보낸 것 → id 로 탭을 찾아
// 활성/비활성을 구분하는 primitive 를 검증한다. DOM 없이 도는 순수 상태 부분만 대상.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewItemSummary } from '../shared/types';
import { addOrActivate, getById, isActive, getActive } from '../renderer/review/review-tabs';

const item = (iid: number): ReviewItemSummary => ({
  id: `cfg::gitlab::1::${iid}`,
  gitConfigId: 'cfg',
  providerType: 'gitlab',
  providerLabel: 'GL',
  itemId: iid,
  title: `MR ${iid}`,
  description: '',
  author: { id: 1, name: 'a', username: 'a', avatar_url: '' },
  reviewers: [],
  viewerIsReviewer: true,
  webUrl: `https://example.com/mr/${iid}`,
  sourceBranch: `feat/${iid}`,
  targetBranch: 'main',
  projectId: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const A = item(1);
const B = item(2);

test('나중에 연 탭이 활성 — 앞 탭은 비활성으로 남는다', () => {
  addOrActivate(A);
  addOrActivate(B);
  assert.equal(isActive(B.id), true);
  assert.equal(isActive(A.id), false, '탭1은 비활성이어야 한다');
  assert.equal(getActive()?.id, B.id);
});

test('id 로 비활성 탭을 찾을 수 있다 — 이게 없으면 활성 탭으로 잘못 흘러간다', () => {
  const bg = getById(A.id);
  assert.ok(bg, '비활성 탭도 id 로 조회되어야 한다');
  assert.equal(bg.id, A.id);
});

test('비활성 탭 버퍼에 쌓아도 활성 탭 버퍼는 오염되지 않는다', () => {
  const bg = getById(A.id);
  const fg = getById(B.id);
  assert.ok(bg && fg);
  bg.buffer = '';
  fg.buffer = '';
  // onReviewChunk 의 비활성 분기와 같은 동작
  bg.buffer += '## 탭1 리뷰';
  assert.equal(bg.buffer, '## 탭1 리뷰');
  assert.equal(fg.buffer, '', '활성 탭 버퍼가 비어 있어야 한다 — 섞이면 그게 이번 버그');
});

test('없는 id 는 null — 닫힌 탭으로 온 청크는 버려진다', () => {
  assert.equal(getById('cfg::gitlab::1::999'), null);
});
