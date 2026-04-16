// shared/types.ts — v2 타입 정의 (strict mode, no `any` allowed)

// ── Git Provider (v2) ───────────────────────────────────────
export type GitProviderType = 'gitlab' | 'github';

export interface GitLabConfig {
  type: 'gitlab';
  id: string;          // crypto.randomUUID() 로 생성
  label?: string;      // 사용자 표시 이름 (optional)
  url: string;         // self-hosted or https://gitlab.com
  token: string;
  userId: number;
}

export interface GitHubConfig {
  type: 'github';
  id: string;
  label?: string;
  token: string;
  username: string;    // review_requested / assignee 필터링용
}

export type GitConfig = GitLabConfig | GitHubConfig;

// ── AI Provider (v2) ────────────────────────────────────────
export type AIProviderType =
  | 'claude-cli'
  | 'codex-cli'
  | 'anthropic-api'
  | 'openai-api'
  | 'ollama';

export interface ClaudeCLIConfig {
  type: 'claude-cli';
  execPath?: string;
}

export interface CodexCLIConfig {
  type: 'codex-cli';
  execPath?: string;
}

export interface AnthropicAPIConfig {
  type: 'anthropic-api';
  apiKey: string;
  model: string;
}

export interface OpenAIAPIConfig {
  type: 'openai-api';
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface OllamaConfig {
  type: 'ollama';
  baseUrl: string;
  model: string;
}

export type AIConfig =
  | ClaudeCLIConfig
  | CodexCLIConfig
  | AnthropicAPIConfig
  | OpenAIAPIConfig
  | OllamaConfig;

// ── Review Item (MR + PR 통합) ──────────────────────────────
export interface ReviewItemAuthor {
  id: number;
  name: string;
  username: string;
  avatar_url: string;
}

export interface ItemChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/** 폴링 목록용 — changes 없음, 경량 */
export interface ReviewItemSummary {
  /**
   * 복합 ID: `${gitConfigId}::${providerType}::${projectId}::${itemId}` (4-part)
   * delimiter는 `::` 고정 — gitConfigId의 UUID가 `-` 를 포함하기 때문.
   * `id.split('::')` 결과 length 정확히 4.
   */
  id: string;
  gitConfigId: string;
  providerType: GitProviderType;
  /** 트레이 메뉴 프리픽스 표시용: "GL" | "GH" */
  providerLabel: string;
  /** GitLab iid / GitHub PR number */
  itemId: number;
  title: string;
  description: string;
  author: ReviewItemAuthor;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  /** GitLab projectId / GitHub repo DB id */
  projectId: number;
  /** GitHub 전용: "{owner}/{repo}" — GitHub API 호출에 필요. GitLab에서는 undefined */
  repoFullName?: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}

/** 리뷰/상세용 — changes 필수 */
export interface ReviewItemWithChanges extends ReviewItemSummary {
  changes: ItemChange[];
}

/** 하위 호환 alias — 두 타입을 모두 수용해야 하는 컨텍스트에서 사용 */
export type ReviewItem = ReviewItemSummary | ReviewItemWithChanges;

// ── 트레이 상태 ─────────────────────────────────────────────
export type TrayState = 'ACTIVE' | 'MUTED' | 'NEW_MR' | 'ERROR';

export type ReviewState = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

export type NotificationAction = 'open' | 'review';

/** 연결별 헬스 — 트레이 메뉴 상태바에 "GitLab ✓ · GitHub ✗" 표시용 */
export interface ConnectionHealth {
  gitConfigId: string;
  providerType: GitProviderType;
  label: string; // 표시 이름 ("GitLab" | "GitHub" | config.label)
  ok: boolean;
  lastCheckedAt?: string;
  error?: string;
}

// ── AppSettings (v2) ────────────────────────────────────────
export interface AppSettings {
  gitConnections: GitConfig[]; // [] 이면 미설정 상태
  ai: AIConfig;                // 기본값: { type: 'claude-cli' }
  pollIntervalMs: number;
  notificationEnabled: boolean;
  launchOnStartup: boolean;    // Windows 로그인 시 자동 시작
}

// ── StoreSchema (v2) ────────────────────────────────────────
export interface StoreSchema {
  settings: AppSettings;
  seenItemIds: string[];            // v1 seenMrIds: number[] 마이그레이션 대상
  recentItems: ReviewItemSummary[]; // 최대 5개
}

// ── IPC 페이로드 타입 ───────────────────────────────────────
export interface ReviewStartPayload {
  item: ReviewItemSummary; // 리뷰 시작 시 summary 전달 → main에서 changes fetch
}

export interface ReviewChunkPayload {
  chunk: string;
}

export interface ReviewErrorPayload {
  message: string;
}

/** v2 댓글 등록 — gitConfigId로 provider 라우팅 */
export interface CommentPostPayload {
  gitConfigId: string;
  itemId: number;
  projectId: number;           // GitLab projectId / GitHub repo id
  repoFullName?: string;       // GitHub 전용
  body: string;
}

export interface CommentPostResult {
  success: boolean;
  /** GitLab: discussion id / GitHub: comment id */
  commentId?: string;
  error?: string;
}

export interface NotificationClickPayload {
  action: NotificationAction;
  itemId: string; // ReviewItemSummary.id
}

export interface TrayStateChangedPayload {
  state: TrayState;
  lastCheckedAt: string; // ISO 8601
  connections: ConnectionHealth[];
}

// ── Git 연결 IPC ────────────────────────────────────────────
export interface GitConnectionsLoadResult {
  gitConnections: GitConfig[];
}

export interface GitConnectionsSavePayload {
  gitConnections: GitConfig[];
}

export interface GitConnectionTestPayload {
  config: GitConfig;
}

/**
 * Git 연결 테스트 결과 — GitLab은 userId, GitHub은 username을 채움.
 * 호출 측(설정 UI)이 config.type 으로 분기하여 사용.
 */
export interface ConnectionTestResult {
  success: boolean;
  userId?: number;
  username?: string;
  error?: string;
}

/** @deprecated ConnectionTestResult 사용 — alias 유지만을 위한 타입 */
export type GitConnectionTestResult = ConnectionTestResult;

// ── AI 설정 IPC ─────────────────────────────────────────────
export interface AIConfigLoadResult {
  ai: AIConfig;
}

export interface AIConfigSavePayload {
  ai: AIConfig;
}

export interface AIAvailabilityTestPayload {
  config: AIConfig;
}

export interface AIAvailabilityTestResult {
  success: boolean;
  version?: string;
  error?: string;
}

// ── Ollama 모델 목록 IPC ────────────────────────────────────
export interface OllamaModelsFetchPayload {
  baseUrl: string;
}

export interface OllamaModelsFetchResult {
  success: boolean;
  models?: string[];
  error?: string;
}

// ── 설정 저장/로드 (전체 AppSettings) ───────────────────────
export interface SettingsSavePayload {
  settings: AppSettings;
}

export interface SettingsLoadResult {
  settings: AppSettings;
}

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
