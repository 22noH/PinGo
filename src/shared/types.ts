// shared/types.ts
// strict mode — no `any` allowed

export interface MRAuthor {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
}

export interface DiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface MRChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/** 폴링 목록용 — changes 없음, 경량 */
export interface MergeRequestSummary {
  id: number;
  iid: number;
  title: string;
  description: string;
  author: MRAuthor;
  web_url: string;
  source_branch: string;
  target_branch: string;
  reviewer_ids: number[];
  project_id: number;
  diff_refs: DiffRefs;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** 리뷰/상세용 — changes 필수 */
export interface MergeRequestWithChanges extends MergeRequestSummary {
  changes: MRChange[];
}

/** 하위 호환 alias — 두 타입을 모두 수용해야 하는 컨텍스트에서 사용 */
export type MergeRequest = MergeRequestSummary | MergeRequestWithChanges;

export type TrayState = 'ACTIVE' | 'MUTED' | 'NEW_MR' | 'ERROR';

export type ReviewState = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export type NotificationAction = 'open' | 'review';

export interface AppSettings {
  gitlabUrl: string;
  token: string;
  userId: number;
  pollIntervalMs: number;
  notificationEnabled: boolean;
  /** true이면 assignee_id 도 함께 폴링 (기본값 false — reviewer_id 전용). v1에서는 읽기만 하고 무시. */
  includeMentioned?: boolean;
}

export interface StoreSchema {
  settings: AppSettings;
  seenMrIds: number[];
  recentMrs: MergeRequestSummary[]; // 최대 5개 — 트레이 메뉴용, changes 불필요
}

// ── IPC 페이로드 타입 ───────────────────────────────────────
export interface ReviewStartPayload {
  mr: MergeRequestSummary; // 리뷰 시작 시 summary 전달 → main에서 changes fetch
}

export interface ReviewChunkPayload {
  chunk: string;
}

export interface ReviewErrorPayload {
  message: string;
}

export interface CommentPostPayload {
  projectId: number;
  iid: number;
  body: string;
}

export interface CommentPostResult {
  success: boolean;
  discussionId?: string;
  error?: string;
}

export interface NotificationClickPayload {
  action: NotificationAction;
  mrId: number;
}

export interface TrayStateChangedPayload {
  state: TrayState;
  lastCheckedAt: string; // ISO 8601
}

/** 연결 테스트 결과 (SETTINGS_TEST 응답) */
export interface ConnectionTestResult {
  success: boolean;
  userId?: number;
  error?: string;
}

export interface SettingsSavePayload {
  settings: AppSettings;
}

export interface SettingsLoadResult {
  settings: AppSettings;
}
