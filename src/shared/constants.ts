// shared/constants.ts — v2 IPC 채널 + 기본값

// ── Main → Renderer ─────────────────────────────────────────
/** AI 스트리밍 청크 전달 */
export const REVIEW_CHUNK = 'review:chunk' as const;
/** AI 스트리밍 완료 */
export const REVIEW_DONE = 'review:done' as const;
/** AI 스트리밍 오류 */
export const REVIEW_ERROR = 'review:error' as const;
/** 새 MR/PR 감지 → 리뷰 윈도우에 Item 정보 주입 (v2 신규) */
export const ITEM_NEW = 'item:new' as const;
/** @deprecated 하위호환 alias (ITEM_NEW로 전환) */
export const MR_NEW = ITEM_NEW;
/** 트레이 상태 변경 브로드캐스트 */
export const TRAY_STATE_CHANGED = 'tray:state-changed' as const;

// ── Renderer → Main ─────────────────────────────────────────
/** 리뷰 시작 요청 (ReviewItemSummary 전달) */
export const REVIEW_START = 'review:start' as const;
/** 리뷰 중단 요청 */
export const REVIEW_ABORT = 'review:abort' as const;
/** 리뷰 댓글 등록 요청 */
export const COMMENT_POST = 'comment:post' as const;
/** 전체 설정 저장 요청 (v1 호환) */
export const SETTINGS_SAVE = 'settings:save' as const;
/** 전체 설정 로드 요청 */
export const SETTINGS_LOAD = 'settings:load' as const;
/** 브라우저로 MR/PR URL 열기 */
export const WINDOW_OPEN_MR = 'window:open-mr' as const;
/** 알림 토글 (ACTIVE ↔ MUTED) */
export const NOTIFICATION_TOGGLE = 'notification:toggle' as const;

// ── v2 신규 IPC ─────────────────────────────────────────────
export const GIT_CONNECTIONS_LOAD = 'git:connections:load' as const;
export const GIT_CONNECTIONS_SAVE = 'git:connections:save' as const;
export const GIT_CONNECTION_TEST = 'git:connection:test' as const;

export const AI_CONFIG_LOAD = 'ai:config:load' as const;
export const AI_CONFIG_SAVE = 'ai:config:save' as const;
export const AI_AVAILABILITY_TEST = 'ai:availability:test' as const;
/** 탭 드래그 시작: main 프로세스에 알림 */
export const TAB_DRAG_START  = 'review:tab-drag-start'  as const;
/** 탭 드래그 종료 (취소 — pointercancel) */
export const TAB_DRAG_END    = 'review:tab-drag-end'    as const;
/** 탭 드래그 릴리즈: main 프로세스가 드롭 위치 판단 → 분리/병합/취소 */
export const TAB_DRAG_DROP   = 'review:tab-drag-drop'   as const;
/** Main → Renderer: 탭 분리 완료 → closeById 실행 */
export const TAB_DRAG_DETACH = 'review:tab-drag-detach' as const;

export const OLLAMA_MODELS_FETCH = 'ollama:models:fetch' as const;

/** 목록 윈도우 — 현재 open MR + interaction 조회 */
export const LIST_LOAD = 'list:load' as const;
/** 목록 윈도우 → main: 특정 아이템에 대한 AI 리뷰 시작 요청 */
export const LIST_OPEN_REVIEW = 'list:open-review' as const;
/** 목록 업데이트 브로드캐스트 (poller tick 이후 main → list 윈도우) */
export const LIST_UPDATED = 'list:updated' as const;
/** 목록 윈도우 → main: 즉시 폴링 요청 */
export const LIST_REFRESH = 'list:refresh' as const;

// ── 채널명 타입 유니온 ──────────────────────────────────────
export type MainToRendererChannel =
  | typeof REVIEW_CHUNK
  | typeof REVIEW_DONE
  | typeof REVIEW_ERROR
  | typeof ITEM_NEW
  | typeof TRAY_STATE_CHANGED;

export type RendererToMainChannel =
  | typeof REVIEW_START
  | typeof REVIEW_ABORT
  | typeof COMMENT_POST
  | typeof SETTINGS_SAVE
  | typeof SETTINGS_LOAD
  | typeof WINDOW_OPEN_MR
  | typeof NOTIFICATION_TOGGLE
  | typeof GIT_CONNECTIONS_LOAD
  | typeof GIT_CONNECTIONS_SAVE
  | typeof GIT_CONNECTION_TEST
  | typeof AI_CONFIG_LOAD
  | typeof AI_CONFIG_SAVE
  | typeof AI_AVAILABILITY_TEST
  | typeof OLLAMA_MODELS_FETCH;

// ── 기본값 / 제한 상수 ──────────────────────────────────────
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS = 10_000;
export const MAX_SEEN_ITEM_IDS = 200;
export const MAX_RECENT_ITEMS = 20;
export const MAX_CHANGES_IN_REVIEW = 10;
export const MAX_DIFF_CHARS = 4000;
export const NEW_MR_BLINK_INTERVAL_MS = 800;

// ── 외부 리소스 URL ─────────────────────────────────────────
export const CLAUDE_INSTALL_URL = 'https://claude.ai/code' as const;
export const CODEX_INSTALL_URL = 'https://github.com/openai/codex' as const;

// ── Anthropic 모델 기본 목록 (설정 UI 드롭다운) ──────────────
export const ANTHROPIC_MODELS: readonly string[] = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6' as const;

// ── OpenAI 모델 기본 목록 (힌트, 사용자 자유 입력 가능) ──────
export const OPENAI_MODELS: readonly string[] = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o1-mini',
] as const;

export const DEFAULT_OPENAI_MODEL = 'gpt-4o' as const;
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1' as const;
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434' as const;

// ── Provider 라벨 (트레이 프리픽스) ─────────────────────────
export const PROVIDER_SHORT_LABEL: Record<'gitlab' | 'github', string> = {
  gitlab: 'GL',
  github: 'GH',
};

export const PROVIDER_DISPLAY_NAME: Record<'gitlab' | 'github', string> = {
  gitlab: 'GitLab',
  github: 'GitHub',
};
