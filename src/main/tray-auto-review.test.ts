// main/tray-auto-review.test.ts — 트레이 "자동 리뷰" 서브메뉴: 뭘 하고 있고 뭐가 끝났는지가 라벨로 보이는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoReviewMenu, formatElapsed } from './tray-auto-review';
import type { AutoReviewStatus } from './auto-review/status';
import type { ReviewItemSummary } from '../shared/types';

const item = (itemId: number, title: string): ReviewItemSummary => ({
  id: `cfg::gitlab::1::${itemId}`,
  gitConfigId: 'cfg', providerType: 'gitlab', providerLabel: 'GL', itemId, title, description: '',
  author: { id: 1, name: 'a', username: 'a', avatar_url: '' },
  reviewers: [], viewerIsReviewer: true, webUrl: `https://x/mr/${itemId}`,
  sourceBranch: 'b', targetBranch: 'main', projectId: 1, createdAt: '', updatedAt: '',
});

const NOW = 1_000_000_000;

test('formatElapsed: 초/분/시간', () => {
  assert.equal(formatElapsed(5_000), '5초');
  assert.equal(formatElapsed(125_000), '2분');
  assert.equal(formatElapsed(3_700_000), '1시간 1분');
});

test('아무것도 없으면 메뉴를 만들지 않는다', () => {
  const status: AutoReviewStatus = { active: [], queued: [], recent: [] };
  assert.equal(buildAutoReviewMenu(status, NOW, () => undefined), null);
});

test('진행 중: MR 번호·제목·단계·경과 시간이 한 줄에 보인다', () => {
  const status: AutoReviewStatus = {
    active: [{ item: item(426, 'feat: login refactor'), kind: 'review', phase: 'AI 리뷰', startedAt: NOW - 125_000 }],
    queued: [],
    recent: [],
  };
  const menu = buildAutoReviewMenu(status, NOW, () => undefined)!;
  assert.match(menu.label ?? '', /자동 리뷰 1건 진행 중/);
  const labels = (menu.submenu as Array<{ label?: string }>).map((m) => m.label ?? '');
  assert.ok(labels.some((l) => l.includes('#426') && l.includes('feat: login refactor') && l.includes('AI 리뷰') && l.includes('2분')), labels.join('\n'));
});

test('대기열: 검증/리뷰 종류와 순번이 보이고, 상단 라벨에 대기 수가 들어간다', () => {
  const status: AutoReviewStatus = {
    active: [{ item: item(1, 'a'), kind: 'review', phase: '클론 중', startedAt: NOW }],
    queued: [
      { item: item(2, 'b'), kind: 'verify' },
      { item: item(3, 'c'), kind: 'review' },
    ],
    recent: [],
  };
  const menu = buildAutoReviewMenu(status, NOW, () => undefined)!;
  assert.match(menu.label ?? '', /대기 2/);
  const labels = (menu.submenu as Array<{ label?: string }>).map((m) => m.label ?? '');
  assert.ok(labels.some((l) => l.includes('#2') && l.includes('해결 검증')), labels.join('\n'));
  assert.ok(labels.some((l) => l.includes('#3') && l.includes('전체 리뷰')), labels.join('\n'));
});

test('최근 결과: 성공/실패 표시와 요약, 클릭하면 MR 을 연다', () => {
  const opened: string[] = [];
  const status: AutoReviewStatus = {
    active: [],
    queued: [],
    recent: [
      { item: item(9, 'z'), kind: 'verify', ok: true, summary: '검증: 해결 확인 1', at: NOW - 60_000 },
      { item: item(8, 'y'), kind: 'review', ok: false, summary: 'git fetch 실패', at: NOW - 600_000 },
    ],
  };
  const menu = buildAutoReviewMenu(status, NOW, (it) => { opened.push(it.id); })!;
  assert.match(menu.label ?? '', /최근 결과 2건/);
  const sub = menu.submenu as Array<{ label?: string; click?: () => void }>;
  const ok = sub.find((m) => (m.label ?? '').includes('#9'))!;
  assert.match(ok.label ?? '', /✅.*해결 확인 1.*1분 전/);
  const bad = sub.find((m) => (m.label ?? '').includes('#8'))!;
  assert.match(bad.label ?? '', /❌.*git fetch 실패.*10분 전/);
  bad.click?.();
  assert.deepEqual(opened, ['cfg::gitlab::1::8']);
});
