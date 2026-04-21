// shared/types-v3.ts — v3 Git 확장 이벤트/브랜치/필터 타입 (strict, no any)
import type {
  CommentPostPayload,
  CommentPostResult,
  GitProviderType,
  ReviewItemAuthor,
} from './types';
import type {
  JiraConfig,
  JiraEvent,
  JiraEventKind,
  JiraIssueSummary,
} from './types-jira';

// ── v3 이벤트 — 추가 kind ──────────────────────────────────
// §20.13.C3 / Reviewer ACK: `ItemEventKindV3` 및 `ItemEventV3` 제거.
// v3 literal 5종은 `types.ts` 의 `ItemEventKind` 본체에 직접 append 되어 있으며
// (types.ts:194-203), 이벤트 송출은 `ItemEvent` (types.ts:205-214) 단일 타입만 사용.
// exhaustive switch 시 `never` 추론 안정성 확보 목적.

/** 파이프라인 상태 */
export type PipelineStatus = 'success' | 'failed' | 'canceled';

export interface PipelineInfo {
  /** GitLab pipeline id / GitHub workflow run id */
  id: number;
  status: PipelineStatus;
  /** 브라우저 URL */
  webUrl: string;
  /** 대상 브랜치/ref */
  ref: string;
  /** 종료 시각 ISO 8601 */
  finishedAt: string;
}

/** MR/PR 승인 상태 */
export interface ApprovalStatus {
  approved: boolean;
  approvedBy: ReviewItemAuthor[];
  changesRequested: boolean;
}

