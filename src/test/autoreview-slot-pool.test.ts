// src/test/autoreview-slot-pool.test.ts
// 슬롯 대여/반납 — 여기가 틀리면 두 리뷰가 같은 폴더에서 동시에 checkout 해 서로를 망친다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  leaseSlot, markProvisioned, poolStatus, resetPools,
} from '../main/auto-review/slot-pool';

beforeEach(() => resetPools());

test('상한까지는 새 슬롯을 만들고, 서로 다른 폴더를 준다', async () => {
  const a = await leaseSlot('p38', '/base', 2);
  const b = await leaseSlot('p38', '/base', 2);
  assert.notEqual(a.dir, b.dir, '동시에 쓰는 두 리뷰가 같은 폴더면 안 된다');
  assert.equal(a.dir, '/base/p38/slot-0');
  assert.equal(b.dir, '/base/p38/slot-1');
  assert.deepEqual(poolStatus('p38'), { total: 2, busy: 2, waiting: 0 });
});

test('상한을 넘으면 반납될 때까지 기다린다', async () => {
  const a = await leaseSlot('p38', '/base', 1);
  let got: string | null = null;
  const pending = leaseSlot('p38', '/base', 1).then((l) => { got = l.dir; return l; });

  await Promise.resolve();
  assert.equal(got, null, '반납 전에는 대여되면 안 된다');
  assert.equal(poolStatus('p38').waiting, 1);

  a.release();
  const b = await pending;
  assert.equal(b.dir, a.dir, '반납된 슬롯을 물려받는다');
  assert.equal(poolStatus('p38').waiting, 0);
});

test('반납된 슬롯은 재사용 — 새로 만들지 않는다', async () => {
  const a = await leaseSlot('p38', '/base', 5);
  markProvisioned('p38', a.dir);
  a.release();
  const b = await leaseSlot('p38', '/base', 5);
  assert.equal(b.dir, a.dir);
  assert.equal(b.fresh, false, 'clone 된 슬롯이면 다시 clone 하지 않는다');
  assert.equal(poolStatus('p38').total, 1);
});

test('clone 안 된 슬롯은 fresh — 호출측이 clone 해야 한다', async () => {
  const a = await leaseSlot('p38', '/base', 5);
  assert.equal(a.fresh, true);
});

test('이미 clone 된 슬롯을 우선 배정한다', async () => {
  const a = await leaseSlot('p38', '/base', 2);   // slot-0
  const b = await leaseSlot('p38', '/base', 2);   // slot-1
  markProvisioned('p38', b.dir);                   // slot-1 만 clone 완료
  a.release();
  b.release();
  const next = await leaseSlot('p38', '/base', 2);
  assert.equal(next.dir, b.dir, 'clone 된 슬롯을 먼저 줘야 400초를 아낀다');
  assert.equal(next.fresh, false);
});

test('프로젝트가 다르면 슬롯을 공유하지 않는다', async () => {
  const a = await leaseSlot('p38', '/base', 1);
  const b = await leaseSlot('p99', '/base', 1);
  assert.notEqual(a.dir, b.dir);
  assert.equal(b.dir, '/base/p99/slot-0');
});

test('이중 반납해도 슬롯이 두 번 풀리지 않는다', async () => {
  const a = await leaseSlot('p38', '/base', 1);
  a.release();
  a.release();
  assert.equal(poolStatus('p38').busy, 0);
  const b = await leaseSlot('p38', '/base', 1);
  assert.equal(poolStatus('p38').busy, 1, '한 슬롯이 두 번 대여되면 안 된다');
  b.release();
});

test('대기는 FIFO', async () => {
  const a = await leaseSlot('p38', '/base', 1);
  const order: string[] = [];
  const first = leaseSlot('p38', '/base', 1).then((l) => { order.push('first'); return l; });
  const second = leaseSlot('p38', '/base', 1).then((l) => { order.push('second'); return l; });

  a.release();
  (await first).release();
  await second;
  assert.deepEqual(order, ['first', 'second']);
});
