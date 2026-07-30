// main/auto-review/clean.ts — "지적 없음" 리뷰 판정 + 자체 마무리(스레드 해결 → 승인)
//
// 자동 리뷰 댓글은 GitLab 에서 resolvable 스레드로 달린다. 지적이 없는데도 사람이
// 손으로 해결을 눌러야 하면 (1) 머지가 막히고 (2) 그 해결이 재리뷰를 불러 무한루프가 된다.
// 그래서 깨끗한 리뷰는 봇이 스스로 스레드를 닫고 승인까지 올린다.
import log from 'electron-log';
import type { Discussion, ReviewItemSummary } from '../../shared/types';
import type { GitProvider } from '../providers/git/git-provider';

export const COMMENT_HEADER = '🤖 **Pingo 자동 AI 리뷰**';

/** Pingo 가 단 리뷰 스레드인지 — 첫 노트의 헤더로 판별 */
export function isOwnReviewThread(d: Discussion): boolean {
  return d.notes[0]?.body.startsWith(COMMENT_HEADER) === true;
}

/**
 * 지적 없는 리뷰인지 — 종합 평가가 ✅ 머지 가능 단독일 때만.
 * AI 가 양식의 선택지("✅ / ⚠️ / ❌")를 그대로 복사하면 셋이 다 잡히므로 false 가 된다.
 * 애매하면 false(=사람이 판단) 쪽으로 기운다 — 잘못 승인하는 것보다 안전하다.
 */
export function isCleanReview(markdown: string): boolean {
  return (
    markdown.includes('✅ 머지 가능') &&
    !markdown.includes('⚠️ 수정 권장') &&
    !markdown.includes('❌ 수정 필요')
  );
}

/**
 * 깨끗한 리뷰 마무리: 방금 단 자기 스레드를 봇이 스스로 해결한다.
 * 스레드 해결은 셀프 제약이 없다(작성자 = 봇, MR 작성자 = 나) — 승인과 달리 항상 된다.
 * 실패해도 리뷰 자체는 성공이므로 경고만 남긴다.
 */
export async function settleClean(
  provider: GitProvider,
  item: ReviewItemSummary,
  discussionId: string | undefined,
): Promise<void> {
  if (!discussionId || !provider.resolveDiscussion) return;
  try {
    await provider.resolveDiscussion(item, discussionId);
    log.info(`auto-review: 지적 없음 — 자기 스레드 해결 ${item.id} (${discussionId})`);
  } catch (err) {
    log.warn(`auto-review: 스레드 해결 실패 ${item.id}: ${String(err).slice(0, 200)}`);
  }
}
