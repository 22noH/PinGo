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

// ── v3 신규 IPC — Jira ─────────────────────────────────────
export const JIRA_CONNECTIONS_LOAD = 'jira:connections:load' as const;
export const JIRA_CONNECTIONS_SAVE = 'jira:connections:save' as const;
export const JIRA_CONNECTION_TEST = 'jira:connection:test' as const;
/** Renderer → Main: 현재 Jira webhook secret 조회 (없으면 생성 후 반환) */
export const JIRA_WEBHOOK_SECRET_GET = 'jira:webhook:secret:get' as const;
/** Renderer → Main: Jira webhook secret 재생성 (webhook 서버 재시작 포함) */
export const JIRA_WEBHOOK_SECRET_REGENERATE = 'jira:webhook:secret:regenerate' as const;
/** Main → Renderer: 새 Jira 이슈 발생 (리스트/트레이 알림용) */
export const JIRA_ISSUE_NEW = 'jira:issue:new' as const;
/** Main → Renderer: 리스트 윈도우 Jira 섹션 업데이트 브로드캐스트 */
export const LIST_JIRA_UPDATED = 'list:jira:updated' as const;

// ── v3 신규 IPC — 브랜치 ───────────────────────────────────
export const BRANCH_CREATE = 'branch:create' as const;
export const BRANCH_LIST   = 'branch:list'   as const;
/** 사용자가 접근 가능한 프로젝트/저장소 목록 조회 */
export const PROJECT_LIST  = 'project:list'  as const;
/** 리뷰 캐시 조회 (렌더러 → 메인): itemId 로 이전 AI 리뷰 마크다운 반환 */
export const REVIEW_CACHE_LOAD = 'review:cache:load' as const;
/** 리뷰 캐시 저장 (렌더러 → 메인): itemId + markdown */
export const REVIEW_CACHE_SAVE = 'review:cache:save' as const;

// ── v3 신규 IPC — 댓글 답글 ────────────────────────────────
export const COMMENT_REPLY = 'comment:reply' as const;

// ── MR 액션 — 파이프라인 실행 / AI 충돌 머지 ────────────────
/** MR 파이프라인 새로 실행 (Renderer → Main, invoke) */
export const PIPELINE_RUN = 'pipeline:run' as const;
/** AI 충돌 해결 머지 시작 (Renderer → Main, invoke — 완료까지 대기) */
export const MERGE_AI_START = 'merge:ai:start' as const;
/** AI 머지 결과를 MR 브랜치에 push (Renderer → Main, invoke) */
export const MERGE_AI_PUSH = 'merge:ai:push' as const;
/** Main → Renderer: AI 머지 진행 상황 한 줄씩 */
export const MERGE_AI_PROGRESS = 'merge:ai:progress' as const;

// ── 자동 업데이트 ───────────────────────────────────────────
/** 다운로드 완료된 업데이트 버전 조회 (Renderer → Main, invoke) — 없으면 null */
export const UPDATE_STATUS_GET = 'update:status:get' as const;
/** 재시작하여 업데이트 적용 (Renderer → Main) */
export const UPDATE_INSTALL = 'update:install' as const;
/** Main → Renderer: 업데이트 다운로드 완료 브로드캐스트 (payload: 버전 문자열) */
export const UPDATE_READY = 'update:ready' as const;

// ── v3 신규 IPC — 프로젝트 필터 ────────────────────────────
export const PROJECT_FILTERS_LOAD = 'project-filters:load' as const;
export const PROJECT_FILTERS_SAVE = 'project-filters:save' as const;

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
  | typeof TRAY_STATE_CHANGED
  | typeof JIRA_ISSUE_NEW
  | typeof LIST_JIRA_UPDATED
  | typeof MERGE_AI_PROGRESS
  | typeof UPDATE_READY;

export type RendererToMainChannel =
  | typeof REVIEW_START
  | typeof REVIEW_ABORT
  | typeof COMMENT_POST
  | typeof COMMENT_REPLY
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
  | typeof OLLAMA_MODELS_FETCH
  | typeof JIRA_CONNECTIONS_LOAD
  | typeof JIRA_CONNECTIONS_SAVE
  | typeof JIRA_CONNECTION_TEST
  | typeof JIRA_WEBHOOK_SECRET_GET
  | typeof JIRA_WEBHOOK_SECRET_REGENERATE
  | typeof BRANCH_CREATE
  | typeof BRANCH_LIST
  | typeof PROJECT_LIST
  | typeof REVIEW_CACHE_LOAD
  | typeof REVIEW_CACHE_SAVE
  | typeof PROJECT_FILTERS_LOAD
  | typeof PROJECT_FILTERS_SAVE
  | typeof PIPELINE_RUN
  | typeof MERGE_AI_START
  | typeof MERGE_AI_PUSH
  | typeof UPDATE_STATUS_GET
  | typeof UPDATE_INSTALL;

