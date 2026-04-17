// providers/git/git-provider.ts — GitProvider interface + factory
import type {
  CommentPostResult,
  ConnectionTestResult,
  Discussion,
  GitConfig,
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
