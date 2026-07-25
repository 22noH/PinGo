// src/test/autoreview-concurrency.test.ts
// 설정값(autoReviewConcurrency) → 저장 → 오케스트레이터 동시 상한 반영 검증.
// 순수 로직만 대상 — Electron/IPC 불필요. `npm test` 로 실행.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAutoReviewConcurrency,
  createAutoReviewOrchestrator,
  type AutoReviewRequest,
} from '../main/auto-review/orchestrator';
import { DEFAULT_AUTO_REVIEW_CONCURRENCY } from '../shared/constants';

test('resolveAutoReviewConcurrency: 저장된 값을 그대로 읽는다', () => {
  assert.equal(resolveAutoReviewConcurrency({ autoReviewConcurrency: 3 }), 3);
});

test('resolveAutoReviewConcurrency: 미설정/비정상 값은 기본값', () => {
  assert.equal(resolveAutoReviewConcurrency({}), DEFAULT_AUTO_REVIEW_CONCURRENCY);
  assert.equal(resolveAutoReviewConcurrency({ autoReviewConcurrency: 0 }), DEFAULT_AUTO_REVIEW_CONCURRENCY);
});

test('설정 변경 → 저장값이 동시 실행 상한으로 반영된다', async () => {
  // 저장된 설정을 흉내 (UI 슬라이더가 2로 저장한 상태)
  const savedSettings = { autoReviewConcurrency: 2 };

  const deferreds: Array<() => void> = [];
  let posted = 0;
  let resolveDone: () => void;
  const allDone = new Promise<void>((r) => { resolveDone = r; });

  const orch = createAutoReviewOrchestrator<number, string>(savedSettings, {
    runReview: (_req: AutoReviewRequest<number>) =>
      new Promise<string>((resolve) => { deferreds.push(() => resolve('ok')); }),
    postResult: () => {
      posted += 1;
      if (posted === 4) resolveDone();
      return Promise.resolve();
    },
  });

  // 4건 제출 — 상한 2 이므로 2건만 실행, 2건 대기
  for (let i = 0; i < 4; i++) orch.submit({ key: `k${i}`, payload: i });
  assert.equal(orch.activeCount, 2, '동시 상한 2를 넘지 않아야 한다');
  assert.equal(orch.queuedCount, 2, '초과분은 대기열로');

  // 실행 중인 것들을 순차 완료 → 대기열이 슬롯을 채워야 한다
  while (deferreds.length > 0) {
    const done = deferreds.shift();
    done?.();
    await Promise.resolve(); // finally/drain 마이크로태스크 플러시
    await Promise.resolve();
    assert.ok(orch.activeCount <= 2, '드레인 중에도 상한을 넘지 않아야 한다');
  }

  await allDone;
  assert.equal(posted, 4, '4건 모두 처리되어야 한다');
  assert.equal(orch.activeCount, 0);
  assert.equal(orch.queuedCount, 0);
});