// ── 기본값 / 제한 상수 ──────────────────────────────────────
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** 대시보드 창 여는 전역 단축키 기본값 */
export const DEFAULT_DASHBOARD_HOTKEY = 'CommandOrControl+Shift+D';
export const MIN_POLL_INTERVAL_MS = 10_000;
export const MAX_SEEN_ITEM_IDS = 200;
export const MAX_RECENT_ITEMS = 20;
/**
 * AI 리뷰 프롬프트에 포함할 파일 수 상한.
 * Claude Sonnet/Opus 200K 컨텍스트 기준으로 충분한 여유 → 30까지 확대.
 * 기존 10은 너무 보수적이라 대형 MR 에서 새 커밋의 파일이 잘려 AI가 못 보는 버그 유발.
 */
export const MAX_CHANGES_IN_REVIEW = 30;
/**
 * 각 파일 diff 문자 수 상한.
 * 기존 4000 → 12000 으로 확대. 큰 리팩터링/포맷 변경도 거의 안 잘림.
 */
export const MAX_DIFF_CHARS = 12_000;
export const NEW_MR_BLINK_INTERVAL_MS = 800;

// ── v3 Jira 상수 ────────────────────────────────────────────
export const DEFAULT_JIRA_WEBHOOK_PORT = 9876;
/** @deprecated — path 기반으로 변경. JIRA_WEBHOOK_PATH_PREFIX + token 사용. */
export const JIRA_WEBHOOK_PATH = '/jira-webhook' as const;
/** v3 webhook URL 은 path 방식: `${JIRA_WEBHOOK_PATH_PREFIX}${token}` (§20.12.A / §20.13.C1) */
export const JIRA_WEBHOOK_PATH_PREFIX = '/jira-webhook/' as const;
/** body 상한 1MB (§20.13.C2) */
export const JIRA_WEBHOOK_BODY_LIMIT_BYTES = 1_048_576;
/** 소켓 타임아웃 5초 (§20.12.A) */
export const JIRA_WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
export const MAX_RECENT_JIRA_ISSUES = 20;
export const MAX_SEEN_JIRA_ISSUE_IDS = 200;
export const MAX_SEEN_PIPELINE_IDS = 200;
export const MAX_SEEN_APPROVAL_ITEM_IDS = 200;
/** v3 브랜치 — slug 부분만의 한도 (전체 branchName 한도 아님, §20.13.I4) */
export const BRANCH_NAME_MAX_SLUG_LEN = 40;
/** v3 브랜치 — 전체 branchName 한도 (Git 기본 255자, §20.13.I4) */
export const BRANCH_NAME_MAX_TOTAL_LEN = 255;
/** @deprecated — BRANCH_NAME_MAX_SLUG_LEN 로 rename. alias 만 유지. */
export const BRANCH_NAME_MAX_LEN = BRANCH_NAME_MAX_SLUG_LEN;
export const BRANCH_NAME_PREFIX = 'feature' as const;
/** Jira REST API path (v3 우선, v2 fallback) */
export const JIRA_API_PATH = '/rest/api/3' as const;
export const JIRA_API_PATH_SERVER_FALLBACK = '/rest/api/2' as const;

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

// ── Claude CLI 모델 별칭 (설정 UI 드롭다운) ──────────────────
// CLI는 별칭(sonnet/opus/haiku) 또는 전체 model id 허용. 빈 값이면 CLI 기본 사용.
export const CLAUDE_CLI_MODELS: readonly string[] = [
  '',        // 기본(미지정)
  'haiku',   // 가장 저렴 — 토큰 절약
  'sonnet',  // 균형
  'opus',    // 고성능(고비용)
] as const;

// ── Codex CLI (OpenAI) 모델/reasoning effort ────────────────
// Codex는 -m <model> + -c model_reasoning_effort=<level> 사용
export const CODEX_CLI_MODELS: readonly string[] = [
  '',          // 기본(config.toml)
  'gpt-5-codex',
  'o3',
  'o4-mini',
] as const;

export const CODEX_CLI_EFFORTS: readonly string[] = [
  '',          // 기본
  'minimal',
  'low',
  'medium',
  'high',
] as const;

// ── Claude CLI --effort 레벨 (토큰 예산 제어) ────────────────
// 빈 값 → CLI 기본(high) 사용. 낮출수록 토큰/비용 절감.
export const CLAUDE_CLI_EFFORTS: readonly string[] = [
  '',        // 기본(high)
  'low',     // 1 — 가장 절약
  'medium',  // 2
  'high',    // 3 — API 기본
  'xhigh',   // 4 — Opus 4.7 전용 권장
  'max',     // 5 — 무제한
] as const;

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
