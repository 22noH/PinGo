// main/poller-unavailable.test.ts — 404 를 "이 항목엔 없는 기능" 으로 기억해 매 tick 재시도·로그 반복을 막는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnavailableTracker, errorSummary, httpStatus } from './poller-unavailable';

const axiosLike = (status: number, message = `Request failed with status code ${status}`): Error =>
  Object.assign(new Error(message), { name: 'AxiosError', isAxiosError: true, response: { status } });

test('httpStatus: axios 응답 상태를 읽고, 없으면 undefined', () => {
  assert.equal(httpStatus(axiosLike(404)), 404);
  assert.equal(httpStatus(new Error('network')), undefined);
  assert.equal(httpStatus('문자열'), undefined);
});

test('404 한 번 → 이후 같은 key 는 skip, 첫 번째만 true(로그 1회용)', () => {
  const t = createUnavailableTracker();
  assert.equal(t.has('k'), false);
  assert.equal(t.markIfNotFound('k', axiosLike(404)), true, '처음 404: 기억하고 true');
  assert.equal(t.has('k'), true);
  assert.equal(t.markIfNotFound('k', axiosLike(404)), false, '이미 기억된 key: false');
});

test('404 가 아닌 오류는 기억하지 않는다 — 일시 장애는 다음 tick 에 재시도', () => {
  const t = createUnavailableTracker();
  assert.equal(t.markIfNotFound('k', axiosLike(500)), false);
  assert.equal(t.markIfNotFound('k', new Error('timeout')), false);
  assert.equal(t.has('k'), false);
});

test('key 별로 독립', () => {
  const t = createUnavailableTracker();
  t.markIfNotFound('a', axiosLike(404));
  assert.equal(t.has('b'), false);
});

test('errorSummary: 메시지만 한 줄로, 객체 덤프 없이', () => {
  const s = errorSummary(axiosLike(503));
  assert.equal(s, 'Request failed with status code 503');
  assert.equal(errorSummary('raw'), 'raw');
  assert.ok(errorSummary(new Error('x'.repeat(500))).length <= 200, '길이 상한');
});
