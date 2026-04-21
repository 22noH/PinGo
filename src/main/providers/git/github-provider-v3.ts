// providers/git/github-provider-v3.ts — v3 확장 메서드 (workflow/review/issues/branch/reply)
import type { AxiosInstance } from 'axios';
import log from 'electron-log';
import type {
  ApprovalStatus,
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  GitHubConfig,
  GitIssue,
  GitProjectSummary,
  PipelineInfo,
  ReviewItemAuthor,
  ReviewItemSummary,
} from '../../../shared/types';
import { classifyBranchCreateError } from './branch-errors';

interface GitHubRepoBrief {
  id: number;
  full_name: string;
  default_branch?: string;
}

interface GitHubWorkflowRun {
  id: number;
  status: string;             // 'completed' | 'in_progress' | ...
  conclusion: string | null;  // 'success' | 'failure' | 'cancelled' | null
  html_url: string;
  head_branch: string;
  updated_at: string;
  run_started_at?: string;
}

interface GitHubPullReview {
  id: number;
  user: { id: number; login: string; avatar_url: string; name?: string };
  state: string; // 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | ...
  submitted_at: string;
}

interface GitHubIssueSearchItem {
  id: number;
  number: number;
  title: string;
  html_url: string;
  repository_url: string; // https://api.github.com/repos/{owner}/{repo}
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
  assignees?: { id: number; login: string; avatar_url: string; name?: string }[];
}

interface GitHubBranch {
  name: string;
  protected: boolean;
}

interface GitHubGitRef {
  object: { sha: string };
}

function parseRepoFromUrl(url: string): string {
  const m = url.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m ? m[1] : '';
}

/**
 * 최근 활동 레포 10개의 completed workflow runs 수집.
 */
export async function fetchRecentPipelines(
  client: AxiosInstance,
  signal?: AbortSignal,
): Promise<PipelineInfo[]> {
  const repoRes = await client.get<GitHubRepoBrief[]>('/user/repos', {
    params: { sort: 'updated', per_page: 10 },
    signal,
  });
  const repos = repoRes.data;

  const results = await Promise.allSettled(
    repos.map(async (r): Promise<PipelineInfo[]> => {
      const runRes = await client.get<{ workflow_runs: GitHubWorkflowRun[] }>(
        `/repos/${r.full_name}/actions/runs`,
        { params: { status: 'completed', per_page: 5 }, signal },
      );
      return runRes.data.workflow_runs
        .filter((run) => run.conclusion && ['success', 'failure', 'cancelled'].includes(run.conclusion))
        .map((run): PipelineInfo => ({
          id: run.id,
          status:
            run.conclusion === 'success' ? 'success' :
            run.conclusion === 'failure' ? 'failed' : 'canceled',
          webUrl: run.html_url,
          ref: run.head_branch,
          finishedAt: run.updated_at,
        }));
    }),
  );
  const all: PipelineInfo[] = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  return all;
}

export async function fetchApprovalStatus(
  client: AxiosInstance,
  item: ReviewItemSummary,
  signal?: AbortSignal,
): Promise<ApprovalStatus> {
  const repoPath = item.repoFullName ?? '';
  if (!repoPath) return { approved: false, approvedBy: [], changesRequested: false };
  const res = await client.get<GitHubPullReview[]>(
    `/repos/${repoPath}/pulls/${item.itemId}/reviews`,
    { params: { per_page: 100 }, signal },
  );
  // 같은 reviewer 가 여러 번 리뷰 — 마지막 상태만 반영
  const latestByUser = new Map<number, GitHubPullReview>();
  for (const r of res.data) {
    const prev = latestByUser.get(r.user.id);
    if (!prev || prev.submitted_at < r.submitted_at) latestByUser.set(r.user.id, r);
  }
  const approvedBy: ReviewItemAuthor[] = [];
  let changesRequested = false;
  for (const r of latestByUser.values()) {
    if (r.state === 'APPROVED') {
      approvedBy.push({
        id: r.user.id,
        name: r.user.name ?? r.user.login,
        username: r.user.login,
        avatar_url: r.user.avatar_url,
      });
    } else if (r.state === 'CHANGES_REQUESTED') {
      changesRequested = true;
    }
  }
  return { approved: approvedBy.length > 0, approvedBy, changesRequested };
}

