// providers/git/git-provider.ts — GitProvider interface + factory (v2 + v3)
import type {
  ApprovalStatus,
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  CommentPostResult,
  CommentReplyPayload,
  CommentReplyResult,
  ConnectionTestResult,
  Discussion,
  GitConfig,
  GitIssue,
  GitProjectSummary,
  PipelineInfo,
  PipelineRunResult,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from '../../../shared/types';
import { GitLabProvider } from './gitlab-provider';
import { GitHubProvider } from './github-provider';

export interface GitProvider {
  readonly config: GitConfig;
  /** 현재 사용자 대상 Open MR/PR 목록 조회 (작성자/리뷰어/멘션 전부) */
  fetchOpenItems(signal?: AbortSignal): Promise<ReviewItemSummary[]>;
  /** 특정 아이템의 변경 파일 조회 */
  fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges>;
  /** 댓글/토론 목록 조회 — 댓글 알림 감지 + AI 리뷰 입력 */
  fetchDiscussions(item: ReviewItemSummary, signal?: AbortSignal): Promise<Discussion[]>;
  /** 댓글 등록 (GitLab Discussion / GitHub Issue Comment) */
  postComment(item: ReviewItemSummary, body: string): Promise<CommentPostResult>;
  /** 연결/토큰 검증 */
  testConnection(): Promise<ConnectionTestResult>;
  /** 현재 사용자가 이 item의 리뷰어에 포함되어 있는지 (item.reviewers 기반) */
  isCurrentUserReviewer(item: ReviewItemSummary): boolean;

  // ── v3 확장 (optional — provider 가 지원할 때만 구현) ─────────
  /** 최근 완료된 파이프라인 목록 */
  fetchRecentPipelines?(signal?: AbortSignal): Promise<PipelineInfo[]>;
  /** 특정 MR/PR 의 승인 상태 */
  fetchApprovalStatus?(item: ReviewItemSummary, signal?: AbortSignal): Promise<ApprovalStatus>;
  /** 나에게 할당된 이슈 목록 */
  fetchAssignedIssues?(signal?: AbortSignal): Promise<GitIssue[]>;
  /** 나를 멘션한 이슈 목록 */
  fetchMentionedIssues?(signal?: AbortSignal): Promise<GitIssue[]>;
  /** 브랜치 생성 */
  createBranch?(payload: BranchCreatePayload): Promise<BranchCreateResult>;
  /** 브랜치 목록 (base branch 선택용) */
  listBranches?(payload: BranchListPayload): Promise<BranchListResult>;
  /** 사용자가 접근 가능한 프로젝트/저장소 목록 (브랜치 생성 대상 선택용) */
  listProjects?(signal?: AbortSignal): Promise<GitProjectSummary[]>;
  /** 기존 토론 스레드에 답글 */
  postReply?(item: ReviewItemSummary, payload: CommentReplyPayload): Promise<CommentReplyResult>;
  /** MR/PR 파이프라인 새로 실행 */
  runPipeline?(item: ReviewItemSummary): Promise<PipelineRunResult>;
  /** 저장소 HTTP clone URL (AI 머지용 — 인증 없이 반환, 토큰 주입은 호출측) */
  fetchRepoCloneUrl?(item: ReviewItemSummary): Promise<string>;
}

export function createGitProvider(config: GitConfig): GitProvider {
  switch (config.type) {
    case 'gitlab':
      return new GitLabProvider(config);
    case 'github':
      return new GitHubProvider(config);
    default: {
      // exhaustiveness — 새 GitProviderType 추가 시 컴파일 에러로 알림
      const _exhaustive: never = config;
      throw new Error(`Unknown GitConfig.type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
