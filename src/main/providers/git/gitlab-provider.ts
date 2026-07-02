// providers/git/gitlab-provider.ts — GitLab API 구현 (v2 + v3 delegation)
import axios, { AxiosError, AxiosInstance, AxiosRequestHeaders } from 'axios';
import log from 'electron-log';
import { PROVIDER_SHORT_LABEL } from '../../../shared/constants';
import type {
  ApprovalStatus,
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  CommentPostResult,
  CommentReplyPayload,
  ConnectionTestResult,
  Discussion,
  DiscussionNote,
  GitIssue,
  GitLabConfig,
  ItemChange,
  PipelineInfo,
  PipelineRunResult,
  ReviewItemAuthor,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from '../../../shared/types';
import type { GitProvider } from './git-provider';
import * as V3 from './gitlab-provider-v3';

interface GitLabUserBrief {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
}

interface GitLabMRListItem {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  author: GitLabUserBrief;
  web_url: string;
  source_branch: string;
  target_branch: string;
  reviewers?: GitLabUserBrief[];
  project_id: number;
  created_at: string;
  updated_at: string;
}

interface GitLabDiscussionNote {
  id: number;
  body: string;
  author: GitLabUserBrief;
  created_at: string;
  system: boolean;
}

interface GitLabDiscussion {
  id: string;
  notes: GitLabDiscussionNote[];
}

interface GitLabMRChangesResponse extends GitLabMRListItem {
  changes: ItemChange[];
}

interface GitLabUserResponse {
  id: number;
  username: string;
  name: string;
}

function maskHeaders(headers: AxiosRequestHeaders | undefined): Record<string, unknown> {
  if (!headers) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'PRIVATE-TOKEN' || key === 'Authorization') {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

function classifyGitLabError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    if (status === 401) return new Error('GitLab 인증 실패 (401): 토큰을 확인하세요');
    if (status === 403) return new Error('GitLab 권한 없음 (403)');
    if (status === 429) return new Error('GitLab rate limit (429)');
    if (status && status >= 500) return new Error(`GitLab 서버 오류 (${status})`);
    return new Error(`GitLab 요청 실패: ${ax.message}`);
  }
  if (err instanceof Error) return err;
  return new Error('알 수 없는 GitLab 오류');
}

export class GitLabProvider implements GitProvider {
  readonly config: GitLabConfig;
  private readonly client: AxiosInstance;
  private cachedUsername: string | null = null;