/** GitLab/GitHub 이슈 요약 — 할당/멘션 알림용 */
export interface GitIssue {
  /** 복합 ID: `${gitConfigId}::${providerType}::${projectId}::issue::${issueId}` */
  id: string;
  gitConfigId: string;
  providerType: GitProviderType;
  /** GitLab iid / GitHub issue number */
  issueId: number;
  title: string;
  webUrl: string;
  projectId: number;
  /** GitHub 전용 — "owner/repo" */
  repoFullName?: string;
  assignees: ReviewItemAuthor[];
  /** 멘션된 경우 해당 시각 ISO 8601 */
  mentionedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 프로젝트별 알림 필터 (§20.13.I3 확정 키 포맷).
 *
 * 키공간:
 * - Git:  `${gitConfigId}::${providerType}::${projectId}` (3-part, providerType='gitlab'|'github')
 *         ReviewItemSummary.id 앞 3-part 와 일치 → poller 측 O(1) 조회.
 * - Jira: `${jiraConfigId}::jira::${projectKey}` (3-part, 중간 segment 고정값 'jira')
 *
 * 판별: `projectKey.split('::')[1] === 'jira'` 이면 Jira filter.
 * ReviewItemSummary.id (4-part) 와는 다름 — itemId 미포함.
 */
export interface ProjectFilter {
  projectKey: string;
  /** UI 표시용 라벨 (선택) */
  displayLabel?: string;
  /** true 면 해당 프로젝트 알림 표시하지 않음 */
  muted: boolean;
}

// ── v3 확장 이벤트 유니온 — `ItemEvent` (types.ts) 로 통합됨.
// §20.13.C3: `ItemEventV3` 제거. 모든 v3 git 이벤트는 `types.ts` 의 `ItemEvent` 를 사용.

/** git 이슈 이벤트 (issue_assigned / issue_mentioned) */
export interface GitIssueEvent {
  kind: 'issue_assigned' | 'issue_mentioned';
  issue: GitIssue;
}

/** Jira 이벤트 재노출 (편의) */
export type { JiraEvent, JiraEventKind };

// ── 브랜치 생성 ─────────────────────────────────────────────
export interface BranchCreatePayload {
  gitConfigId: string;
  jiraIssueKey: string;
  branchName: string;
  baseBranch: string;
  /**
   * GitLab projectId(number) 또는 namespace path("group/sub/proj"). 문자열이면 URL-encode 해서 사용.
   * GitHub은 repoFullName 을 사용하므로 이 필드는 0(또는 임의) 으로 둬도 됨.
   */
  projectId: number | string;
  /** GitHub 전용 — "owner/repo" */
  repoFullName?: string;
}

export interface BranchCreateResult {
  success: boolean;
  branchName?: string;
  webUrl?: string;
  error?: string;
  /** §20.12.C — HTTP status / 검증 실패를 UI 친화적으로 분류. */
  errorCode?: 'conflict' | 'forbidden' | 'not_found' | 'network' | 'unknown';
}

export interface BranchListPayload {
  gitConfigId: string;
  /** GitLab: number | "group/proj" path(string). GitHub: 무시, repoFullName 사용. */
  projectId: number | string;
  repoFullName?: string;
}

// ── 프로젝트/저장소 목록 (브랜치 모달에서 사용) ─────────────
export interface GitProjectSummary {
  /**
   * API 호출에 그대로 쓰는 값.
   * GitLab: namespace path ("group/proj") — projectId 숫자보다 사람이 읽기 좋음.
   * GitHub: "owner/repo".
   */
  value: string;
  /** UI 표시용 전체 이름 (보통 value 와 같음, 보조 정보 부연 가능) */
  name: string;
  /** 설명(optional) */
  description?: string;
  /** 기본 브랜치(있으면) — 로드 후 자동 선택용 */
  defaultBranch?: string;
}

export interface ProjectListPayload {
  gitConfigId: string;
}

export interface ProjectListResult {
  success: boolean;
  projects?: GitProjectSummary[];
  error?: string;
}

export interface BranchListResult {
  success: boolean;
  branches?: string[];
  error?: string;
}

// ── 댓글 답글 ───────────────────────────────────────────────
/** 기존 토론 스레드에 답글 (§20.13.I5) */
export interface CommentReplyPayload extends CommentPostPayload {
  /** GitLab discussion_id / GitHub review thread의 상위 comment id */
  discussionId: string;
  /**
   * GitHub 전용 힌트 — discussionId 가 review thread 의 comment id 인지
   * issue comment id 인지 판별. undefined 이면 provider 가 review thread 를
   * 우선 시도하고 404 시 issue quote fallback 으로 진행.
   */
  threadContext?: 'review_thread' | 'issue_comment';
  /**
   * issue_comment fallback 시 인용에 사용할 원문 정보 (선택).
   * provider 는 없어도 동작하되, 있으면 `> @author: <snippet>\n\n<body>` 형태로 조립.
   */
  quoteAuthor?: string;
  quoteSnippet?: string;
}

export type CommentReplyResult = CommentPostResult;

// ── v3 확장 AppSettings 필드 ──────────────────────────────
export interface AppSettingsV3 {
  jiraConnections: JiraConfig[];
  jiraWebhookEnabled: boolean;
  jiraWebhookPort: number;
  projectFilters: ProjectFilter[];
  pipelineNotificationsEnabled: boolean;
  approvalNotificationsEnabled: boolean;
}

// ── v3 확장 StoreSchema 필드 ──────────────────────────────
export interface StoreSchemaV3 {
  seenJiraIssueIds: string[];
  /** 최근 Jira 이슈 (최대 20개) — 트레이/리스트 윈도우용 */
  recentJiraIssues: JiraIssueSummary[];
  /** 이미 알림 발송한 pipeline id 집합 (복합키: `${gitConfigId}::${projectId}::${pipelineId}`) */
  seenPipelineIds: string[];
  /** 이미 approve/changes_requested 알림 보낸 MR id 집합 (ReviewItemSummary.id 포맷) */
  seenApprovalItemIds: string[];
}

// ── IPC 페이로드 ─────────────────────────────────────────────
export interface ProjectFiltersSavePayload {
  projectFilters: ProjectFilter[];
}

export interface ProjectFiltersLoadResult {
  projectFilters: ProjectFilter[];
}
