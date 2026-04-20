// shared/types-compat.ts — v1 raw 스키마 + 하위 호환 deprecated alias
import type {
  ReviewItem,
  ReviewItemSummary,
  ReviewItemWithChanges,
} from './types';

// ── 하위 호환 (v1 코드 마이그레이션 중 사용) ────────────────
/** @deprecated v2에서 `ReviewItemSummary` 사용 */
export type MergeRequestSummary = ReviewItemSummary;
/** @deprecated v2에서 `ReviewItemWithChanges` 사용 */
export type MergeRequestWithChanges = ReviewItemWithChanges;
/** @deprecated v2에서 `ReviewItem` 사용 */
export type MergeRequest = ReviewItem;

// ── v1 raw 스키마 (마이그레이션 감지용, 내부 전용) ──────────
export interface V1AppSettings {
  gitlabUrl: string;
  token: string;
  userId: number;
  pollIntervalMs: number;
  notificationEnabled: boolean;
  includeMentioned?: boolean;
}

export interface V1StoreSchema {
  settings: V1AppSettings;
  seenMrIds: number[];
  recentMrs: unknown[];
}
