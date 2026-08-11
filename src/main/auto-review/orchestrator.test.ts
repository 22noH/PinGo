// main/auto-review/orchestrator.test.ts — 동시 한도·대기열(무제한)·즉시 댓글·resolved 감지 검증.
// 프레임워크 없이 Node 내장 러너로 실행: `npm test` → tsc 빌드 후 `node --test dist/main/auto-review/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoReviewOrchestrator,
  isResolved,
  reviewableDiscussions,
  type AutoReviewRequest,
} from './orchestrator';
import type { Discussion } from '../../shared/types';

/** 외부에서 resolve 할 수 있는 promise — runReview 를 임의 시점까지 붙잡아 둔다. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

/** key 별로 runReview 완료 시점을 수동 제어하는 오케스트레이터 + 훅 기록. */
function harness(max: number) {
  const gates = new Map<string, ReturnType<typeof deferred<string>>>();
  const posted: Array<{ key: string; result: string }> = [];
  const orch = new AutoReviewOrchestrator<void, string>({
    maxConcurrent: max,
    runReview: (req) => {
      const d = deferred<string>();
      gates.set(req.key, d);
      return d.promise;
    },
    postResult: (req, result) => {
      posted.push({ key: req.key, result });
      return Promise.resolve();
    },
  });
  const submit = (key: string) => orch.submit({ key, payload: undefined });
  /** 해당 key 의 runReview 를 완료시키고 후속 처리(postResult/drain)까지 흘려보낸다. */
  const finish = async (key: string, result = `r:${key}`) => {
    gates.get(key)!.resolve(result);
    await tick();
    await tick();
  };
  return { orch, submit, finish, posted };
}

test('동시 한도: max 개까지만 실행하고 초과는 대기열로', () => {
  const h = harness(5);
  for (let i = 0; i < 8; i++) h.submit(`k${i}`);
  assert.equal(h.orch.activeCount, 5, '실행 슬롯은 정확히 max');
  assert.equal(h.orch.queuedCount, 3, '초과분은 대기열');
});

test('대기열: 완료 시 하나씩 꺼내 순차 처리', async () => {
  const h = harness(5);
  for (let i = 0; i < 7; i++) h.submit(`k${i}`); // 5 active, 2 queued
  await h.finish('k0');
  assert.equal(h.orch.activeCount, 5, '빈 슬롯을 대기열에서 하나 채움');
  assert.equal(h.orch.queuedCount, 1, '대기열에서 하나만 빠짐');
});

test('즉시 댓글: 리뷰 완료 즉시 postResult 로 결과 게시', async () => {
  const h = harness(5);
  h.submit('k0');
  assert.equal(h.posted.length, 0, '완료 전에는 게시 없음');
  await h.finish('k0', 'REVIEW');
  assert.deepEqual(h.posted, [{ key: 'k0', result: 'REVIEW' }]);
});

test('대기열 무제한: 상한 초과 요청도 버려지지 않고 전부 처리된다', async () => {
  const h = harness(2);
  for (let i = 0; i < 12; i++) h.submit(`k${i}`); // 2 active, 10 queued — 유실 없음
  assert.equal(h.orch.queuedCount, 10, '초과분 전부 대기열에 남는다');
  for (let i = 0; i < 12; i++) await h.finish(`k${i}`);
  assert.equal(h.posted.length, 12, '모든 요청이 결국 리뷰/게시된다');
  assert.equal(h.orch.queuedCount, 0);
});

test('중복 방지: 실행 중 key 재요청은 무시, 대기 중 key 재요청은 순번 유지·payload 만 교체', () => {
  const h = harness(5);
  for (let i = 0; i < 10; i++) h.submit(`k${i}`); // queue=[k5,k6,k7,k8,k9]
  h.submit('k0'); // active 재요청 → 무시
  assert.equal(h.orch.activeCount, 5);
  assert.equal(h.orch.queuedCount, 5);
  h.submit('k5'); // 대기 중 재요청 → 중복 추가 없음
  assert.equal(h.orch.queuedCount, 5, '대기 중 재요청은 개수를 늘리지 않는다');
});

test('resolved 감지(B안): resolved 스레드만 리뷰 대상에서 제외', () => {
  const d = (id: string, resolved?: boolean): Discussion => ({ id, notes: [], resolved });
  assert.equal(isResolved(d('a', true)), true);
  assert.equal(isResolved(d('b', false)), false);
  assert.equal(isResolved(d('c', undefined)), false, '일반 코멘트(undefined)는 미해결 취급');

  const kept = reviewableDiscussions([d('a', true), d('b', false), d('c', undefined)]);
  assert.deepEqual(
    kept.map((x) => x.id),
    ['b', 'c'],
    'resolved=true 만 제외, 미해결/일반은 포함',
  );
});

// AutoReviewRequest 타입 참조 유지 (import 사용 확인)
export type _Req = AutoReviewRequest<void>;
