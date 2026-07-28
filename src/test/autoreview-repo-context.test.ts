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
  assert.ok(withRepo.includes('저장소가 클론되어'), '클론 안내가 있어야 한다');
  assert.ok(!withRepo.includes('diff 만으로 리뷰하세요'), 'diff 전용 제한이 남아 있으면 안 된다');
});

test('clone 없음 → 기존 diff 전용 지침 유지', () => {
  const diffOnly = buildPrompt(ITEM);
  assert.ok(diffOnly.includes('diff 만으로 리뷰하세요'));
  assert.ok(!diffOnly.includes('저장소가 클론되어'));
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
  runReview(fake, 'p', () => undefined, () => undefined, () => undefined, '/tmp/pingo-review-x');
  assert.equal(seen, '/tmp/pingo-review-x');
});
