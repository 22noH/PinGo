// providers/git/gitlab-provider-v3.ts — v3 확장 메서드 (pipeline/approval/issues/branch/reply)
import type { AxiosInstance } from 'axios';
import log from 'electron-log';
import type {
  ApprovalStatus,
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  CommentPostResult,
  CommentReplyPayload,
  GitIssue,
  GitLabConfig,
  GitProjectSummary,
  PipelineInfo,
  PipelineRunResult,
  ReviewItemAuthor,
  ReviewItemSummary,
} from '../../../shared/types';
import { classifyBranchCreateError } from './branch-errors';

interface GitLabPipeline {
  id: number;
  status: string;
  ref: string;
  web_url: string;
  updated_at: string;
  project_id: number;
  finished_at?: string | null;
}

interface GitLabApprovalUser {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
}

interface GitLabApprovalRule {
  rule_type: string; // 'regular' | 'any_approver' | 'code_owner' | ...
  approved_by?: GitLabApprovalUser[];
}

interface GitLabApprovalState {
  approved?: boolean;
  rules?: GitLabApprovalRule[];
}

interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  project_id: number;
  created_at: string;
  updated_at: string;
  assignees?: GitLabApprovalUser[];
}

interface GitLabBranch {
  name: string;
  default?: boolean;
}

/**
 * GitLab 프로젝트 목록 중 사용자가 접근 가능한 것을 순회하며 최근 파이프라인 수집.
 * 폭주 방지 위해 최근 업데이트된 10개 프로젝트로 제한.
 */
export async function fetchRecentPipelines(
  client: AxiosInstance,
  signal?: AbortSignal,
): Promise<PipelineInfo[]> {
  // 1) 최근 활동 프로젝트 10개
  const projRes = await client.get<{ id: number }[]>('/projects', {
    params: { membership: true, order_by: 'last_activity_at', per_page: 10 },
    signal,
  });
  const projects = projRes.data;

  const results = await Promise.allSettled(
    projects.map(async (p): Promise<PipelineInfo[]> => {
      const pr = await client.get<GitLabPipeline[]>(`/projects/${p.id}/pipelines`, {
        params: { order_by: 'updated_at', sort: 'desc', per_page: 5 },
        signal,
      });
      return pr.data
        .filter((pp) => ['success', 'failed', 'canceled'].includes(pp.status))
        .map((pp): PipelineInfo => ({
          id: pp.id,
          status: pp.status as PipelineInfo['status'],
          webUrl: pp.web_url,
          ref: pp.ref,
          finishedAt: pp.finished_at ?? pp.updated_at,
        }));
    }),
  );
  const all: PipelineInfo[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }
  return all;
}

/** MR 파이프라인 새로 실행 — POST /merge_requests/:iid/pipelines */
export async function runPipeline(
  client: AxiosInstance,
  item: ReviewItemSummary,
): Promise<PipelineRunResult> {
  try {
    const res = await client.post<{ id: number; web_url?: string }>(
      `/projects/${item.projectId}/merge_requests/${item.itemId}/pipelines`,
    );
    log.info(`gitlab: pipeline started item=#${item.itemId} pipeline=${res.data.id}`);
    return { success: true, webUrl: res.data.web_url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`gitlab: pipeline run failed item=#${item.itemId}: ${msg.slice(0, 200)}`);
    return { success: false, error: msg };
  }
}

/** 저장소 HTTP clone URL 조회 — AI 머지에서 임시 클론에 사용 */
export async function fetchRepoCloneUrl(
  client: AxiosInstance,
  item: ReviewItemSummary,
): Promise<string> {
  const res = await client.get<{ http_url_to_repo: string }>(
    `/projects/${item.projectId}`,
  );
  return res.data.http_url_to_repo;
}

export async function fetchApprovalStatus(
  client: AxiosInstance,
  item: ReviewItemSummary,
  signal?: AbortSignal,
): Promise<ApprovalStatus> {
  const res = await client.get<GitLabApprovalState>(
    `/projects/${item.projectId}/merge_requests/${item.itemId}/approval_state`,
    { signal },
  );
  const rules = res.data.rules ?? [];
  const approvedBy: ReviewItemAuthor[] = [];
  for (const rule of rules) {
    for (const u of rule.approved_by ?? []) {
      if (!approvedBy.some((a) => a.id === u.id)) {
        approvedBy.push({
          id: u.id,
          name: u.name,
          username: u.username,
          avatar_url: u.avatar_url,
        });
      }
    }
  }
  return {
    approved: Boolean(res.data.approved) || approvedBy.length > 0,
    approvedBy,
    changesRequested: false, // GitLab 에는 명시적 changes_requested 개념 없음 — draft/unresolved 로 별도 처리
  };
}

