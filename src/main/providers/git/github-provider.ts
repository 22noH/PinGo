// providers/git/github-provider.ts — GitHub API 구현
import axios, { AxiosError, AxiosInstance, AxiosRequestHeaders } from 'axios';
import log from 'electron-log';
import { PROVIDER_SHORT_LABEL } from '../../../shared/constants';
import type {
  CommentPostResult,
  ConnectionTestResult,
  Discussion,
  DiscussionNote,
  GitHubConfig,
  ItemChange,
  ReviewItemAuthor,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from '../../../shared/types';
import type { GitProvider } from './git-provider';

const GITHUB_API = 'https://api.github.com';

interface GitHubSearchIssueItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: {
    id: number;
    login: string;
    avatar_url: string;
  };
  created_at: string;
  updated_at: string;
  repository_url: string;   // https://api.github.com/repos/{owner}/{repo}
  pull_request?: { url: string };
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchIssueItem[];
}

interface GitHubUserBrief {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
}

interface GitHubPullResponse {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GitHubUserBrief;
  head: { ref: string; sha: string };
  base: {
    ref: string;
    sha: string;
    repo?: { id: number; full_name: string };
  };
  requested_reviewers?: GitHubUserBrief[];
  created_at: string;
  updated_at: string;
}

interface GitHubCommentResponse {
  id: number;
  body: string;
  user: GitHubUserBrief;
  created_at: string;
}

interface GitHubFileItem {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name?: string;
}

function maskHeaders(headers: AxiosRequestHeaders | undefined): Record<string, unknown> {
  if (!headers) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'Authorization' || key === 'PRIVATE-TOKEN') {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function classifyGitHubError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    if (status === 401) return new Error('GitHub 인증 실패 (401): 토큰을 확인하세요');
    if (status === 403) return new Error('GitHub 권한 없음 또는 rate limit (403)');
    if (status === 404) return new Error('GitHub 리소스 없음 (404)');
    if (status === 429) return new Error('GitHub rate limit (429)');
    if (status && status >= 500) return new Error(`GitHub 서버 오류 (${status})`);
    return new Error(`GitHub 요청 실패: ${ax.message}`);
  }
  if (err instanceof Error) return err;
  return new Error('알 수 없는 GitHub 오류');
}

/** repository_url "https://api.github.com/repos/octocat/hello-world" → "octocat/hello-world" */
function parseRepoPath(repositoryUrl: string): string {
  const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : '';
}

export class GitHubProvider implements GitProvider {
  readonly config: GitHubConfig;
  private readonly client: AxiosInstance;

