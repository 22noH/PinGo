// main/auto-review/pending.ts — "지금 이 MR 에서 검증할 스레드" 를 토론 자체에서 판단 (순수 로직)
//
// 캐시(resolvedThreadIds)를 기준으로 삼으면 캐시 유실·재설치·검증 실패 뒤에 상태가 어긋나
// "하나는 검증됐는데 다음 건 안 된다" 가 생긴다. MR 에 달린 댓글이 진실이다:
//   - Pingo 리뷰 댓글(COMMENT_HEADER)이 없으면 → 아직 리뷰 전 (호출측이 전체 리뷰)
//   - 마지막 리뷰 댓글 이후에 해결된 스레드 중, 수용된 검증 답글(VERIFY_HEADER)이 없는 것 → 검증 대상
//   - 지적 없는 리뷰를 봇이 스스로 닫은 스레드, 리뷰 전에 이미 닫혀 있던 스레드는 제외
import type { Discussion } from '../../shared/types';
import { isResolved } from './orchestrator';
import { COMMENT_HEADER, isCleanReview } from './clean';
import { hasAcceptedVerification } from './verify';

export interface PendingVerifications {
  /** Pingo 자동 리뷰 댓글이 하나라도 달려 있는지 */
  reviewed: boolean;
  /** 검증할 스레드 id (토론 순서) */
  threadIds: string[];
}

const isReviewNote = (body: string): boolean => body.startsWith(COMMENT_HEADER);

/** 마지막 Pingo 리뷰 댓글 시각 — 없으면 undefined */
function latestReviewAt(discussions: Discussion[]): string | undefined {
  let latest: string | undefined;
  for (const d of discussions) {
    for (const n of d.notes) {
      if (isReviewNote(n.body) && (!latest || n.createdAt > latest)) latest = n.createdAt;
    }
  }
  return latest;
}

/** 봇이 "지적 없음" 으로 스스로 닫은 자기 리뷰 스레드인지 */
function isSelfSettledCleanReview(d: Discussion): boolean {
  const first = d.notes[0];
  return first !== undefined && isReviewNote(first.body) && isCleanReview(first.body);
}

export function pendingVerifications(discussions: Discussion[]): PendingVerifications {
  const reviewAt = latestReviewAt(discussions);
  if (!reviewAt) return { reviewed: false, threadIds: [] };
  const threadIds = discussions
    .filter(isResolved)
    .filter((d) => d.resolvedAt !== undefined && d.resolvedAt > reviewAt)
    .filter((d) => !isSelfSettledCleanReview(d))
    .filter((d) => !hasAcceptedVerification(d))
    .map((d) => d.id);
  return { reviewed: true, threadIds };
}
