// shared/constants.ts

// ── Main → Renderer ──────────────────────────────────────────
/** claude -p 스트리밍 청크 전달 */
export const REVIEW_CHUNK = 'review:chunk' as const;
/** claude -p 스트리밍 완료 */
export const REVIEW_DONE = 'review:done' as const;
/** claude -p 오류 발생 */
export const REVIEW_ERROR = 'review:error' as const;
/** 새 MR 감지 → 리뷰 윈도우에 MR 정보 주입 */
export const MR_NEW = 'mr:new' as const;
/** 트레이 상태 변경 브로드캐스트 */
export const TRAY_STATE_CHANGED = 'tray:state-changed' as const;

// ── Renderer → Main ──────────────────────────────────────────
/** 리뷰 시작 요청 (MergeRequest 전달) */
export const REVIEW_START = 'review:start' as const;
/** 리뷰 중단 요청 */
export const REVIEW_ABORT = 'review:abort' as const;
/** GitLab 댓글 등록 요청 */
export const COMMENT_POST = 'comment:post' as const;
/** 설정 저장 요청 */
export const SETTINGS_SAVE = 'settings:save' as const;
/** 설정 로드 요청 */
export const SETTINGS_LOAD = 'settings:load' as const;
/** 브라우저로 MR URL 열기 */
export const WINDOW_OPEN_MR = 'window:open-mr' as const;
/** 알림 토글 (ACTIVE ↔ MUTED) */
export const NOTIFICATION_TOGGLE = 'notification:toggle' as const;
/** GitLab 연결 테스트 (설정 창 "테스트" 버튼) */
export const SETTINGS_TEST = 'settings:test' as const;

// ── 채널명 타입 유니온 (타입 가드용) ─────────────────────────
export type MainToRendererChannel =
  | typeof REVIEW_CHUNK
  | typeof REVIEW_DONE
  | typeof REVIEW_ERROR
  | typeof MR_NEW
  | typeof TRAY_STATE_CHANGED;

export type RendererToMainChannel =
  | typeof REVIEW_START
  | typeof REVIEW_ABORT
  | typeof COMMENT_POST
  | typeof SETTINGS_SAVE
  | typeof SETTINGS_LOAD
  | typeof SETTINGS_TEST
  | typeof WINDOW_OPEN_MR
  | typeof NOTIFICATION_TOGGLE;

// ── 기본값/제한 상수 ─────────────────────────────────────────
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 10_000;
export const MAX_SEEN_MR_IDS = 200;
export const MAX_RECENT_MRS = 5;
export const MAX_CHANGES_IN_REVIEW = 10;
export const MAX_DIFF_CHARS = 4000;
export const NEW_MR_BLINK_INTERVAL_MS = 800;

// ── 외부 리소스 URL ──────────────────────────────────────────
/** Claude CLI 설치 안내 URL (ENOENT 에러 메시지에 노출) */
export const CLAUDE_INSTALL_URL = 'https://claude.ai/code' as const;
