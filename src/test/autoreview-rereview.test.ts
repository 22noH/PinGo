// src/test/autoreview-rereview.test.ts
// 자동 재리뷰 트리거 — "지난 리뷰 이후 새로 해결된 스레드가 있을 때만" 이 지켜지는지.
// 이 가드가 느슨해지면 폴링(30초)마다 팀이 보는 MR 에 AI 댓글이 쌓인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newlyResolved, resolvedIds, verifyKey } from '../main/auto-review';
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

// 댓글 없는 resolve 는 GitLab 이 MR updatedAt 을 안 바꾼다 — 그래서 토론은 폴링 tick 마다 본다
// (게이트 없음). 대신 같은 MR 의 검증이 이미 실행/대기 중이면 건너뛴다(auto-review.ts).
test('검증 요청 key 는 전체 리뷰 key 와 다르다 — 서로 덮거나 버리지 않게', () => {
  assert.notEqual(verifyKey('cfg::gitlab::1::42'), 'cfg::gitlab::1::42');
  assert.ok(verifyKey('cfg::gitlab::1::42').startsWith('cfg::gitlab::1::42'));
});

test('resolved 가 undefined 인 일반 코멘트는 해결로 치지 않는다', () => {
  assert.deepEqual(resolvedIds([thread('x', undefined)]), []);
});

// 무한루프 방지의 실제 메커니즘 (전체 재리뷰는 더 이상 없다):
//  1) 해결 감지 → 전체 리뷰가 아니라 그 스레드의 "해결 검증" 만 돌고, 결과는 스레드 답글.
//     새 resolvable 스레드가 안 생기므로 해결 → 리뷰 → 해결 반복이 원천적으로 없다.
//  2) 봇이 settleClean/검증 수용으로 처리한 스레드 id 는 캐시에 기록 → 다시 트리거 안 됨.
test('봇 자체 해결(캐시에 기록됨)은 검증 트리거가 아니다 — 무한루프 방지', () => {
  const own = thread('p', true); // 봇이 settleClean 으로 해결 → postOne 이 'p' 를 캐시에 기록
  assert.deepEqual(newlyResolved(['p'], resolvedIds([own])), [], '기록된 자체 해결 → 검증 없음');
});

test('사람이 스레드를 해결하면 그 스레드만 검증 대상이 된다 — 지적 고침 신호', () => {
  const own = thread('p', true); // 사람이 해결 → 캐시에 기록 없음
  assert.deepEqual(resolvedIds([own, thread('h', true)]), ['p', 'h'], 'Pingo 스레드도 트리거 대상');
  assert.deepEqual(newlyResolved([], ['p']), ['p'], '기록에 없는 해결 → 검증');
});

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

// ── 재해결 감지 ─────────────────────────────────────────────
// 한 번 검증돼 수용된 스레드를 사람이 다시 열었다 닫으면 다시 검증돼야 한다(20260914 리포트).
// id 만 기억하면 영영 안 잡힌다 — GitLab 노트 resolved_at 이 재해결마다 바뀌므로 그걸 기준으로 본다.
import { pruneUnresolved, seedResolvedAt, threadsToVerify } from '../main/auto-review';

const at = (id: string, resolved: boolean, resolvedAt?: string): Discussion =>
  ({ id, resolved, resolvedAt, notes: [] } as unknown as Discussion);

test('기록에 없는 해결 → 검증 (기존 동작)', () => {
  assert.deepEqual(threadsToVerify({ resolvedThreadIds: [] }, [at('a', true, 't1')]), ['a']);
});

test('수용된 스레드를 다시 열었다 닫으면(resolvedAt 변경) 다시 검증', () => {
  const entry = { resolvedThreadIds: ['a'], resolvedAt: { a: 't1' } };
  assert.deepEqual(threadsToVerify(entry, [at('a', true, 't1')]), [], '같은 해결이면 안 함');
  assert.deepEqual(threadsToVerify(entry, [at('a', true, 't2')]), ['a'], '재해결이면 함');
});

test('resolvedAt 을 모르는 provider(GitHub) 는 id 기준으로만 판단', () => {
  const entry = { resolvedThreadIds: ['a'] };
  assert.deepEqual(threadsToVerify(entry, [at('a', true)]), []);
});

