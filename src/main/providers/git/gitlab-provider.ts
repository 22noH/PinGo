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
import { fetchScopedOpenItems, inspectGitLabScope, isProjectInScope, resolveGitLabScope } from './gitlab-scope';

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
  /** source 브랜치 head 커밋 — 자동 재리뷰 트리거 판단용 */
  sha?: string;
  created_at: string;
  updated_at: string;
}

interface GitLabDiscussionNote {
  id: number;
  body: string;
  author: GitLabUserBrief;
  created_at: string;
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  resolved_at?: string | null;
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
          const head = `gitlab[${this.config.id.slice(0, 8)}]: status=${status ?? 'n/a'} url=${err.config?.url ?? ''}`;
          // 404 는 호출측이 "기능 없음" 으로 처리하는 정상 경로 — 헤더 덤프 없이 debug 로만
          if (status === 404) log.debug(head);
          else log.warn(head, maskHeaders(err.config?.headers as AxiosRequestHeaders | undefined));
        }
        return Promise.reject(err);
      },
    );
  }

  async fetchOpenItems(signal?: AbortSignal): Promise<ReviewItemSummary[]> {
    // 연결 범위 안의 열린 MR 전부 — 프로젝트 토큰이면 그 프로젝트만 (gitlab-scope.ts).
    // 리뷰어 지정/멘션 감지는 item.reviewers 및 note.mentionsCurrentUser 로 별도 처리.
    const scope = await resolveGitLabScope(this.client, this.config, signal);
    const raws = await fetchScopedOpenItems<GitLabMRListItem>(this.client, this.config.id, scope, signal);
    return raws.map((raw) => this.normalize(raw));
  }

  /** 범위 밖 프로젝트에는 쓰지 않는다 — 폴링이 잘못돼도 남의 프로젝트에 댓글이 달리지 않게 하는 마지막 방어선 */
  private async outOfScope(item: ReviewItemSummary): Promise<string | null> {
    const scope = await resolveGitLabScope(this.client, this.config);
    if (isProjectInScope(scope, item.projectId)) return null;
    log.warn(`gitlab[${this.config.id.slice(0, 8)}]: 범위 밖 프로젝트 쓰기 차단 project=${item.projectId}`);
    return '이 연결의 대상 프로젝트가 아닙니다 (설정 > Git 연결에서 범위 확인)';
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
    return res.data.map((d) => {
      // resolvable 노트가 하나라도 있으면 스레드는 resolvable — 전부 resolved 여야 스레드 resolved.
      const resolvable = d.notes.filter((n) => n.resolvable);
      const resolved =
        resolvable.length > 0 ? resolvable.every((n) => n.resolved === true) : undefined;
      // 재해결 감지용 — 노트 중 가장 늦은 resolved_at
      const resolvedAt = resolved
        ? resolvable.map((n) => n.resolved_at ?? '').filter(Boolean).sort().pop()
        : undefined;
      return {
        id: d.id,
        resolvedAt,
        resolved,
        notes: d.notes
          .filter((n) => !n.system)
          .map((n): DiscussionNote => ({
            id: String(n.id),
            author: n.author,
            body: n.body,
            createdAt: n.created_at,
            mentionsCurrentUser: username ? bodyMentions(n.body, username) : false,
          })),
      };
    });
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
      const blocked = await this.outOfScope(item);
      if (blocked) return { success: false, error: blocked };
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
      const scope = await inspectGitLabScope(this.client, this.config);
      return {
        success: true,
        userId: scope.userId,
        username: scope.username,
        tokenKind: scope.tokenKind,
        memberProjects: scope.memberProjects,
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
  async postReply(item: ReviewItemSummary, payload: CommentReplyPayload): Promise<CommentPostResult> {
    const blocked = await this.outOfScope(item);
    if (blocked) return { success: false, error: blocked };
    return V3.postReply(this.client, item, payload);
  }
  resolveDiscussion(item: ReviewItemSummary, discussionId: string, resolved?: boolean): Promise<void> {
    return V3.resolveDiscussion(this.client, item, discussionId, resolved);
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
      headSha: raw.sha,
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

