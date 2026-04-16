// providers/git/gitlab-provider.ts — GitLab API 구현
import axios, { AxiosError, AxiosInstance, AxiosRequestHeaders } from 'axios';
import log from 'electron-log';
import { PROVIDER_SHORT_LABEL } from '../../../shared/constants';
import type {
  CommentPostResult,
  ConnectionTestResult,
  GitLabConfig,
  ItemChange,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from '../../../shared/types';
import type { GitProvider } from './git-provider';

interface GitLabMRListItem {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  author: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
  };
  web_url: string;
  source_branch: string;
  target_branch: string;
  reviewers?: Array<{ id: number }>;
  project_id: number;
  created_at: string;
  updated_at: string;
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
    const res = await this.client.get<GitLabMRListItem[]>('/merge_requests', {
      params: {
        scope: 'all',
        state: 'opened',
        reviewer_id: this.config.userId,
        order_by: 'updated_at',
        sort: 'desc',
        per_page: 20,
      },
      signal,
    });
    return res.data.map((raw) => this.normalize(raw));
  }

  async fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges> {
    const res = await this.client.get<GitLabMRChangesResponse>(
      `/projects/${item.projectId}/merge_requests/${item.itemId}/changes`,
    );
    const base = this.normalize(res.data);
    return { ...base, changes: res.data.changes ?? [] };
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

  private normalize(raw: GitLabMRListItem): ReviewItemSummary {
    return {
      id: `${this.config.id}::gitlab::${raw.project_id}::${raw.iid}`,
      gitConfigId: this.config.id,
      providerType: 'gitlab',
      providerLabel: PROVIDER_SHORT_LABEL.gitlab,
      itemId: raw.iid,
      title: raw.title,
      description: raw.description ?? '',
      author: raw.author,
      webUrl: raw.web_url,
      sourceBranch: raw.source_branch,
      targetBranch: raw.target_branch,
      projectId: raw.project_id,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }
}

