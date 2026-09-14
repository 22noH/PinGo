// src/test/autoreview-repo-context.test.ts
// 클론 배선 검증: 저장소가 클론되면 (1) 프롬프트가 파일 열람 허용 모드로 바뀌고
// (2) cwd 가 AI provider 까지 전달되어야 한다. 둘 중 하나라도 끊기면 clone 이 무의미해진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewItemWithChanges } from '../shared/types';
import type { AIProvider, AIStreamHandle } from '../main/providers/ai/ai-provider';
import { buildPrompt, runReview } from '../main/review-runner';

const ITEM: ReviewItemWithChanges = {
  id: 'cfg::gitlab::1::42',
  gitConfigId: 'cfg',
  providerType: 'gitlab',
  providerLabel: 'GL',
  itemId: 42,
  title: 'test',
  description: '',
  author: { id: 1, name: 'a', username: 'a', avatar_url: '' },
  reviewers: [],
  viewerIsReviewer: true,
  webUrl: 'https://example.com/mr/42',
  sourceBranch: 'feat/x',
  targetBranch: 'main',
  projectId: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  changes: [{
    old_path: 'a.ts', new_path: 'a.ts', diff: '+const a = 1;',
    new_file: false, deleted_file: false, renamed_file: false,
  }],
};

test('clone 있음 → 프롬프트가 파일 직접 열람을 지시한다', () => {
  const withRepo = buildPrompt(ITEM, undefined, true);
  assert.ok(withRepo.system.includes('저장소가 클론되어'), '클론 안내가 있어야 한다');
  assert.ok(!withRepo.system.includes('diff 만으로 리뷰하세요'), 'diff 전용 제한이 남아 있으면 안 된다');
});

test('clone 없음 → 기존 diff 전용 지침 유지', () => {
  const diffOnly = buildPrompt(ITEM);
  assert.ok(diffOnly.system.includes('diff 만으로 리뷰하세요'));
  assert.ok(!diffOnly.system.includes('저장소가 클론되어'));
});

// 지시문(역할·한국어·양식)은 system, MR 내용(diff)은 user 로 나뉘어야 한다.
// 전부 user 로 보내면 CLI 자체 시스템 프롬프트(영어·간결체)에 밀려 영어 리뷰가 나온다(20260914 리포트).
test('프롬프트 분리: 지시문은 system, diff 는 user', () => {
  const p = buildPrompt(ITEM, undefined, true);
  assert.ok(p.system.includes('한국어'), 'system 에 언어 규칙');
  assert.ok(p.system.includes('## 종합 평가'), 'system 에 양식');
  assert.ok(p.system.includes('진행 서술'), '도구 사용 중 진행 서술 금지 규칙');
  assert.ok(p.user.includes('+const a = 1;'), 'user 에 diff');
  assert.ok(!p.user.includes('시니어 코드 리뷰어'), 'user 에 지시문이 섞이지 않는다');
});

test('runReview: system 프롬프트가 AI provider 로 전달된다', () => {
  let seenSystem: string | undefined;
  const fake: AIProvider = {
    config: { type: 'claude-cli' },
    streamReview: (_p, _c, onDone, _e, _cwd, system): AIStreamHandle => {
      seenSystem = system;
      onDone();
      return { abort: (): void => undefined };
    },
    testAvailability: () => Promise.resolve({ success: true }),
  };
  runReview(fake, { system: 'SYS', user: 'USER' }, () => undefined, () => undefined, () => undefined);
  assert.equal(seenSystem, 'SYS');
});

test('runReview: cwd 가 AI provider 로 전달된다', () => {
  let seen: string | undefined = 'not-called';
  const fake: AIProvider = {
    config: { type: 'claude-cli' },
    streamReview: (_p, _c, onDone, _e, cwd): AIStreamHandle => {
      seen = cwd;
      onDone();
      return { abort: (): void => undefined };
    },
    testAvailability: () => Promise.resolve({ success: true }),
  };
  runReview(fake, { system: 's', user: 'p' }, () => undefined, () => undefined, () => undefined, '/tmp/pingo-review-x');
  assert.equal(seen, '/tmp/pingo-review-x');
});
