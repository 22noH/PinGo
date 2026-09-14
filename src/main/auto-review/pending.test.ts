// main/auto-review/pending.test.ts — 검증할 스레드를 캐시가 아니라 MR 토론 자체에서 판단하는지.
//
// 사용자 요구(20260915): "다시 실행" 은 리뷰 댓글이 이미 있으면 전체 리뷰를 다시 달지 말고
// 해결된 스레드의 검증 댓글을 달아야 한다. 리뷰 댓글이 한 번도 없으면 리뷰를 단다.
// 자동 경로도 같은 판단을 쓴다 — 캐시 유실/재설치/두 스레드 순차 해결 모두 견딘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingVerifications } from './pending';
import { COMMENT_HEADER } from './clean';
import { VERIFY_HEADER } from './verify';
import type { Discussion, DiscussionNote } from '../../shared/types';

const note = (body: string, createdAt: string): DiscussionNote =>
  ({ id: body.slice(0, 8), body, createdAt, author: { id: 1, name: 'x', username: 'x', avatar_url: '' }, mentionsCurrentUser: false });
const thread = (id: string, notes: DiscussionNote[], resolved?: boolean, resolvedAt?: string): Discussion =>
  ({ id, notes, resolved, resolvedAt });

const REVIEW_AT = '2026-09-15T10:00:00Z';
const review = (id = 'rv', body = `${COMMENT_HEADER}\n\n## 종합 평가\n⚠️ 수정 권장`, resolved = false, resolvedAt?: string): Discussion =>
  thread(id, [note(body, REVIEW_AT)], resolved, resolvedAt);

test('Pingo 리뷰 댓글이 없으면 reviewed=false — 호출측이 전체 리뷰를 단다', () => {
  const r = pendingVerifications([thread('h', [note('사람 댓글', REVIEW_AT)], true, '2026-09-15T11:00:00Z')]);
  assert.equal(r.reviewed, false);
  assert.deepEqual(r.threadIds, []);
});

test('리뷰 이후 해결된 스레드(검증 댓글 없음)가 검증 대상', () => {
  const r = pendingVerifications([
    review(),
    thread('a', [note('지적 A', REVIEW_AT)], true, '2026-09-15T11:00:00Z'),
    thread('b', [note('지적 B', REVIEW_AT)], true, '2026-09-15T12:00:00Z'),
    thread('c', [note('아직', REVIEW_AT)], false),
  ]);
  assert.equal(r.reviewed, true);
  assert.deepEqual(r.threadIds, ['a', 'b'], '둘 다 — 하나가 먼저 검증됐어도 나머지는 남는다');
});

test('사람이 해결한 Pingo 리뷰 스레드 자체도 검증 대상 (지적 고쳤다는 핵심 신호)', () => {
  const r = pendingVerifications([review('rv', undefined, true, '2026-09-15T11:00:00Z')]);
  assert.deepEqual(r.threadIds, ['rv']);
});

test('지적 없는 리뷰를 봇이 스스로 해결한 스레드는 대상이 아니다 — 무한루프 방지', () => {
  const clean = review('rv', `${COMMENT_HEADER}\n\n## 종합 평가\n문제 없음 ✅ 머지 가능`, true, '2026-09-15T10:00:05Z');
  assert.deepEqual(pendingVerifications([clean]).threadIds, []);
});

test('리뷰 이전에 이미 해결돼 있던 스레드는 대상이 아니다 — 옛 스레드에 봇 답글이 달리지 않게', () => {
  const r = pendingVerifications([
    review(),
    thread('old', [note('예전 지적', '2026-09-01T00:00:00Z')], true, '2026-09-02T00:00:00Z'),
  ]);
  assert.deepEqual(r.threadIds, []);
});

test('리뷰가 여러 번이면 마지막 리뷰 시각 기준', () => {
  const r = pendingVerifications([
    review('rv1'),
    thread('rv2', [note(`${COMMENT_HEADER}\n\n재리뷰`, '2026-09-15T12:00:00Z')], false),
    thread('a', [note('지적', REVIEW_AT)], true, '2026-09-15T11:00:00Z'), // 재리뷰 전 해결 → 재리뷰가 다뤘다
    thread('b', [note('지적', REVIEW_AT)], true, '2026-09-15T13:00:00Z'),
  ]);
  assert.deepEqual(r.threadIds, ['b']);
});

test('수용된 검증 댓글(해결 확인/판단 불가)이 있으면 대상이 아니다', () => {
  const done = thread('a', [note('지적', REVIEW_AT), note(`${VERIFY_HEADER}\n\n판정: 해결`, '2026-09-15T11:30:00Z')], true, '2026-09-15T11:00:00Z');
  const unknown = thread('b', [note('지적', REVIEW_AT), note(`${VERIFY_HEADER}\n\n⚠️ 판단 불가`, '2026-09-15T11:30:00Z')], true, '2026-09-15T11:00:00Z');
  assert.deepEqual(pendingVerifications([review(), done, unknown]).threadIds, []);
});

test('마지막 검증이 미해결이었고 다시 닫혔으면 다시 검증', () => {
  const again = thread('a', [note('지적', REVIEW_AT), note(`${VERIFY_HEADER}\n\n판정: 미해결`, '2026-09-15T11:30:00Z')], true, '2026-09-15T12:00:00Z');
  assert.deepEqual(pendingVerifications([review(), again]).threadIds, ['a']);
});

test('해결 시각을 모르는 스레드(resolvedAt 없음)는 대상이 아니다', () => {
  assert.deepEqual(pendingVerifications([review(), thread('a', [note('지적', REVIEW_AT)], true)]).threadIds, []);
});