  constructor(config: GitLabConfig) {
    this.config = config;
    this.client = axios.create({
      baseURL: `${config.url.replace(/\/$/, '')}/api/v4`,
      headers: { 'PRIVATE-TOKEN': config.token },
      timeout: 15_000,
    });
    this.client.interceptors.response.use(
      (res) => res,
      (err: unknown) => {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          const safe = maskHeaders(err.config?.headers as AxiosRequestHeaders | undefined);
          log.warn(
            `gitlab[${this.config.id.slice(0, 8)}]: status=${status ?? 'n/a'} url=${err.config?.url ?? ''}`,
            safe,
          );
        }
        return Promise.reject(err);
      },
    );
  }

  async fetchOpenItems(signal?: AbortSignal): Promise<ReviewItemSummary[]> {
    // 사용자 필터 없음 — token이 접근 가능한 모든 open MR. "올라오면 무조건 알람".
    // 리뷰어 지정/멘션 감지는 item.reviewers 및 note.mentionsCurrentUser 로 별도 처리.
    const res = await this.client.get<GitLabMRListItem[]>('/merge_requests', {
      params: {
        scope: 'all',
        state: 'opened',
        order_by: 'updated_at',
        sort: 'desc',
        per_page: 50,
      },
      signal,
    });
    return res.data.map((raw) => this.normalize(raw));
  }

  async fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges> {
    const res = await this.client.get<GitLabMRChangesResponse>(
      `/projects/${item.projectId}/merge_requests/${item.itemId}/changes`,
      // access_raw_diffs: 대형 MR에서 UI처럼 diff가 접혀(빈 문자열) 오는 것을 우회 — Gitaly에서 직접 조회
      { params: { access_raw_diffs: true } },
    );
    const base = this.normalize(res.data);
    return { ...base, changes: res.data.changes ?? [] };
  }

  async fetchDiscussions(
    item: ReviewItemSummary,
    signal?: AbortSignal,
  ): Promise<Discussion[]> {
    const res = await this.client.get<GitLabDiscussion[]>(
      `/projects/${item.projectId}/merge_requests/${item.itemId}/discussions`,
      { params: { per_page: 100 }, signal },
    );
    const username = await this.getCurrentUsername();
    return res.data.map((d) => ({
      id: d.id,
      notes: d.notes
        .filter((n) => !n.system)
        .map((n): DiscussionNote => ({
          id: String(n.id),
          author: n.author,
          body: n.body,
          createdAt: n.created_at,
          mentionsCurrentUser: username ? bodyMentions(n.body, username) : false,
        })),
    }));
  }

  private async getCurrentUsername(): Promise<string | null> {
    if (this.cachedUsername) return this.cachedUsername;
    try {
      const res = await this.client.get<GitLabUserResponse>('/user');
      this.cachedUsername = res.data.username;
      return this.cachedUsername;
    } catch {
      return null;
    }
  }

  async postComment(
    item: ReviewItemSummary,
    body: string,
  ): Promise<CommentPostResult> {
    try {
      const res = await this.client.post<{ id: string }>(
        `/projects/${item.projectId}/merge_requests/${item.itemId}/discussions`,
        { body },
      );
      log.info(
        `gitlab[${this.config.id.slice(0, 8)}]: comment posted item=#${item.itemId} discussion=${res.data.id}`,
      );
      return { success: true, commentId: String(res.data.id) };
    } catch (err) {
      const msg = classifyGitLabError(err).message;
      log.error(`gitlab: comment post failed: ${msg}`);
      return { success: false, error: msg };
    }
  }

  isCurrentUserReviewer(item: ReviewItemSummary): boolean {
    return item.reviewers.some((r) => r.id === this.config.userId);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await this.client.get<GitLabUserResponse>('/user');
      return {
        success: true,
        userId: res.data.id,
        username: res.data.username,
      };
    } catch (err) {
      return { success: false, error: classifyGitLabError(err).message };
    }
  }

  // ── v3 확장 ────────────────────────────────────────────
  fetchRecentPipelines(signal?: AbortSignal): Promise<PipelineInfo[]> {
    return V3.fetchRecentPipelines(this.client, signal);
  }
  fetchApprovalStatus(item: ReviewItemSummary, signal?: AbortSignal): Promise<ApprovalStatus> {
    return V3.fetchApprovalStatus(this.client, item, signal);
  }
  fetchAssignedIssues(signal?: AbortSignal): Promise<GitIssue[]> {
    return V3.fetchAssignedIssues(this.client, this.config, signal);
  }
  createBranch(payload: BranchCreatePayload): Promise<BranchCreateResult> {
    return V3.createBranch(this.client, payload);
  }
  listBranches(payload: BranchListPayload): Promise<BranchListResult> {
    return V3.listBranches(this.client, payload);
  }
  listProjects(signal?: AbortSignal): Promise<import('../../../shared/types').GitProjectSummary[]> {
    return V3.listProjects(this.client, signal);
  }
  postReply(item: ReviewItemSummary, payload: CommentReplyPayload): Promise<CommentPostResult> {
    return V3.postReply(this.client, item, payload);
  }
  runPipeline(item: ReviewItemSummary): Promise<PipelineRunResult> {
    return V3.runPipeline(this.client, item);
  }
  fetchRepoCloneUrl(item: ReviewItemSummary): Promise<string> {
    return V3.fetchRepoCloneUrl(this.client, item);
  }

  private normalize(raw: GitLabMRListItem): ReviewItemSummary {
    const reviewers: ReviewItemAuthor[] = (raw.reviewers ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      avatar_url: r.avatar_url,
    }));
    const viewerIsReviewer = reviewers.some((r) => r.id === this.config.userId);
    return {
      id: `${this.config.id}::gitlab::${raw.project_id}::${raw.iid}`,
      gitConfigId: this.config.id,
      providerType: 'gitlab',
      providerLabel: PROVIDER_SHORT_LABEL.gitlab,
      itemId: raw.iid,
      title: raw.title,
      description: raw.description ?? '',
      author: raw.author,
      reviewers,
      viewerIsReviewer,
      webUrl: raw.web_url,
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      projectId: raw.project_id,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
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