export async function fetchAssignedIssues(
  client: AxiosInstance,
  config: GitLabConfig,
  signal?: AbortSignal,
): Promise<GitIssue[]> {
  const res = await client.get<GitLabIssue[]>('/issues', {
    params: { scope: 'assigned_to_me', state: 'opened', per_page: 50 },
    signal,
  });
  return res.data.map((raw): GitIssue => ({
    id: `${config.id}::gitlab::${raw.project_id}::issue::${raw.iid}`,
    gitConfigId: config.id,
    providerType: 'gitlab',
    issueId: raw.iid,
    title: raw.title,
    webUrl: raw.web_url,
    projectId: raw.project_id,
    assignees: (raw.assignees ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      username: a.username,
      avatar_url: a.avatar_url,
    })),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  }));
}

/**
 * GitLab `/projects/:id` 경로용 project ref 인코딩.
 * - number    → toString (그대로)
 * - string "group/proj" → encodeURIComponent (슬래시 포함 모든 예약 문자를 %-인코딩)
 *   axios는 경로 문자열을 추가로 인코딩하지 않으므로 여기서 1회만 인코딩하면 됨.
 */
function encodeProjectRef(ref: number | string): string {
  if (typeof ref === 'number') return String(ref);
  return encodeURIComponent(ref);
}

export async function createBranch(
  client: AxiosInstance,
  payload: BranchCreatePayload,
): Promise<BranchCreateResult> {
  try {
    const pr = encodeProjectRef(payload.projectId);
    const res = await client.post<{ name: string; web_url: string }>(
      `/projects/${pr}/repository/branches`,
      null,
      { params: { branch: payload.branchName, ref: payload.baseBranch } },
    );
    log.info(
      `gitlab: branch created project=${payload.projectId} name=${res.data.name}`,
    );
    return { success: true, branchName: res.data.name, webUrl: res.data.web_url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`gitlab: branch create failed: ${msg.slice(0, 200)}`);
    const classified = classifyBranchCreateError(err);
    return { success: false, ...classified };
  }
}

export async function listBranches(
  client: AxiosInstance,
  payload: BranchListPayload,
): Promise<BranchListResult> {
  try {
    const pr = encodeProjectRef(payload.projectId);
    const res = await client.get<GitLabBranch[]>(
      `/projects/${pr}/repository/branches`,
      { params: { per_page: 100 } },
    );
    // default 를 앞으로
    const sorted = [...res.data].sort((a, b) => {
      if (a.default && !b.default) return -1;
      if (!a.default && b.default) return 1;
      return a.name.localeCompare(b.name);
    });
    return { success: true, branches: sorted.map((b) => b.name) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

interface GitLabProjectRaw {
  id: number;
  path_with_namespace: string;
  name_with_namespace?: string;
  description?: string | null;
  default_branch?: string | null;
}

/**
 * 사용자가 멤버/관리자 권한을 가진 프로젝트 목록.
 * 최대 200개까지 2페이지 수집 (100 × 2). membership=true 로 현재 사용자 가시 프로젝트만.
 */
export async function listProjects(
  client: AxiosInstance,
  signal?: AbortSignal,
): Promise<GitProjectSummary[]> {
  const out: GitLabProjectRaw[] = [];
  for (let page = 1; page <= 2; page += 1) {
    const res = await client.get<GitLabProjectRaw[]>('/projects', {
      params: {
        membership: true,
        order_by: 'last_activity_at',
        sort: 'desc',
        per_page: 100,
        page,
        simple: true,
      },
      signal,
    });
    out.push(...res.data);
    if (res.data.length < 100) break;
  }
  return out.map((p): GitProjectSummary => ({
    value: p.path_with_namespace,
    name: p.name_with_namespace ?? p.path_with_namespace,
    description: p.description ?? undefined,
    defaultBranch: p.default_branch ?? undefined,
  }));
}

export async function postReply(
  client: AxiosInstance,
  item: ReviewItemSummary,
  payload: CommentReplyPayload,
): Promise<CommentPostResult> {
  try {
    const res = await client.post<{ id: number }>(
      `/projects/${item.projectId}/merge_requests/${item.itemId}/discussions/${payload.discussionId}/notes`,
      { body: payload.body },
    );
    return { success: true, commentId: String(res.data.id) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`gitlab: reply post failed: ${msg}`);
    return { success: false, error: msg };
  }
}
