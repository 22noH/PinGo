// providers/git/gitlab-scope.test.ts — 프로젝트 토큰은 그 프로젝트에만 묶이는지, 범위 조회가 실패하면 넓어지지 않는지.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { GitLabConfig } from '../../../shared/types';
import {
  clearGitLabScopeCache, fetchScopedOpenItems, isBotUser, isProjectInScope,
  peekGitLabScope, pickScopeProjects, resolveGitLabScope, type ScopeClient,
} from './gitlab-scope';

const CFG: GitLabConfig = { type: 'gitlab', id: 'cfg', url: 'https://gl.test', token: 't', userId: 0 };
const P = (id: number): { id: number; path_with_namespace: string } => ({ id, path_with_namespace: `g/p${id}` });

interface Call { url: string; params?: Record<string, unknown> }

/** url → 응답 데이터(또는 던질 에러)를 주는 가짜 클라이언트 */
function fakeClient(routes: Record<string, unknown>): { client: ScopeClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: ScopeClient = {
    get: async <T>(url: string, opts?: { params?: Record<string, unknown> }) => {
      calls.push({ url, params: opts?.params });
      const hit = routes[url];
      if (hit === undefined) throw new Error(`unexpected GET ${url}`);
      if (hit instanceof Error) throw hit;
      return { data: hit as T, headers: {} };
    },
  };
  return { client, calls };
}

beforeEach(() => clearGitLabScopeCache());

test('봇 판별: bot 필드 또는 프로젝트/그룹 봇 사용자명', () => {
  assert.equal(isBotUser({ id: 1, username: 'me', bot: true }), true);
  assert.equal(isBotUser({ id: 1, username: 'project_93_bot_abc123' }), true);
  assert.equal(isBotUser({ id: 1, username: 'group_7_bot' }), true);
  assert.equal(isBotUser({ id: 1, username: '22no' }), false);
  assert.equal(isBotUser({ id: 1, username: 'project_manager', bot: false }), false);
});

test('범위 선택: 프로젝트 토큰은 설정이 all 이어도 멤버 프로젝트로 고정', () => {
  const member = [{ id: 93, path: 'g/p93' }];
  assert.deepEqual(pickScopeProjects('project', 'all', undefined, member), member);
  assert.deepEqual(pickScopeProjects('project', 'selected', [1, 2], member), member);
});

test('범위 선택: 개인 토큰은 기본 멤버, selected 는 멤버 중 고른 것만, all 은 제한 없음', () => {
  const member = [{ id: 1, path: 'a' }, { id: 2, path: 'b' }];
  assert.deepEqual(pickScopeProjects('personal', undefined, undefined, member), member);
  assert.deepEqual(pickScopeProjects('personal', 'selected', [2, 99], member), [{ id: 2, path: 'b' }]);
  assert.equal(pickScopeProjects('personal', 'all', undefined, member), null);
});

test('프로젝트 토큰: 전역 /merge_requests 를 부르지 않고 그 프로젝트만 조회한다', async () => {
  const { client, calls } = fakeClient({
    '/user': { id: 500, username: 'project_93_bot_x', bot: true },
    '/projects': [P(93)],
    '/projects/93/merge_requests': [{ project_id: 93, iid: 1 }],
  });
  const scope = await resolveGitLabScope(client, { ...CFG, projectScope: 'all' });
  assert.equal(scope.tokenKind, 'project');
  assert.deepEqual(scope.projects, [{ id: 93, path: 'g/p93' }]);

  const items = await fetchScopedOpenItems<{ project_id: number; iid: number }>(client, CFG.id, scope);
  assert.deepEqual(items, [{ project_id: 93, iid: 1 }]);
  assert.equal(calls.some((c) => c.url === '/merge_requests'), false, '전역 목록 호출 금지');
  assert.equal(isProjectInScope(scope, 93), true);
  assert.equal(isProjectInScope(scope, 38), false);
});

test('개인 토큰 all: 제한 없이 전역 목록을 쓴다', async () => {
  const { client } = fakeClient({
    '/user': { id: 7, username: '22no', bot: false },
    '/projects': [P(1)],
    '/merge_requests': [{ project_id: 1 }, { project_id: 2 }],
  });
  const scope = await resolveGitLabScope(client, { ...CFG, projectScope: 'all' });
  assert.equal(scope.projects, null);
  const items = await fetchScopedOpenItems<{ project_id: number }>(client, CFG.id, scope);
  assert.equal(items.length, 2);
  assert.equal(isProjectInScope(scope, 12345), true);
});

test('범위 조회 실패: 넓어지지 않고 그대로 실패한다', async () => {
  const { client } = fakeClient({ '/user': new Error('boom') });
  await assert.rejects(resolveGitLabScope(client, CFG));
  assert.equal(peekGitLabScope(CFG.id), undefined);
});

test('캐시: 같은 설정은 다시 조회하지 않고, 토큰이 바뀌면 다시 조회한다', async () => {
  const { client, calls } = fakeClient({
    '/user': { id: 7, username: '22no' },
    '/projects': [P(1)],
  });
  await resolveGitLabScope(client, CFG);
  await resolveGitLabScope(client, CFG);
  assert.equal(calls.filter((c) => c.url === '/user').length, 1);
  await resolveGitLabScope(client, { ...CFG, token: 'other' });
  assert.equal(calls.filter((c) => c.url === '/user').length, 2);
  assert.equal(peekGitLabScope(CFG.id)?.tokenKind, 'personal');
});

test('프로젝트 조회가 하나라도 실패하면 전체 실패 — 일부만 돌려주면 캐시가 잘못 정리된다', async () => {
  const { client } = fakeClient({
    '/user': { id: 7, username: '22no' },
    '/projects': [P(1), P(2)],
    '/projects/1/merge_requests': [{ project_id: 1 }],
    '/projects/2/merge_requests': new Error('403'),
  });
  const scope = await resolveGitLabScope(client, CFG);
  await assert.rejects(fetchScopedOpenItems(client, CFG.id, scope));
  assert.equal(peekGitLabScope(CFG.id), undefined, '실패하면 범위를 다시 조회하도록 캐시를 비운다');
});
