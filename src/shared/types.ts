// shared/types.ts — v2 타입 정의 (strict mode, no `any` allowed)
// v3 확장 타입은 types-jira.ts / types-v3.ts 에 분리 — 여기서는 re-export만.
// v1 raw + deprecated alias 는 types-compat.ts 로 분리.
export * from './types-jira';
export * from './types-v3';
export * from './types-compat';

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

/** Claude Code CLI `--effort <level>` 허용값 */
export type ClaudeCLIEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeCLIConfig {
  type: 'claude-cli';
  execPath?: string;
  /** 모델 별칭 또는 전체 id (예: 'haiku', 'sonnet', 'opus', 'claude-sonnet-4-6'). 빈값/undefined → CLI 기본 */
  model?: string;
  /** `--effort` 플래그값. 미설정 → CLI 기본(high) */
  effort?: ClaudeCLIEffort;
}

/** Codex CLI `-c model_reasoning_effort=<...>` 허용값 */
export type CodexCLIEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexCLIConfig {
  type: 'codex-cli';
  execPath?: string;
  /** `-m/--model` (예: 'gpt-5.5', 'gpt-5.1-codex-max'). 빈값 → CLI/config 기본 */
  model?: string;
  /** `-c model_reasoning_effort=<level>`. 빈값 → CLI/config 기본 */
  reasoningEffort?: CodexCLIEffort;
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
  /** 현재 사용자와의 관계 감지용. 비어있으면 알 수 없음. */
  reviewers: ReviewItemAuthor[];
  /** 현재 사용자(config)가 이 MR/PR의 리뷰어인지 — normalize 단계에서 계산 */
  viewerIsReviewer: boolean;
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

/** 단일 댓글 (GitLab Note / GitHub Comment 통합) */
export interface DiscussionNote {
  /** 글로벌하게 unique한 note id (문자열 통일) */
  id: string;
  author: ReviewItemAuthor;
  body: string;
  createdAt: string;   // ISO 8601
  /** 현재 사용자를 @mention 했는지 — provider가 계산해서 채움 */
  mentionsCurrentUser: boolean;
}

/** GitLab Discussion / GitHub review-thread 통합. GitHub의 일반 comment는 단일 note thread로 표현. */
export interface Discussion {
  id: string;
  notes: DiscussionNote[];
}

/** 리뷰/상세용 — changes 필수, discussions는 선택적 */
export interface ReviewItemWithChanges extends ReviewItemSummary {
  changes: ItemChange[];
  discussions?: Discussion[];
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

// ── AppSettings (v2 + v3 확장) ──────────────────────────────
/**
 * v3 확장 필드는 모두 optional. v2 저장 데이터도 읽힐 수 있도록 하위호환 유지.
 * 런타임 기본값은 store-migrate.ts 의 DEFAULT_V2_SETTINGS + backfillV2Fields()/migrateStoreV2ToV3() 가 보장.
 */
export interface AppSettings {
  gitConnections: GitConfig[]; // [] 이면 미설정 상태
  ai: AIConfig;                // 기본값: { type: 'claude-cli' }
  pollIntervalMs: number;
  notificationEnabled: boolean;
  /** 내가 작성자/리뷰어/멘션인 MR의 새 댓글 알림 ON/OFF (기본 true) */
  commentNotificationsEnabled: boolean;
  launchOnStartup: boolean;    // Windows 로그인 시 자동 시작

  // ── v3 확장 (optional) ────────────────────────────────
  /** Jira 연결 목록 (기본: []) */
  jiraConnections?: import('./types-jira').JiraConfig[];
  /** 로컬 Jira 웹훅 수신기 활성화 (기본: false — 폴링만 사용) */
  jiraWebhookEnabled?: boolean;
  /** Jira 웹훅 수신 포트 (기본: 9876) */
  jiraWebhookPort?: number;
  /** 프로젝트별 알림 필터 (기본: []) */
  projectFilters?: import('./types-v3').ProjectFilter[];
  /** 파이프라인(CI/CD) 완료 알림 ON/OFF (기본: true) */
  pipelineNotificationsEnabled?: boolean;
  /** MR 승인/변경요청 알림 ON/OFF (기본: true) */
  approvalNotificationsEnabled?: boolean;
  /**
   * 대시보드 창 여는 전역 단축키 (Electron accelerator 포맷, 예: 'CommandOrControl+Shift+D').
   * 빈 문자열/undefined 면 미등록.
   */
  dashboardHotkey?: string;
  /** 새 MR/PR 감지 시 백그라운드 AI 리뷰 자동 실행 → 리뷰 캐시 저장 (기본: false) */
  autoReviewEnabled?: boolean;
  /** AI 머지 시 저장소를 클론할 작업 폴더. 비우면 시스템 임시 폴더 사용 */
  mergeWorkDir?: string;
}

// ── 폴러 이벤트 종류 (v2 3개 + v3 5개) ─────────────────────
export type ItemEventKind =
  | 'new_item'
  | 'reviewer_assigned'
  | 'new_comments'
  // v3 확장
  | 'pipeline_finished'
  | 'mr_approved'
  | 'changes_requested'
  | 'issue_assigned'
  | 'issue_mentioned';

export interface ItemEvent {
  kind: ItemEventKind;
  item: ReviewItemSummary;
  /** kind === 'new_comments' 일 때만 채워짐 — 이번 tick에 감지된 새 댓글 */
  newNotes?: DiscussionNote[];
  /** kind === 'pipeline_finished' 일 때만 (v3) */
  pipelineInfo?: import('./types-v3').PipelineInfo;
  /** kind === 'mr_approved' / 'changes_requested' 일 때만 (v3) */
  approvalStatus?: import('./types-v3').ApprovalStatus;
  /** kind === 'issue_assigned' / 'issue_mentioned' 일 때만 (v3).
   *  이 경우 `item` 은 플레이스홀더 — 소비측은 `issue` 를 우선 사용.
   *  (하위호환: 기존 `item: ReviewItemSummary` 필드 제거 불가) */
  issue?: import('./types-v3').GitIssue;
}

// ── StoreSchema (v2) ────────────────────────────────────────
/** 사용자 인터랙션 기록 — 트레이 목록에 "열어봤음/리뷰함/댓글등록" 상태 표시용 */
export interface ItemInteraction {
  /** 사용자가 MR을 열어본 시각 (트레이/토스트 클릭 — 브라우저/AI 리뷰 포함) */
  openedAt?: string;
  /** AI 리뷰를 성공적으로 완료한 시각 */
  reviewedAt?: string;
  /** 댓글을 등록한 시각 */
  commentedAt?: string;
}

export interface StoreSchema {
  settings: AppSettings;
  seenItemIds: string[];                      // 신규 MR/PR 감지용 (v1 seenMrIds 마이그레이션 대상)
  /** 내가 리뷰어로 지정된 것을 이미 알림으로 받은 item id 집합 */
  seenReviewerItemIds: string[];
  /** item id → 마지막으로 본 note의 ISO 타임스탬프 (새 댓글 감지용) */
  lastSeenNoteAt: Record<string, string>;
  /** item id → 사용자 인터랙션 기록 */
  interactions: Record<string, ItemInteraction>;
  recentItems: ReviewItemSummary[];           // 최대 5개

  // ── v3 확장 (optional) — v2 저장소 호환 ────────────────
  /** 이미 알림 보낸 Jira 이슈 id 집합 (`${jiraConfigId}::${issueKey}`) */
  seenJiraIssueIds?: string[];
  /** 최근 Jira 이슈 (최대 20개) */
  recentJiraIssues?: import('./types-jira').JiraIssueSummary[];
  /** 이미 알림 보낸 pipeline id 집합 (`${gitConfigId}::${projectId}::${pipelineId}`) */
  seenPipelineIds?: string[];
  /** 이미 approve/changes_requested 알림 보낸 MR id 집합 (ReviewItemSummary.id 포맷) */
  seenApprovalItemIds?: string[];
  /**
   * Jira webhook 인증 토큰 — 첫 기동 시 randomBytes(32).toString('hex') 로 채움.
   * timingSafeEqual 비교용. UI "재생성" 시 새 값 저장.
   * 설정 UI 에 표시만, 사용자 직접 입력 금지. (§20.13.I1)
   */
  jiraWebhookToken?: string;
  /**
   * itemId → AI 리뷰 결과(마크다운 텍스트) 캐시.
   * 리뷰 창을 닫거나 목록에서 다른 항목으로 이동해도 재실행 없이 복원 가능.
   * 크기 제한: 최대 200항목, 각 항목 최대 200KB (tail 잘라냄).
   */
  reviewCache?: Record<string, { markdown: string; updatedAt: string }>;
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

/** 알림 이유 — 토스트 body에 표시 (v3: git 8종 + jira 2종) */
export type NotificationReason =
  | 'new_item'
  | 'reviewer_assigned'
  | 'new_comments'
  | 'pipeline_finished'
  | 'mr_approved'
  | 'changes_requested'
  | 'issue_assigned'
  | 'issue_mentioned'
  | 'jira_issue_assigned'
  | 'jira_issue_created';

/** 목록 윈도우 초기 로드/업데이트 페이로드 */
export interface ListLoadResult {
  items: ReviewItemSummary[];
  interactions: Record<string, ItemInteraction>;
  /** 초기 로드 시 현재 보관된 Jira 이슈 스냅샷 (push 업데이트 이전 공백 회피용). 업데이트 푸시에서는 생략. */
  jiraIssues?: import('./types-jira').JiraIssueSummary[];
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

// ── 하위 호환 / v1 raw 스키마는 types-compat.ts 로 분리. types.ts 상단 re-export 로 노출.
