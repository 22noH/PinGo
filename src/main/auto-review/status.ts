// main/auto-review/status.ts — 트레이 메뉴에 보여줄 자동 리뷰 현황 타입 (순수 타입)
import type { ReviewItemSummary } from '../../shared/types';

/** 요청 종류 — 전체 리뷰(댓글 게시) / 해결 검증(스레드 답글) */
export type AutoReviewKind = 'review' | 'verify';

export interface AutoReviewActive {
  item: ReviewItemSummary;
  kind: AutoReviewKind;
  /** 현재 단계 — "클론 슬롯 대기", "클론 중", "AI 리뷰", "결과 게시" 등 */
  phase: string;
  startedAt: number;
}

export interface AutoReviewQueued {
  item: ReviewItemSummary;
  kind: AutoReviewKind;
}

export interface AutoReviewRecent {
  item: ReviewItemSummary;
  kind: AutoReviewKind;
  ok: boolean;
  /** "댓글 게시", "검증: 해결 확인 1", 실패 사유 등 */
  summary: string;
  at: number;
}

export interface AutoReviewStatus {
  active: AutoReviewActive[];
  queued: AutoReviewQueued[];
  /** 최신이 앞 */
  recent: AutoReviewRecent[];
}