async function searchIssues(
  client: AxiosInstance,
  q: string,
  signal?: AbortSignal,
): Promise<GitHubIssueSearchItem[]> {
  const res = await client.get<{ items: GitHubIssueSearchItem[] }>('/search/issues', {
    params: { q, per_page: 30, sort: 'updated', order: 'desc' },
    signal,
  });
  return res.data.items.filter((it) => !it.pull_request); // 순수 issue 만
}

function toGitIssue(
  config: GitHubConfig,
  raw: GitHubIssueSearchItem,
  mentioned: boolean,
): GitIssue {
  const repoPath = parseRepoFromUrl(raw.repository_url);
  return {
    id: `${config.id}::github::${raw.id}::issue::${raw.number}`,
    gitConfigId: config.id,
    providerType: 'github',
    issueId: raw.number,
    title: raw.title,
    webUrl: raw.html_url,
    projectId: raw.id,
    repoFullName: repoPath,
    assignees: (raw.assignees ?? []).map((a): ReviewItemAuthor => ({
      id: a.id,
      name: a.name ?? a.login,
      username: a.login,
      avatar_url: a.avatar_url,
    })),
    mentionedAt: mentioned ? raw.updated_at : undefined,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export async function fetchAssignedIssues(
  client: AxiosInstance,
  config: GitHubConfig,
  signal?: AbortSignal,
): Promise<GitIssue[]> {
  if (!config.username) return [];
  const items = await searchIssues(client, `is:issue is:open assignee:${config.username}`, signal);
  return items.map((it) => toGitIssue(config, it, false));
}

export async function fetchMentionedIssues(
  client: AxiosInstance,
  config: GitHubConfig,
  signal?: AbortSignal,
): Promise<GitIssue[]> {
  if (!config.username) return [];
  const items = await searchIssues(client, `is:issue is:open mentions:${config.username}`, signal);
  return items.map((it) => toGitIssue(config, it, true));
}

export async function createBranch(
  client: AxiosInstance,
  payload: BranchCreatePayload,
): Promise<BranchCreateResult> {
  const repoPath = payload.repoFullName ?? '';
  if (!repoPath) return { success: false, error: 'GitHub 브랜치 생성에는 repoFullName 필요' };
  try {
    // 1) base branch SHA 조회
    const refRes = await client.get<GitHubGitRef>(
      `/repos/${repoPath}/git/refs/heads/${payload.baseBranch}`,
    );
    const baseSha = refRes.data.object.sha;
    // 2) 새 ref 생성
    const createRes = await client.post<{ ref: string; url: string }>(
      `/repos/${repoPath}/git/refs`,
      { ref: `refs/heads/${payload.branchName}`, sha: baseSha },
    );
    log.info(`github: branch created ${repoPath}/${payload.branchName}`);
    // GitHub 웹 URL 구성
    const webUrl = `https://github.com/${repoPath}/tree/${payload.branchName}`;
    return { success: true, branchName: payload.branchName, webUrl };
    void createRes; // 응답 사용하지 않음
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`github: branch create failed: ${msg.slice(0, 200)}`);
    const classified = classifyBranchCreateError(err);
    return { success: false, ...classified };
  }
}

export async function listBranches(
  client: AxiosInstance,
  payload: BranchListPayload,
): Promise<BranchListResult> {
  const repoPath = payload.repoFullName ?? '';
  if (!repoPath) return { success: false, error: 'GitHub 브랜치 목록에는 repoFullName 필요' };
  try {
    const res = await client.get<GitHubBranch[]>(
      `/repos/${repoPath}/branches`,
      { params: { per_page: 100 } },
    );
    return { success: true, branches: res.data.map((b) => b.name) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

interface GitHubRepoRaw {
  full_name: string;
  name: string;
  description?: string | null;
  default_branch?: string;
  archived?: boolean;
}

/** 인증 사용자가 접근 가능한 저장소 목록 (owner/repo 포맷 value). 2페이지×100 = 최대 200. */
export async function listProjects(
  client: AxiosInstance,
  signal?: AbortSignal,
): Promise<GitProjectSummary[]> {
  const out: GitHubRepoRaw[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await client.get<GitHubRepoRaw[]>('/user/repos', {
      params: {
        per_page: 100,
        page,
        sort: 'pushed',
        affiliation: 'owner,collaborator,organization_member',
      },
      signal,
    });
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out
    .filter((r) => !r.archived)
    .map((r): GitProjectSummary => ({
      value: r.full_name,
      name: r.full_name,
      description: r.description ?? undefined,
      defaultBranch: r.default_branch,
    }));
}

// postReply 는 github-reply.ts 로 분리 (파일 300줄 제한 준수).
export { postReply } from './github-reply';