  constructor(config: GitHubConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: GITHUB_API,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15_000,
    });
    this.client.interceptors.response.use(
      (res) => res,
      (err: unknown) => {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          const safe = maskHeaders(err.config?.headers as AxiosRequestHeaders | undefined);
          log.warn(
            `github[${this.config.id.slice(0, 8)}]: status=${status ?? 'n/a'} url=${err.config?.url ?? ''}`,
            safe,
          );
        }
        return Promise.reject(err);
      },
    );
  }

  async fetchOpenItems(signal?: AbortSignal): Promise<ReviewItemSummary[]> {
    const username = this.config.username;
    if (!username) return [];

    // review-requested + assignee + author + mentions 합집합 (중복 제거)
    const [reviewReq, assigned, authored, mentioned] = await Promise.all([
      this.searchIssues(`is:pr is:open review-requested:${username}`, signal),
      this.searchIssues(`is:pr is:open assignee:${username}`, signal),
      this.searchIssues(`is:pr is:open author:${username}`, signal),
      this.searchIssues(`is:pr is:open mentions:${username}`, signal),
    ]);

    const map = new Map<number, GitHubSearchIssueItem>();
    for (const it of [...reviewReq, ...assigned, ...authored, ...mentioned]) {
      if (!it.pull_request) continue; // 혹시 issue가 섞이면 제외
      map.set(it.id, it);
    }

    // search 결과는 head/base branch 정보가 없으므로 PR 상세를 병렬 조회
    const items = Array.from(map.values());
    const detailed = await Promise.all(
      items.map(async (it) => {
        const repoPath = parseRepoPath(it.repository_url);
        try {
          const pr = await this.fetchPullDetail(repoPath, it.number, signal);
          return this.normalize(it, repoPath, pr);
        } catch (err) {
          log.warn(`github: pull detail failed ${repoPath}#${it.number}: ${String(err)}`);
          // branch 정보 없이라도 최소 정보로 반환 (원본 search 기반)
          return this.normalize(it, repoPath);
        }
      }),
    );
    return detailed;
  }

  async fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges> {
    const repoPath = item.repoFullName ?? '';
    if (!repoPath) {
      throw new Error('GitHub item missing repoFullName');
    }
    const res = await this.client.get<GitHubFileItem[]>(
      `/repos/${repoPath}/pulls/${item.itemId}/files`,
      { params: { per_page: 100 } },
    );
    const changes: ItemChange[] = res.data.map((f) => ({
      old_path: f.previous_filename ?? f.filename,
      new_path: f.filename,
      diff: f.patch ?? '',
      new_file: f.status === 'added',
      deleted_file: f.status === 'removed',
      renamed_file: f.status === 'renamed',
    }));
    return { ...item, changes };
  }

  async fetchDiscussions(
    item: ReviewItemSummary,
    signal?: AbortSignal,
  ): Promise<Discussion[]> {
    const repoPath = item.repoFullName ?? '';
    if (!repoPath) return [];
    const username = this.config.username;
    const [issueComments, reviewComments] = await Promise.all([
      this.client
        .get<GitHubCommentResponse[]>(
          `/repos/${repoPath}/issues/${item.itemId}/comments`,
          { params: { per_page: 100 }, signal },
        )
        .then((r) => r.data)
        .catch((err): GitHubCommentResponse[] => {
          log.warn(`github: issue comments fetch failed: ${String(err)}`);
          return [];
        }),
      this.client
        .get<GitHubCommentResponse[]>(
          `/repos/${repoPath}/pulls/${item.itemId}/comments`,
          { params: { per_page: 100 }, signal },
        )
        .then((r) => r.data)
        .catch((err): GitHubCommentResponse[] => {
          log.warn(`github: review comments fetch failed: ${String(err)}`);
          return [];
        }),
    ]);

    const toNote = (c: GitHubCommentResponse): DiscussionNote => ({
      id: String(c.id),
      author: {
        id: c.user.id,
        name: c.user.name ?? c.user.login,
        username: c.user.login,
        avatar_url: c.user.avatar_url,
      },
      body: c.body,
      createdAt: c.created_at,
      mentionsCurrentUser: username ? bodyMentions(c.body, username) : false,
    });

    // GitHub 각 comment는 독립 thread로 다룸 (review thread grouping은 추후 개선 가능)
    return [...issueComments, ...reviewComments].map((c) => ({
      id: String(c.id),
      notes: [toNote(c)],
    }));
  }

  async postComment(
    item: ReviewItemSummary,
    body: string,
  ): Promise<CommentPostResult> {
    const repoPath = item.repoFullName ?? '';
    if (!repoPath) {
      return { success: false, error: 'GitHub item missing repoFullName' };
    }
    try {
      const res = await this.client.post<{ id: number }>(
        `/repos/${repoPath}/issues/${item.itemId}/comments`,
        { body },
      );
      log.info(
        `github[${this.config.id.slice(0, 8)}]: comment posted ${repoPath}#${item.itemId} id=${res.data.id}`,
      );
      return { success: true, commentId: String(res.data.id) };
    } catch (err) {
      const msg = classifyGitHubError(err).message;
      log.error(`github: comment post failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  isCurrentUserReviewer(item: ReviewItemSummary): boolean {
    const username = this.config.username?.toLowerCase();
    if (!username) return false;
    return item.reviewers.some((r) => r.username.toLowerCase() === username);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.client.get<GitHubUserResponse>('/user');
      return {
        success: true,
        userId: res.data.id,
        username: res.data.login,
      };
    } catch (err) {
      return { success: false, error: classifyGitHubError(err).message };
    }
  }

  private async searchIssues(
    q: string,
    signal?: AbortSignal,
  ): Promise<GitHubSearchIssueItem[]> {
    const res = await this.client.get<GitHubSearchResponse>('/search/issues', {
      params: { q, per_page: 20, sort: 'updated', order: 'desc' },
      signal,
    });
    return res.data.items;
  }

  private async fetchPullDetail(
    repoPath: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<GitHubPullResponse> {
    const res = await this.client.get<GitHubPullResponse>(
      `/repos/${repoPath}/pulls/${number}`,
      { signal },
    );
    return res.data;
  }

  private normalize(
    search: GitHubSearchIssueItem,
    repoPath: string,
    detail?: GitHubPullResponse,
  ): ReviewItemSummary {
    const authorName = detail?.user.name ?? search.user.login;
    // projectId는 repo DB id (detail.base.repo.id 가 있을 때만). 없으면 search.id (issue/PR id) fallback.
    const projectId = detail?.base.repo?.id ?? search.id;
    const reviewers: ReviewItemAuthor[] = (detail?.requested_reviewers ?? []).map((r) => ({
      id: r.id,
      name: r.name ?? r.login,
      username: r.login,
      avatar_url: r.avatar_url,
    }));
    const myUsername = this.config.username?.toLowerCase();
    const viewerIsReviewer = !!myUsername && reviewers.some((r) => r.username.toLowerCase() === myUsername);
    return {
      id: `${this.config.id}::github::${projectId}::${search.number}`,
      gitConfigId: this.config.id,
      providerType: 'github',
      providerLabel: PROVIDER_SHORT_LABEL.github,
      itemId: search.number,
      title: search.title,
      description: search.body ?? '',
      author: {
        id: search.user.id,
        name: authorName,
        username: search.user.login,
        avatar_url: search.user.avatar_url,
      },
      reviewers,
      viewerIsReviewer,
      webUrl: search.html_url,
      sourceBranch: detail?.head.ref ?? '',
      targetBranch: detail?.base.ref ?? '',
      projectId,
      repoFullName: repoPath,
      createdAt: search.created_at,
      updatedAt: search.updated_at,
    };
  }
}

/** `@username` 멘션 감지 — 앞뒤 단어 경계 고려 */
function bodyMentions(body: string, username: string): boolean {
  if (!username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, 'i');
  return re.test(body);
}
