// providers/git/gitlab-scope.ts — 이 GitLab 연결이 "어느 프로젝트까지" 보는지 결정한다.
//
// 프로젝트/그룹 액세스 토큰도 GitLab 안에서는 봇 사용자라, 전역 `/merge_requests?scope=all` 을 부르면
// 인스턴스의 internal/public 프로젝트 MR 이 전부 잡힌다(댓글도 달 수 있다). 그래서 토큰이 봇이면
// 봇이 멤버인 프로젝트로 범위를 고정하고, 개인 토큰은 설정(projectScope)을 따른다.
//
// 범위를 못 구하면 넓히지 않고 실패한다 — 폴링 한 번 건너뛰는 편이 남의 프로젝트에 댓글 다는 것보다 낫다.
import {
  GITLAB_OPEN_ITEMS_MAX_PAGES,
  GITLAB_OPEN_ITEMS_PER_PAGE,
  GITLAB_PER_PROJECT_POLL_MAX,
  GITLAB_SCOPE_PROJECT_MAX_PAGES,
  GITLAB_SCOPE_TTL_MS,
} from '../../../shared/constants';
import type {
  GitLabConfig, GitLabTokenKind, GitProjectScopeMode, GitScopeProject,
} from '../../../shared/types';

/** axios 인스턴스의 필요한 부분만 — 테스트에서 가짜로 갈아끼우기 위함 */
export interface ScopeClient {
  get<T>(
    url: string,
    opts?: { params?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<{ data: T; headers?: unknown }>;
}

export interface GitLabScope {
  tokenKind: GitLabTokenKind;
  userId: number;
  username: string;
  /** 토큰 사용자가 멤버인 프로젝트 (설정 UI 표시·선택용) */
  memberProjects: GitScopeProject[];
  /** 실제로 볼 프로젝트. null = 제한 없음(개인 토큰 + 'all') */
  projects: GitScopeProject[] | null;
}

interface RawUser { id: number; username: string; bot?: boolean }
interface RawProject { id: number; path_with_namespace: string }

const PROJECT_PAGE_SIZE = 100;
const BOT_USERNAME = /^(project|group)_\d+_bot/;

/** 프로젝트/그룹 액세스 토큰의 봇 사용자인지 — bot 필드가 없는 구버전은 사용자명으로 판별 */
export function isBotUser(user: RawUser): boolean {
  return user.bot === true || BOT_USERNAME.test(user.username);
}

export function pickScopeProjects(
  kind: GitLabTokenKind,
  mode: GitProjectScopeMode | undefined,
  selectedIds: number[] | undefined,
  member: GitScopeProject[],
): GitScopeProject[] | null {
  if (kind === 'project') return member; // 설정과 무관하게 고정
  if (mode === 'all') return null;
  if (mode === 'selected') {
    const picked = new Set(selectedIds ?? []);
    return member.filter((p) => picked.has(p.id));
  }
  return member;
}

export function isProjectInScope(scope: GitLabScope, projectId: number): boolean {
  return scope.projects === null || scope.projects.some((p) => p.id === projectId);
}

async function fetchMemberProjects(client: ScopeClient, signal?: AbortSignal): Promise<GitScopeProject[]> {
  const out: GitScopeProject[] = [];
  for (let page = 1; page <= GITLAB_SCOPE_PROJECT_MAX_PAGES; page += 1) {
    const res = await client.get<RawProject[]>('/projects', {
      params: { membership: true, simple: true, order_by: 'last_activity_at', sort: 'desc', per_page: PROJECT_PAGE_SIZE, page },
      signal,
    });
    out.push(...res.data.map((p) => ({ id: p.id, path: p.path_with_namespace })));
    if (res.data.length < PROJECT_PAGE_SIZE) break;
  }
  return out;
}

/** 캐시 없이 토큰을 조사한다 — 연결 테스트용 */
export async function inspectGitLabScope(
  client: ScopeClient,
  config: GitLabConfig,
  signal?: AbortSignal,
): Promise<GitLabScope> {
  const user = (await client.get<RawUser>('/user', { signal })).data;
  const memberProjects = await fetchMemberProjects(client, signal);
  const tokenKind: GitLabTokenKind = isBotUser(user) ? 'project' : 'personal';
  return {
    tokenKind,
    userId: user.id,
    username: user.username,
    memberProjects,
    projects: pickScopeProjects(tokenKind, config.projectScope, config.selectedProjectIds, memberProjects),
  };
}

// ── 캐시 (provider 인스턴스가 여러 곳에서 매번 새로 만들어져서 모듈 수준에 둔다) ──
interface CacheEntry { fingerprint: string; at: number; scope: GitLabScope }
const cache = new Map<string, CacheEntry>();

function fingerprintOf(c: GitLabConfig): string {
  return [c.url, c.token, c.projectScope ?? '', (c.selectedProjectIds ?? []).join(',')].join('|');
}

export async function resolveGitLabScope(
  client: ScopeClient,
  config: GitLabConfig,
  signal?: AbortSignal,
  now: number = Date.now(),
): Promise<GitLabScope> {
  const fingerprint = fingerprintOf(config);
  const hit = cache.get(config.id);
  const same = hit !== undefined && hit.fingerprint === fingerprint;
  if (same && now - hit.at < GITLAB_SCOPE_TTL_MS) return hit.scope;
  try {
    const scope = await inspectGitLabScope(client, config, signal);
    cache.set(config.id, { fingerprint, at: now, scope });
    return scope;
  } catch (err) {
    // 갱신 실패 — 같은 설정의 직전 범위가 있으면 그대로 쓴다(넓어지지 않는다). 없으면 실패.
    if (same) return hit.scope;
    cache.delete(config.id);
    throw err;
  }
}

/** 동기 조회 — 폴링이 한 번이라도 돌았으면 값이 있다 (자동 리뷰 대상 판정용) */
export function peekGitLabScope(configId: string): GitLabScope | undefined {
  return cache.get(configId)?.scope;
}

export function clearGitLabScopeCache(configId?: string): void {
  if (configId === undefined) cache.clear();
  else cache.delete(configId);
}

async function fetchOpenPages<T>(client: ScopeClient, url: string, signal?: AbortSignal): Promise<T[]> {
  // 페이지를 따라간다 — 한 페이지만 보면 오래된 열린 MR 이 목록에서 빠져 자동 리뷰가 영영 안 잡히고,
  // 캐시까지 정리돼 다시 보일 때 중복 리뷰가 달린다.
  const all: T[] = [];
  for (let page = 1; page <= GITLAB_OPEN_ITEMS_MAX_PAGES; page += 1) {
    const res = await client.get<T[]>(url, {
      params: {
        scope: 'all', state: 'opened', order_by: 'updated_at', sort: 'desc',
        per_page: GITLAB_OPEN_ITEMS_PER_PAGE, page,
      },
      signal,
    });
    all.push(...res.data);
    if (res.data.length < GITLAB_OPEN_ITEMS_PER_PAGE) break;
  }
  return all;
}

/**
 * 범위 안의 열린 MR 목록.
 *  - 제한 없음 → 전역 목록
 *  - 프로젝트가 적으면 프로젝트별 조회 (전역 목록 상한에 밀려 누락되지 않게)
 *  - 프로젝트가 많으면 전역 목록을 받아 범위로 거른다
 * 하나라도 실패하면 전체 실패 — 일부만 돌려주면 "닫힌 MR" 로 오인돼 리뷰 캐시가 정리된다.
 */
export async function fetchScopedOpenItems<T extends { project_id: number }>(
  client: ScopeClient,
  configId: string,
  scope: GitLabScope,
  signal?: AbortSignal,
): Promise<T[]> {
  const projects = scope.projects;
  if (projects === null) return fetchOpenPages<T>(client, '/merge_requests', signal);
  if (projects.length === 0) return [];
  if (projects.length > GITLAB_PER_PROJECT_POLL_MAX) {
    const ids = new Set(projects.map((p) => p.id));
    const all = await fetchOpenPages<T>(client, '/merge_requests', signal);
    return all.filter((it) => ids.has(it.project_id));
  }
  try {
    const lists = await Promise.all(
      projects.map((p) => fetchOpenPages<T>(client, `/projects/${p.id}/merge_requests`, signal)),
    );
    return lists.flat();
  } catch (err) {
    // 프로젝트에서 빠졌거나 토큰이 바뀐 경우일 수 있다 — 다음 tick 에 범위부터 다시 구한다
    clearGitLabScopeCache(configId);
    throw err;
  }
}