test('리뷰 이력은 있지만 기준이 없으면(구버전 캐시) 검증 대상 없음', () => {
  assert.deepEqual(threadsToVerify({}, [at('a', true, 't1')]), []);
});

test('다시 열린 스레드는 기록에서 빠진다 — 이후 닫으면 새 해결로 잡힌다', () => {
  const entry = { resolvedThreadIds: ['a', 'b'], resolvedAt: { a: 't1', b: 't1' } };
  const pruned = pruneUnresolved(entry, [at('a', false), at('b', true, 't1')]);
  assert.deepEqual(pruned.resolvedThreadIds, ['b']);
  assert.deepEqual(pruned.resolvedAt, { b: 't1' });
  assert.deepEqual(threadsToVerify(pruned, [at('a', true, 't2'), at('b', true, 't1')]), ['a']);
});

test('구버전 캐시(resolvedAt 없음)는 현재 해결 시각으로 기준을 채운다 — 이후 재해결부터 잡힌다', () => {
  const entry = { resolvedThreadIds: ['a', 'b'] };
  const seeded = seedResolvedAt(entry, [at('a', true, 't1'), at('b', true), at('c', true, 't9')]);
  assert.deepEqual(seeded.resolvedAt, { a: 't1' }, '알려진 id 중 시각이 있는 것만');
  assert.deepEqual(threadsToVerify(seeded, [at('a', true, 't2'), at('b', true)]), ['a']);
});

// 사용자 결정(20260914): 수용된 검증 댓글이 이미 달린 스레드는 다시 열었다 닫아도 재검증하지 않는다.
// 검증 댓글이 없거나(게시 실패) 마지막 판정이 미해결이면 닫을 때마다 검증한다.
import { hasAcceptedVerification } from '../main/auto-review/verify';

const withNotes = (d: Discussion, bodies: string[]): Discussion =>
  ({ ...d, notes: bodies.map((body, i) => ({ id: String(i), body, author: { id: 1, name: 'bot', username: 'b', avatar_url: '' }, createdAt: '', mentionsCurrentUser: false })) } as Discussion);

test('수용된 검증 댓글(해결 확인/판단 불가)이 있으면 재해결해도 검증 안 함', () => {
  const entry = { resolvedThreadIds: ['a'], resolvedAt: { a: 't1' } };
  const ok = withNotes(at('a', true, 't2'), ['지적', `${VERIFY_HEADER}\n\n판정: 해결\n사유: 고침`]);
  assert.equal(hasAcceptedVerification(ok), true);
  assert.deepEqual(threadsToVerify(entry, [ok]), []);
  const unknown = withNotes(at('a', true, 't2'), ['지적', `${VERIFY_HEADER}\n\n⚠️ 판단 불가 — 읽지 못함`]);
  assert.equal(hasAcceptedVerification(unknown), true);
  assert.deepEqual(threadsToVerify({ resolvedThreadIds: [] }, [unknown]), [], '기록에 없어도 댓글이 있으면 안 함');
});

test('검증 댓글이 없거나 마지막 판정이 미해결이면 닫을 때마다 검증', () => {
  const entry = { resolvedThreadIds: ['a'], resolvedAt: { a: 't1' } };
  const none = withNotes(at('a', true, 't2'), ['지적', '사람 댓글']);
  assert.equal(hasAcceptedVerification(none), false);
  assert.deepEqual(threadsToVerify(entry, [none]), ['a']);
  const unresolved = withNotes(at('a', true, 't2'), ['지적', `${VERIFY_HEADER}\n\n판정: 미해결\n사유: 남음`]);
  assert.equal(hasAcceptedVerification(unresolved), false);
  assert.deepEqual(threadsToVerify(entry, [unresolved]), ['a']);
  const fixedLater = withNotes(at('a', true, 't2'), [`${VERIFY_HEADER}\n\n판정: 미해결`, `${VERIFY_HEADER}\n\n판정: 해결`]);
  assert.equal(hasAcceptedVerification(fixedLater), true, '마지막 검증 댓글 기준');
});
