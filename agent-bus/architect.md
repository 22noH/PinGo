STATUS: DONE
PHASE: 1 (v2)
LAST_UPDATED: 2026-04-16
REVISION: 8 — team-lead 최종 확정: `repoFullName` 으로 통일 (구현이 이미 repoFullName 기반, tsc 0 errors 상태). REVISION 7 의 projectPath 복구 지시는 취소. 이 필드명은 더 이상 변경하지 않음.

---

# pingo v2 — Architect 산출물

## 설계 요약

- Git: GitLab + GitHub 복수 연결 (각각 독립 폴링, ReviewItem으로 통합)
- AI: claude-cli / codex-cli / anthropic-api / openai-api / ollama (AIProvider 추상화)
- Store: v1(`gitlabUrl/token/userId`) → v2(`gitConnections[], ai`) 자동 마이그레이션
- IPC: v1 채널 유지 + v2 신규 채널, `MR_NEW`는 deprecated alias로 `ITEM_NEW` 지칭

---

## 1. shared/types.ts — 완전한 타입 정의

> 300줄 초과 방지를 위해 논리 섹션으로 분할해 둡니다. 실제 파일은 단일 `src/shared/types.ts`로 작성하며, v2에서 ~260줄 예상.

### 1.1 Git Provider 타입

```typescript
// shared/types.ts — 섹션 1: Git Providers
// strict mode — no `any` allowed

export type GitProviderType = 'gitlab' | 'github';

export interface GitLabConfig {
  type: 'gitlab';
  id: string;            // crypto.randomUUID()
  label?: string;        // 표시용 별칭 (optional, 없으면 URL 파생)
  url: string;           // self-hosted 또는 https://gitlab.com
  token: string;         // Personal Access Token (glpat-...)
  userId: number;        // reviewer_id 필터링용
}

export interface GitHubConfig {
  type: 'github';
  id: string;
  label?: string;        // 표시용 별칭
  token: string;         // ghp_... (또는 fine-grained token)
  username: string;      // review_requested / assignee 필터용
}

export type GitConfig = GitLabConfig | GitHubConfig;

/** 연결 테스트 결과 (Renderer ↔ Main 공용) */
export interface ConnectionTestResult {
  success: boolean;
  userId?: number;       // GitLab
  username?: string;     // GitHub
  error?: string;
}
```

### 1.2 AI Provider 타입

```typescript
// shared/types.ts — 섹션 2: AI Providers

export type AIProviderType =
  | 'claude-cli'
  | 'codex-cli'
  | 'anthropic-api'
  | 'openai-api'
  | 'ollama';

/** Claude Code CLI (spawn) — execPath 미지정 시 PATH 탐색 */
export interface ClaudeCLIConfig {
  type: 'claude-cli';
  execPath?: string;
}

/** Codex CLI (spawn) — execPath 미지정 시 PATH 탐색 */
export interface CodexCLIConfig {
  type: 'codex-cli';
  execPath?: string;
}

/** Anthropic Messages API (스트리밍) */
export interface AnthropicAPIConfig {
  type: 'anthropic-api';
  apiKey: string;
  model: string;         // ex) 'claude-sonnet-4-6'
}

/** OpenAI 호환 API — baseUrl 교체로 Azure/커스텀 엔드포인트 지원 */
export interface OpenAIAPIConfig {
  type: 'openai-api';
  apiKey: string;
  model: string;         // ex) 'gpt-4o'
  baseUrl?: string;      // 기본: https://api.openai.com/v1
}

/** Ollama (로컬) — baseUrl + 동적 모델 목록 */
export interface OllamaConfig {
  type: 'ollama';
  baseUrl: string;       // 기본: http://localhost:11434
  model: string;         // 예: 'qwen2.5-coder'
}

export type AIConfig =
  | ClaudeCLIConfig
  | CodexCLIConfig
  | AnthropicAPIConfig
  | OpenAIAPIConfig
  | OllamaConfig;

/** AI 가용성 테스트 결과 */
export interface AIAvailabilityResult {
  success: boolean;
  version?: string;      // CLI 버전 또는 모델 이름
  error?: string;
}

/** Ollama 모델 동적 로드 결과 */
export interface OllamaModelsResult {
  success: boolean;
  models?: string[];     // 예: ['qwen2.5-coder:latest', ...]
  error?: string;
}
```

### 1.3 통합 ReviewItem (MR + PR)

```typescript
// shared/types.ts — 섹션 3: Unified ReviewItem

/** MR/PR 공통 작성자 정보 */
export interface ReviewItemAuthor {
  id: number;
  name: string;          // 표시 이름 (GitHub: name || login)
  username: string;      // GitLab username / GitHub login
  avatar_url: string;
}

/** 폴링 목록용 — changes 없음 */
export interface ReviewItemSummary {
  /**
   * 복합 ID: `${gitConfigId}::${providerType}::${projectId}::${itemId}` — 전역 unique.
   * (REVISION 5: 4-part 확정. `projectId` 포함으로 프로젝트 간 itemId 충돌까지 방어)
   *
   * delimiter 는 고정 `::` (2연속 콜론). 이유:
   *  - gitConfigId는 `crypto.randomUUID()`로 `-` 를 4개 포함하므로 `-` 구분자는 역파싱 불가
   *  - UUID 표준 문자(hex + `-`) 및 정수(projectId/itemId)에 `::`는 등장하지 않음 → 안전 분리
   *  - URL 인코딩 불필요 (설정/로그에서 그대로 읽힘)
   *
   * 역파싱은 `id.split('::')` 로 길이 정확히 4 (gitConfigId, providerType, projectIdStr, itemIdStr).
   * projectId/itemId 는 파싱 후 `Number()` 로 복원.
   */
  id: string;
  gitConfigId: string;          // 어느 연결에서 왔는지
  providerType: GitProviderType;
  /**
   * 트레이/알림 제목용 **raw 프리픽스 문자열** (브래킷 없음): `'GL'` | `'GH'`.
   * 값은 `constants.ts` 의 `PROVIDER_SHORT_LABEL[providerType]` 에서 도출.
   * 표시(브래킷 감싸기) 책임은 **소비자**에게 있음:
   *   - tray.ts 메뉴 prefix: `` `[${item.providerLabel}] #${item.itemId}  ${item.title}` ``
   *   - notifier.ts 토스트 제목: `` `[${item.providerLabel}] #${item.itemId} ${item.title}` ``
   *   - review 헤더 뱃지: `` `[${item.providerLabel}]` `` 를 span으로 감싸 렌더
   * (REVISION 6 확정 — 브래킷을 박제한 `'[GL]'` 저장 방식은 채택하지 않음)
   */
  providerLabel: string;
  itemId: number;               // GitLab iid / GitHub PR number
  title: string;
  description: string;
  author: ReviewItemAuthor;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  /** GitLab: project numeric id / GitHub: repo numeric id (files API에서 owner/repo 필요 시 repoFullName 사용) */
  projectId: number;
  /**
   * GitHub 전용: `"owner/repo"` — GitLab에서는 undefined.
   * 필드명은 GitHub 공식 API 의 `repository.full_name` 과 일치시킨 `repoFullName` 으로 **최종 확정**
   * (REVISION 8, team-lead 2026-04-16 — 구현이 이미 repoFullName 기반, tsc 0 errors).
   * 이후 변경 없음.
   */
  repoFullName?: string;
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
}

/** 리뷰/상세용 — changes 필수 */
export interface ReviewItemWithChanges extends ReviewItemSummary {
  changes: ItemChange[];
}

/** MR/PR 변경 파일 공통 표현 */
export interface ItemChange {
  old_path: string;
  new_path: string;
  diff: string;          // unified diff 텍스트 (GitHub patch 포함)
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

/** 하위 호환 alias — union이 필요한 콘텍스트용 */
export type ReviewItem = ReviewItemSummary | ReviewItemWithChanges;
```

### 1.4 App 전역 상태 / Store 스키마

```typescript
// shared/types.ts — 섹션 4: App State

export type TrayState = 'ACTIVE' | 'MUTED' | 'NEW_MR' | 'ERROR';
export type ReviewState = 'idle' | 'loading' | 'streaming' | 'done' | 'error';
export type NotificationAction = 'open' | 'review';

/** v2 AppSettings — 복수 Git + 단일 AI */
export interface AppSettings {
  /** [] 이면 미설정 상태 — 폴링 비활성, 설정 창 유도 */
  gitConnections: GitConfig[];
  /** 기본값: { type: 'claude-cli' } */
  ai: AIConfig;
  pollIntervalMs: number;
  notificationEnabled: boolean;
}

/** electron-store 루트 스키마 */
export interface StoreSchema {
  settings: AppSettings;
  /** 전역 unique ReviewItemSummary.id 목록 (복합 키) */
  seenItemIds: string[];
  /** 트레이 메뉴용 최근 항목 (최대 5개) */
  recentItems: ReviewItemSummary[];
}

/** v1 → v2 마이그레이션 감지용 raw 스키마 (내부 사용) */
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
  recentMrs: unknown[];   // v1 MergeRequestSummary[] (재사용 불필요)
}
```

### 1.5 IPC 페이로드 타입

```typescript
// shared/types.ts — 섹션 5: IPC Payloads

/** 리뷰 시작 — v1 `mr: MergeRequestSummary` → v2 `item: ReviewItemSummary` */
export interface ReviewStartPayload {
  item: ReviewItemSummary;
}

export interface ReviewChunkPayload {
  chunk: string;
}

export interface ReviewErrorPayload {
  message: string;
}

/**
 * v2 댓글 등록 — `gitConfigId` 로 provider 라우팅.
 *
 * 설계 원칙 (REVISION 6 명시):
 *  - `providerType` 은 **포함하지 않는다**. `gitConfigId` 로 store 에서 `GitConfig` 를 조회하면
 *    `type` 이 이미 결정되므로 중복 필드다. (v2 초기 구현에 `providerType` 이 있다면 제거 대상 — §15.4 m1)
 *  - `projectId` / `repoFullName` 은 provider 가 API 호출에 직접 쓰는 식별자. 렌더러는
 *    `ReviewItemSummary` 에서 그대로 실어 보낸다.
 */
export interface CommentPostPayload {
  gitConfigId: string;
  itemId: number;
  projectId: number;        // GitLab projectId / GitHub repo id (provider가 사용)
  repoFullName?: string;    // GitHub 전용 ("owner/repo")
  body: string;
}

export interface CommentPostResult {
  success: boolean;
  /** GitLab: discussion_id / GitHub: comment id */
  commentId?: string;
  error?: string;
}

export interface NotificationClickPayload {
  action: NotificationAction;
  /** 전역 unique ReviewItemSummary.id */
  itemId: string;
}

export interface TrayStateChangedPayload {
  state: TrayState;
  lastCheckedAt: string;    // ISO 8601
  /** 각 Git 연결별 성공/실패 — 트레이 메뉴 상단 상태 라인에 표시 */
  connectionStatus: Array<{
    gitConfigId: string;
    label: string;          // 표시명 (예: "GitLab" 또는 config.label)
    ok: boolean;
  }>;
}

/** v2 설정 저장/로드 — AppSettings 전체가 루트 */
export interface SettingsSavePayload {
  settings: AppSettings;
}

export interface SettingsLoadResult {
  settings: AppSettings;
}

/** GitConfig 부분 편집 payload — 설정 UI용 */
export interface GitConnectionsSavePayload {
  configs: GitConfig[];
}

export interface AIConfigSavePayload {
  config: AIConfig;
}

export interface OllamaModelsFetchPayload {
  baseUrl: string;
}
```

---

## 2. shared/constants.ts — IPC 채널 상수

```typescript
// shared/constants.ts

// ── Main → Renderer ──────────────────────────────────────────
export const REVIEW_CHUNK       = 'review:chunk'        as const;
export const REVIEW_DONE        = 'review:done'         as const;
export const REVIEW_ERROR       = 'review:error'        as const;

/** v2 신규 — ReviewItem (MR+PR 통합) 새로 감지됨 */
export const ITEM_NEW           = 'item:new'            as const;
/**
 * @deprecated v1 alias — 신규 코드는 ITEM_NEW 사용.
 * preload에서 동일 채널 구독 유지 (하위호환).
 */
export const MR_NEW             = ITEM_NEW;

export const TRAY_STATE_CHANGED = 'tray:state-changed'  as const;

// ── Renderer → Main ──────────────────────────────────────────
export const REVIEW_START         = 'review:start'          as const;
export const REVIEW_ABORT         = 'review:abort'          as const;
export const COMMENT_POST         = 'comment:post'          as const;
export const SETTINGS_SAVE        = 'settings:save'         as const;
export const SETTINGS_LOAD        = 'settings:load'         as const;
export const WINDOW_OPEN_MR       = 'window:open-mr'        as const;
export const NOTIFICATION_TOGGLE  = 'notification:toggle'   as const;

/**
 * ~~`SETTINGS_TEST`~~ — **REVISION 6: 제거 확정**.
 *
 * v1 마지막 코드가 단일 GitLab 연결을 테스트하던 채널. v2 구현 시점에 이미 backend/preload 에서
 * 완전 제거되었고 renderer 잔재도 없음. 설계 문서에서 유지할 가치가 없어 **상수/타입 정의 삭제**.
 * 연결 테스트는 `GIT_CONNECTION_TEST` (단일 `GitConfig` 페이로드) 로 일원화.
 */

// ── v2 신규 IPC 채널 ─────────────────────────────────────────
export const GIT_CONNECTIONS_LOAD  = 'git:connections:load'  as const;
export const GIT_CONNECTIONS_SAVE  = 'git:connections:save'  as const;
/** payload: GitConfig (테스트 대상 단일 연결) */
export const GIT_CONNECTION_TEST   = 'git:connection:test'   as const;

export const AI_CONFIG_LOAD        = 'ai:config:load'        as const;
export const AI_CONFIG_SAVE        = 'ai:config:save'        as const;
/** payload: AIConfig */
export const AI_AVAILABILITY_TEST  = 'ai:availability:test'  as const;

/** payload: { baseUrl: string } */
export const OLLAMA_MODELS_FETCH   = 'ollama:models:fetch'   as const;

// ── 채널 타입 유니온 (타입 가드/테스트용) ────────────────────
export type MainToRendererChannel =
  | typeof REVIEW_CHUNK
  | typeof REVIEW_DONE
  | typeof REVIEW_ERROR
  | typeof ITEM_NEW               // MR_NEW는 ITEM_NEW와 동일 값 → 유니온에 중복 추가 금지
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

// ── 기본값/제한 상수 ─────────────────────────────────────────
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const MIN_POLL_INTERVAL_MS     = 10_000;
export const MAX_SEEN_ITEM_IDS        = 200;
export const MAX_RECENT_ITEMS         = 5;
export const MAX_CHANGES_IN_REVIEW    = 10;
export const MAX_DIFF_CHARS           = 4000;
export const NEW_ITEM_BLINK_INTERVAL_MS = 800;

// ── 기본 엔드포인트/모델 ─────────────────────────────────────
export const DEFAULT_OPENAI_BASE_URL  = 'https://api.openai.com/v1' as const;
export const DEFAULT_OLLAMA_BASE_URL  = 'http://localhost:11434'    as const;

/** Anthropic API 모델 고정 목록 — 설정 UI 드롭다운 */
export const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

/** OpenAI 모델 고정 목록 — 사용자 편집 허용(콤보박스) */
export const OPENAI_MODELS_SUGGESTED = [
  'gpt-4o',
  'gpt-4o-mini',
  'o1',
  'o3-mini',
] as const;

// ── Provider 라벨 ────────────────────────────────────────────
/**
 * ReviewItemSummary.providerLabel 의 **raw 값** (브래킷 없음).
 * 소비자(tray/notifier/review header)가 각자의 표시 규약에 따라 `[${label}]` 로 감싸 렌더.
 * (REVISION 6 확정 — v2 초기 구현 `PROVIDER_SHORT_LABEL = { gitlab: 'GL', github: 'GH' }` 와 일치)
 */
export const PROVIDER_SHORT_LABEL: Record<GitProviderType, string> = {
  gitlab: 'GL',
  github: 'GH',
} as const;

// ── 외부 리소스 ──────────────────────────────────────────────
export const CLAUDE_INSTALL_URL = 'https://claude.ai/code' as const;
export const CODEX_INSTALL_URL  = 'https://github.com/openai/codex' as const;
```

---

## 3. preload.ts — contextBridge v2

```typescript
// preload.ts — v2 contextBridge (multi-Git + AI provider)
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  ReviewStartPayload,
  CommentPostPayload,
  CommentPostResult,
  SettingsSavePayload,
  SettingsLoadResult,
  ReviewChunkPayload,
  ReviewErrorPayload,
  ReviewItem,
  TrayStateChangedPayload,
  ConnectionTestResult,
  GitConfig,
  AIConfig,
  AIAvailabilityResult,
  OllamaModelsResult,
} from './shared/types';
import {
  REVIEW_START, REVIEW_ABORT, REVIEW_CHUNK, REVIEW_DONE, REVIEW_ERROR,
  COMMENT_POST, SETTINGS_SAVE, SETTINGS_LOAD, SETTINGS_TEST,
  WINDOW_OPEN_MR, NOTIFICATION_TOGGLE,
  ITEM_NEW, TRAY_STATE_CHANGED,
  GIT_CONNECTIONS_LOAD, GIT_CONNECTIONS_SAVE, GIT_CONNECTION_TEST,
  AI_CONFIG_LOAD, AI_CONFIG_SAVE, AI_AVAILABILITY_TEST,
  OLLAMA_MODELS_FETCH,
} from './shared/constants';

export interface ElectronAPI {
  // ── Renderer → Main (fire-and-forget) ───────────────────────
  startReview: (payload: ReviewStartPayload) => void;
  abortReview: () => void;
  openMrInBrowser: (webUrl: string) => void;
  toggleNotification: () => void;

  // ── Renderer → Main (invoke, 기존 v1 유지) ──────────────────
  postComment: (payload: CommentPostPayload) => Promise<CommentPostResult>;
  saveSettings: (payload: SettingsSavePayload) => Promise<void>;
  loadSettings: () => Promise<SettingsLoadResult>;
  /** @deprecated v1 호환 — 첫 번째 GitLab 연결에 위임. v2는 testGitConnection 사용 */
  testConnection: () => Promise<ConnectionTestResult>;

  // ── Renderer → Main (v2 신규) ───────────────────────────────
  loadGitConnections: () => Promise<GitConfig[]>;
  saveGitConnections: (configs: GitConfig[]) => Promise<void>;
  testGitConnection: (config: GitConfig) => Promise<ConnectionTestResult>;

  loadAIConfig: () => Promise<AIConfig>;
  saveAIConfig: (config: AIConfig) => Promise<void>;
  testAIAvailability: (config: AIConfig) => Promise<AIAvailabilityResult>;

  fetchOllamaModels: (baseUrl: string) => Promise<OllamaModelsResult>;

  // ── Main → Renderer (이벤트 구독) ───────────────────────────
  onReviewChunk: (cb: (p: ReviewChunkPayload) => void) => () => void;
  onReviewDone: (cb: () => void) => () => void;
  onReviewError: (cb: (p: ReviewErrorPayload) => void) => () => void;
  /**
   * ITEM_NEW — 두 번 수신 가능:
   *  1) 리뷰 윈도우 오픈 시 — ReviewItemSummary (헤더 초기화)
   *  2) REVIEW_START 이후 fetchChanges 완료 시 — ReviewItemWithChanges (파일 목록 갱신)
   * renderer는 `'changes' in item` 로 분기.
   */
  onItemNew: (cb: (item: ReviewItem) => void) => () => void;
  /** @deprecated onItemNew 사용 */
  onMrNew: (cb: (item: ReviewItem) => void) => () => void;
  onTrayStateChanged: (cb: (p: TrayStateChangedPayload) => void) => () => void;
}

const api: ElectronAPI = {
  startReview: (payload) => ipcRenderer.send(REVIEW_START, payload),
  abortReview: () => ipcRenderer.send(REVIEW_ABORT),
  openMrInBrowser: (webUrl) => ipcRenderer.send(WINDOW_OPEN_MR, webUrl),
  toggleNotification: () => ipcRenderer.send(NOTIFICATION_TOGGLE),

  postComment: (p) =>
    ipcRenderer.invoke(COMMENT_POST, p) as Promise<CommentPostResult>,
  saveSettings: (p) =>
    ipcRenderer.invoke(SETTINGS_SAVE, p) as Promise<void>,
  loadSettings: () =>
    ipcRenderer.invoke(SETTINGS_LOAD) as Promise<SettingsLoadResult>,
  testConnection: () =>
    ipcRenderer.invoke(SETTINGS_TEST) as Promise<ConnectionTestResult>,

  loadGitConnections: () =>
    ipcRenderer.invoke(GIT_CONNECTIONS_LOAD) as Promise<GitConfig[]>,
  saveGitConnections: (configs) =>
    ipcRenderer.invoke(GIT_CONNECTIONS_SAVE, configs) as Promise<void>,
  testGitConnection: (config) =>
    ipcRenderer.invoke(GIT_CONNECTION_TEST, config) as Promise<ConnectionTestResult>,

  loadAIConfig: () =>
    ipcRenderer.invoke(AI_CONFIG_LOAD) as Promise<AIConfig>,
  saveAIConfig: (config) =>
    ipcRenderer.invoke(AI_CONFIG_SAVE, config) as Promise<void>,
  testAIAvailability: (config) =>
    ipcRenderer.invoke(AI_AVAILABILITY_TEST, config) as Promise<AIAvailabilityResult>,

  fetchOllamaModels: (baseUrl) =>
    ipcRenderer.invoke(OLLAMA_MODELS_FETCH, { baseUrl }) as Promise<OllamaModelsResult>,

  onReviewChunk: (cb) => {
    const h = (_: IpcRendererEvent, p: ReviewChunkPayload) => cb(p);
    ipcRenderer.on(REVIEW_CHUNK, h);
    return () => ipcRenderer.removeListener(REVIEW_CHUNK, h);
  },
  onReviewDone: (cb) => {
    const h = () => cb();
    ipcRenderer.on(REVIEW_DONE, h);
    return () => ipcRenderer.removeListener(REVIEW_DONE, h);
  },
  onReviewError: (cb) => {
    const h = (_: IpcRendererEvent, p: ReviewErrorPayload) => cb(p);
    ipcRenderer.on(REVIEW_ERROR, h);
    return () => ipcRenderer.removeListener(REVIEW_ERROR, h);
  },
  onItemNew: (cb) => {
    const h = (_: IpcRendererEvent, item: ReviewItem) => cb(item);
    ipcRenderer.on(ITEM_NEW, h);
    return () => ipcRenderer.removeListener(ITEM_NEW, h);
  },
  onMrNew: (cb) => {
    // ITEM_NEW === MR_NEW (동일 채널), alias 유지
    const h = (_: IpcRendererEvent, item: ReviewItem) => cb(item);
    ipcRenderer.on(ITEM_NEW, h);
    return () => ipcRenderer.removeListener(ITEM_NEW, h);
  },
  onTrayStateChanged: (cb) => {
    const h = (_: IpcRendererEvent, p: TrayStateChangedPayload) => cb(p);
    ipcRenderer.on(TRAY_STATE_CHANGED, h);
    return () => ipcRenderer.removeListener(TRAY_STATE_CHANGED, h);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
```

---

## 4. providers/git/git-provider.ts — GitProvider 인터페이스 + Factory

```typescript
// src/main/providers/git/git-provider.ts
import type {
  GitConfig,
  GitLabConfig,
  GitHubConfig,
  ReviewItemSummary,
  ReviewItemWithChanges,
  ConnectionTestResult,
} from '../../../shared/types';

/**
 * 모든 Git 호스팅 어댑터의 공통 계약.
 * poller/ipc는 이 인터페이스에만 의존한다.
 */
export interface GitProvider {
  readonly config: GitConfig;

  /** 리뷰 대기 항목 목록 (MR/PR) — changes 없는 경량 Summary */
  fetchOpenItems(): Promise<ReviewItemSummary[]>;

  /** Summary → changes 포함 상세. item.projectId/repoFullName 활용. */
  fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges>;

  /** AI 리뷰 결과를 MR/PR에 댓글로 등록 */
  postComment(
    item: ReviewItemSummary,
    body: string,
  ): Promise<{ success: boolean; commentId?: string; error?: string }>;

  /**
   * GET /user (또는 동등 엔드포인트) 호출.
   * success=true 이면 userId(GL) 또는 username(GH) 반환 — 설정 UI 자동 입력용.
   */
  testConnection(): Promise<ConnectionTestResult>;
}

/**
 * GitConfig → GitProvider 인스턴스화.
 * 추상 factory — backend가 gitlab-provider/github-provider를 import.
 */
export function createGitProvider(config: GitConfig): GitProvider {
  switch (config.type) {
    case 'gitlab':
      // 동적 require로 순환참조 회피 (backend 구현 시):
      //   const { createGitLabProvider } = require('./gitlab-provider');
      //   return createGitLabProvider(config);
      throw new Error('createGitLabProvider not wired — backend must implement');
    case 'github':
      throw new Error('createGitHubProvider not wired — backend must implement');
    default: {
      // exhaustiveness check
      const _exhaustive: never = config;
      throw new Error(`Unknown GitConfig.type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── 구현 가이드 (backend 참고) ────────────────────────────────

/**
 * GitLabProvider 구현 요구사항:
 *
 *   fetchOpenItems():
 *     GET {url}/api/v4/merge_requests
 *       ?scope=all&state=opened&reviewer_id={userId}
 *       &order_by=updated_at&sort=desc&per_page=20
 *     Header: PRIVATE-TOKEN
 *     → MR[] 매핑 → ReviewItemSummary[]
 *       id: `${config.id}::gitlab::${mr.project_id}::${mr.iid}`   // 4-part `::` (REVISION 5)
 *       itemId: mr.iid
 *       projectId: mr.project_id
 *       providerLabel: PROVIDER_SHORT_LABEL.gitlab    // 'GL' (브래킷 없음 — REVISION 6)
 *       repoFullName: undefined
 *
 *   fetchChanges(item):
 *     GET {url}/api/v4/projects/{item.projectId}/merge_requests/{item.itemId}/changes
 *     GitLab `changes[]` → ItemChange 매핑:
 *       old_path          → old_path
 *       new_path          → new_path
 *       diff              → diff          (이미 unified diff 텍스트)
 *       new_file          → new_file
 *       deleted_file      → deleted_file
 *       renamed_file      → renamed_file
 *
 *   postComment(item, body):
 *     POST {url}/api/v4/projects/{item.projectId}/merge_requests/{item.itemId}/discussions
 *     Body: { body }
 *     success: 201 → commentId = String(resp.id)
 *
 *   testConnection():
 *     GET {url}/api/v4/user → { id, username }
 *     반환: { success: true, userId: resp.id }   (username은 undefined)
 */

/**
 * GitHubProvider 구현 요구사항:
 *
 *   fetchOpenItems():
 *     두 개의 search 호출 병합 (중복 제거):
 *       GET https://api.github.com/search/issues
 *         ?q=is:pr+is:open+review-requested:{username}
 *       GET https://api.github.com/search/issues
 *         ?q=is:pr+is:open+assignee:{username}
 *     Header: Authorization: Bearer {token}, Accept: application/vnd.github+json
 *     각 결과 issue → repo URL에서 owner/repo 파싱 → PR detail 한번 더 호출해 head/base branch 확보
 *       GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}
 *     → ReviewItemSummary 매핑
 *       id: `${config.id}::github::${pr.base.repo.id}::${pr.number}`   // 4-part `::` (REVISION 5)
 *       itemId: pr.number
 *       projectId: pr.base.repo.id  (숫자)
 *       providerLabel: PROVIDER_SHORT_LABEL.github    // 'GH' (브래킷 없음 — REVISION 6)
 *       repoFullName: `${owner}/${repo}`
 *
 *     review-requested / assignee 결과 병합:
 *       Map<number, PullRequest> 로 pr.id 기준 dedupe (한 PR이 양쪽에 모두 나올 수 있음)
 *
 *   fetchChanges(item):
 *     GET https://api.github.com/repos/{item.repoFullName}/pulls/{item.itemId}/files
 *     GitHub `files[]` → ItemChange 매핑 규칙:
 *       old_path          : file.previous_filename ?? file.filename
 *       new_path          : file.filename
 *       diff              : file.patch ?? ''            // binary/너무 큰 파일은 patch 없음 → 빈 문자열
 *       new_file          : file.status === 'added'
 *       deleted_file      : file.status === 'removed'
 *       renamed_file      : file.status === 'renamed'
 *       (status가 'modified'/'changed'/'copied' 등인 경우 new/deleted/renamed 모두 false)
 *
 *   postComment(item, body):
 *     POST https://api.github.com/repos/{item.repoFullName}/issues/{item.itemId}/comments
 *     Body: { body }
 *     success: 201 → commentId = String(resp.id)
 *
 *   testConnection():
 *     GET https://api.github.com/user → { id, login }
 *     반환: { success: true, username: resp.login }   (userId는 undefined)
 *
 * ── testConnection() 반환 규약 (양 provider 공통) ─────────────
 *   ConnectionTestResult.{userId?, username?} 둘 다 optional.
 *   호출 측(설정 UI)은 config.type으로 분기:
 *     if (type === 'gitlab') → result.userId 필드 사용 (숫자 → 폼 자동 입력)
 *     if (type === 'github') → result.username 필드 사용 (문자 → 폼 자동 입력)
 *   실패 시 { success: false, error: '...' }.
 */
```

---

## 5. providers/ai/ai-provider.ts — AIProvider 인터페이스 + Factory

```typescript
// src/main/providers/ai/ai-provider.ts
import type {
  AIConfig,
  AIAvailabilityResult,
} from '../../../shared/types';

/**
 * 스트리밍 리뷰 생성기 공통 계약.
 * review-runner는 이 인터페이스에만 의존한다.
 */
export interface AIProvider {
  readonly config: AIConfig;

  /**
   * prompt 입력 → 토큰/청크 단위 onChunk 스트리밍.
   * 정상 종료 시 onDone, 오류 시 onError (한 번만 호출).
   * 반환값: abort 함수 (중간 취소용).
   */
  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): () => void;

  /**
   * 가용성 체크:
   * - CLI: execPath 또는 PATH 탐색 + `--version` 실행
   * - Anthropic API: GET /v1/models 또는 짧은 ping 메시지
   * - OpenAI API: GET {baseUrl}/models
   * - Ollama: GET {baseUrl}/api/tags (모델 존재 확인)
   */
  testAvailability(): Promise<AIAvailabilityResult>;
}

/**
 * AIConfig → AIProvider 인스턴스화.
 * variant별로 case를 분리해 두어, 새 provider 추가 시
 * default 분기의 `const _exhaustive: never = config` 에서
 * 컴파일 에러가 발생하도록 한다 (TypeScript exhaustive 체크).
 */
export function createAIProvider(config: AIConfig): AIProvider {
  switch (config.type) {
    case 'claude-cli':
      // backend: return createClaudeCLIProvider(config);
      throw new Error('createClaudeCLIProvider not wired — backend must implement');
    case 'codex-cli':
      // backend: return createCodexCLIProvider(config);
      throw new Error('createCodexCLIProvider not wired — backend must implement');
    case 'anthropic-api':
      // backend: return createAnthropicAPIProvider(config);
      throw new Error('createAnthropicAPIProvider not wired — backend must implement');
    case 'openai-api':
      // backend: return createOpenAIAPIProvider(config);
      throw new Error('createOpenAIAPIProvider not wired — backend must implement');
    case 'ollama':
      // backend: return createOllamaProvider(config);
      throw new Error('createOllamaProvider not wired — backend must implement');
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown AIConfig.type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── 구현 가이드 (backend 참고) ────────────────────────────────

/**
 * claude-cli.ts:
 *   spawn(config.execPath ?? 'claude', ['-p', '--output-format', 'stream-json', '--verbose'])
 *   stdin.write(prompt); stdin.end();
 *   stdout 라인 JSON 파싱:
 *     {type:'text', text} → onChunk(text)
 *     {type:'message_stop'} → onDone은 'close' 이벤트로 지연
 *     {type:'error', error:{message}} → onError
 *   testAvailability: spawn('--version') → stdout 수집
 *
 * codex-cli.ts:
 *   spawn(config.execPath ?? 'codex', ['-p', prompt]) — 텍스트 스트림
 *   (prompt가 OS 인수 한계 초과 시 stdin 주입 fallback)
 *   stdout 'data' → onChunk
 *   testAvailability: spawn('--version')
 *
 * anthropic-api.ts:
 *   import Anthropic from '@anthropic-ai/sdk'
 *   const client = new Anthropic({ apiKey: config.apiKey })
 *   const stream = client.messages.stream({ model: config.model, messages: [...] })
 *   stream.on('text', onChunk); stream.on('message', onDone); stream.on('error', onError)
 *   testAvailability: client.models.list() → { version: config.model }
 *
 * openai-api.ts:
 *   import OpenAI from 'openai'
 *   const client = new OpenAI({ apiKey, baseURL: config.baseUrl ?? DEFAULT_OPENAI_BASE_URL })
 *   const stream = await client.chat.completions.create({ model, messages, stream: true })
 *   for await (const chunk of stream) onChunk(chunk.choices[0]?.delta?.content ?? '')
 *   testAvailability: client.models.list()
 *
 * ollama.ts:
 *   POST {baseUrl}/api/generate  { model, prompt, stream: true }
 *   응답 NDJSON: {response:'...'}\n{response:'...'}\n...{done:true}
 *   각 line JSON.parse → onChunk(json.response); done 시 onDone
 *   testAvailability: GET {baseUrl}/api/tags → { models: [...] }
 *   fetchOllamaModels(baseUrl): GET /api/tags 동일 재사용
 */
```

---

## 6. Store 마이그레이션 — v1 → v2

### 6.1 설계

- `main.ts` 부팅 직후 `migrateStoreV1ToV2(store)` 호출
- 판별: `store.get('settings')`에 `gitlabUrl` 키가 있으면 v1
- 변환 후 v1 키(`seenMrIds`, `recentMrs`) 제거, v2 키(`seenItemIds`, `recentItems`) 세팅
- `crypto.randomUUID()`는 Node 20+ 내장 (`import { randomUUID } from 'node:crypto'`)

### 6.1.1 정책 결정 (reviewer 권고 반영)

| 항목 | 결정 | 근거 |
|---|---|---|
| `seenMrIds: number[]` → `seenItemIds: string[]` | **`[]` 로 초기화** | v1 숫자 ID는 `::` 복합키로 매핑할 `gitConfigId` 컨텍스트가 없음. 재매핑 시도는 오류 가능성만 키우고 이득 없음. |
| `recentMrs` → `recentItems` | **`[]` 로 초기화** | `ReviewItemSummary`의 필수 필드(`id/gitConfigId/providerType/providerLabel`) 누락 → 안전한 매핑 불가능. |
| 재알림 위험 | **허용 (1회)** + silent pre-seed로 완화 | 마이그레이션 직후 첫 폴링에서 열린 MR 전체가 '새 MR'로 감지될 수 있음. backend에서 `bootstrapStore` 직후 1회 `fetchOpenItems()` 호출 → 결과를 `seenItemIds`에 선-채움하되 알림/렌더러 이벤트는 발송하지 않음 (§13 silent pre-seed 참조). |
| silent pre-seed **적용 범위** *(REVISION 6 확정)* | **모든 "새 gitConfigId 등록" 시점** | v1→v2 마이그레이션뿐 아니라 (a) `GIT_CONNECTIONS_SAVE` 로 신규 연결이 추가될 때, (b) 기존 연결이 삭제→재추가되어 새 UUID 가 발급될 때에도 동일 문제 발생. `§11.8` orphan pruning 이 삭제 시 seenItemIds 를 prune 하므로, 재추가된 연결에서 모든 open MR/PR 이 "새 MR" 로 감지된다. 따라서 **`GIT_CONNECTIONS_SAVE` 핸들러에서 "신규" gitConfigId 를 감지하면 poller 시작 전에 해당 connection 한정 `fetchOpenItems()` 1회 실행 → 반환 id 들을 seenItemIds 에 선-채움 (알림/ITEM_NEW 없음)**. 구현 가이드는 §13 참조. |

### 6.2 코드

```typescript
// src/main/store-migrate.ts
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  StoreSchema,
  V1AppSettings,
  AppSettings,
  GitLabConfig,
  AIConfig,
} from '../shared/types';
import { DEFAULT_POLL_INTERVAL_MS } from '../shared/constants';

const DEFAULT_AI: AIConfig = { type: 'claude-cli' };

const DEFAULT_V2_SETTINGS: AppSettings = {
  gitConnections: [],
  ai: DEFAULT_AI,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  notificationEnabled: true,
};

function isV1Settings(raw: unknown): raw is V1AppSettings {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'gitlabUrl' in raw &&
    'token' in raw &&
    'userId' in raw &&
    !('gitConnections' in raw)
  );
}

export function migrateStoreV1ToV2(store: Store<StoreSchema>): void {
  // electron-store는 스키마 외 키도 보관하므로 unknown 캐스팅으로 raw 접근
  const rawSettings = store.get('settings') as unknown;

  if (!isV1Settings(rawSettings)) {
    // 이미 v2 또는 초기 상태 — 필요 시 defaults 채움
    if (rawSettings === undefined) {
      store.set('settings', DEFAULT_V2_SETTINGS);
    }
    return;
  }

  log.info('[migrate] v1 AppSettings detected → converting to v2');

  // v1 MR 기준 seenMrIds(number[]) 는 복합키 체계 불일치 → 초기화 (한 번만 재알림 발생)
  // 사용자 경험: 마이그레이션 직후 첫 폴링에서 열린 MR 전부를 '새 MR'로 간주할 수 있음.
  // → 마이그레이션 시점에 fetchOpenItems() 1회 실행해 seenItemIds를 선-채움하는 전략을
  //   backend 구현에서 main.ts 부트스트랩에 넣는다.
  const v1 = rawSettings;

  const newConnection: GitLabConfig | null =
    v1.gitlabUrl && v1.token && v1.userId
      ? {
          type: 'gitlab',
          id: randomUUID(),
          label: undefined,
          url: v1.gitlabUrl,
          token: v1.token,
          userId: v1.userId,
        }
      : null;

  const v2Settings: AppSettings = {
    gitConnections: newConnection ? [newConnection] : [],
    ai: DEFAULT_AI,
    pollIntervalMs: v1.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    notificationEnabled: v1.notificationEnabled ?? true,
  };

  store.set('settings', v2Settings);
  store.set('seenItemIds', []);   // 복합 키 체계로 재시작
  store.set('recentItems', []);

  // v1 잔존 키 제거 (electron-store에 delete 허용)
  store.delete('seenMrIds' as keyof StoreSchema);
  store.delete('recentMrs' as keyof StoreSchema);

  log.info('[migrate] completed — %d gitConnections', v2Settings.gitConnections.length);
}
```

### 6.3 Store 초기화 (main.ts에서 호출)

```typescript
// src/main/store.ts
import Store from 'electron-store';
import type { StoreSchema, AppSettings } from '../shared/types';
import { DEFAULT_POLL_INTERVAL_MS } from '../shared/constants';
import { migrateStoreV1ToV2 } from './store-migrate';

const DEFAULT_SETTINGS: AppSettings = {
  gitConnections: [],
  ai: { type: 'claude-cli' },
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  notificationEnabled: true,
};

export const store = new Store<StoreSchema>({
  name: 'pingo-config',
  defaults: {
    settings: DEFAULT_SETTINGS,
    seenItemIds: [],
    recentItems: [],
  },
  // schema는 v2에서는 loose하게 (union 표현이 JSON Schema로 장황 → validate 최소)
  // 타입 안전성은 TypeScript + 런타임 guard(store-migrate)로 보장
});

// bootstrap (main.ts가 whenReady 직후 호출)
export function bootstrapStore(): void {
  migrateStoreV1ToV2(store);
}
```

---

## 7. 모듈 인터페이스 — poller.ts v2 / ipc.ts v2

### 7.1 poller.ts v2 — 병렬 폴링

```typescript
// src/main/poller.ts — v2 interface
import type { AppSettings, ReviewItemSummary } from '../shared/types';
import type { GitProvider } from './providers/git/git-provider';

export type ItemsFoundCallback = (newItems: ReviewItemSummary[]) => void;

/**
 * 연결별 폴링 상태 — trayStateChanged 페이로드 생성용.
 * poller는 주기마다 각 provider를 병렬 호출(Promise.allSettled)하고,
 * 성공/실패를 이 콜백으로 즉시 방송한다.
 */
export type PollStatusCallback = (status: Array<{
  gitConfigId: string;
  label: string;
  ok: boolean;
  error?: string;
}>) => void;

export interface PollerController {
  /** 설정된 모든 GitProvider에 대해 병렬 폴링 시작 */
  start(): void;
  stop(): void;
  /** pollIntervalMs 또는 providers 목록 변경 시 */
  restart(settings: AppSettings, providers: GitProvider[]): void;
  /** 다음 주기 기다리지 않고 즉시 1회 수행 (설정 저장 직후 등) */
  pollNow(): Promise<void>;
}

export function createPoller(
  settings: AppSettings,
  providers: GitProvider[],
  seenIds: Set<string>,                 // 복합 키 ReviewItemSummary.id
  onFound: ItemsFoundCallback,
  onStatus: PollStatusCallback,
): PollerController;

/**
 * 병렬 폴링 의사 코드:
 *   pollOnce():
 *     const results = await Promise.allSettled(providers.map(p => p.fetchOpenItems()))
 *     const allItems: ReviewItemSummary[] = []
 *     const statuses = []
 *     for (const [i, r] of results.entries()):
 *       const p = providers[i]
 *       if (r.status === 'fulfilled'):
 *         allItems.push(...r.value)
 *         statuses.push({ gitConfigId: p.config.id, label: labelOf(p.config), ok: true })
 *       else:
 *         statuses.push({ ..., ok: false, error: r.reason.message })
 *     onStatus(statuses)
 *     const newItems = allItems.filter(it => !seenIds.has(it.id))
 *     newItems.forEach(it => seenIds.add(it.id))
 *     if (newItems.length > 0) onFound(newItems)
 */
```

### 7.2 ipc.ts v2 — 신규 핸들러 목록

```typescript
// src/main/ipc.ts — v2 핸들러 맵
import type Store from 'electron-store';
import type {
  StoreSchema, AppSettings, GitConfig, AIConfig,
  ReviewStartPayload, CommentPostPayload, CommentPostResult,
  SettingsSavePayload, SettingsLoadResult,
  ConnectionTestResult, AIAvailabilityResult, OllamaModelsResult,
  OllamaModelsFetchPayload,
} from '../shared/types';
import type { TrayController } from './tray';
import type { PollerController } from './poller';
import type { GitProvider } from './providers/git/git-provider';

/**
 * 핸들러 등록 — 모든 채널은 constants.ts 상수만 사용.
 *
 * ipcMain.on (fire-and-forget):
 *   REVIEW_START       → review-runner.startReview(item, aiProvider, gitProvider)
 *   REVIEW_ABORT       → review-runner.abort()
 *   WINDOW_OPEN_MR     → shell.openExternal(url)
 *   NOTIFICATION_TOGGLE→ tray.setState(ACTIVE ↔ MUTED)
 *
 * ipcMain.handle (invoke):
 *   COMMENT_POST             → GitProvider.postComment(item, body) (gitConfigId로 라우팅)
 *   SETTINGS_SAVE            → store.set('settings', payload.settings) + poller.restart
 *   SETTINGS_LOAD            → store.get('settings')
 *   SETTINGS_TEST            → [deprecated] 첫 GitLab 연결에 대해 testConnection 위임
 *
 *   GIT_CONNECTIONS_LOAD     → store.get('settings').gitConnections
 *   GIT_CONNECTIONS_SAVE     → store.set('settings.gitConnections', configs) + providers 재구성 + poller.restart
 *   GIT_CONNECTION_TEST      → createGitProvider(config).testConnection()
 *
 *   AI_CONFIG_LOAD           → store.get('settings').ai
 *   AI_CONFIG_SAVE           → store.set('settings.ai', config) + review-runner 재구성
 *   AI_AVAILABILITY_TEST     → createAIProvider(config).testAvailability()
 *
 *   OLLAMA_MODELS_FETCH      → fetch({baseUrl}/api/tags) → { success, models[] }
 */
export interface IpcDeps {
  store: Store<StoreSchema>;
  tray: TrayController;
  poller: PollerController;
  /** providers를 외부에서 관리 (ipc가 재생성 트리거) */
  rebuildProviders: (configs: GitConfig[]) => GitProvider[];
  /** AIConfig 변경 시 review-runner 재구성 트리거 */
  rebuildAIProvider: (config: AIConfig) => void;
}

export function registerIpcHandlers(deps: IpcDeps): void;

/** 특정 webContents로 스트리밍 청크 전송 (review-runner → renderer) */
export function sendReviewChunk(webContentsId: number, chunk: string): void;
```

### 7.3 review-runner.ts (신규)

```typescript
// src/main/review-runner.ts
import type { WebContents } from 'electron';
import type { ReviewItemSummary, ReviewItemWithChanges } from '../shared/types';
import type { AIProvider } from './providers/ai/ai-provider';
import type { GitProvider } from './providers/git/git-provider';

export interface ReviewRunner {
  /**
   * 1) gitProvider.fetchChanges(item) → ReviewItemWithChanges
   * 2) ITEM_NEW 전송 (ReviewItemWithChanges) — 렌더러 파일 목록 갱신
   * 3) buildPrompt(withChanges) → aiProvider.streamReview(...)
   *    - onChunk: REVIEW_CHUNK 전송
   *    - onDone: REVIEW_DONE
   *    - onError: REVIEW_ERROR
   */
  start(item: ReviewItemSummary, target: WebContents): Promise<void>;
  abort(): void;
}

export function createReviewRunner(
  resolveGitProvider: (gitConfigId: string) => GitProvider | undefined,
  getAIProvider: () => AIProvider,
): ReviewRunner;
```

---

## 8. 트레이 / Notifier 인터페이스 (v2 수정점)

### tray.ts

```typescript
import type { TrayState, ReviewItemSummary } from '../shared/types';

export interface TrayController {
  getState(): TrayState;
  setState(state: TrayState): void;
  /** 복수 Git 연결 상태 라인 표시 */
  updateConnectionStatus(status: Array<{ gitConfigId: string; label: string; ok: boolean }>): void;
  /**
   * 트레이 메뉴 '최근 MR/PR' 갱신 — 각 항목 앞에 providerLabel prefix.
   * 표시 규약 (REVISION 6): `providerLabel` 은 raw `'GL'`/`'GH'` 이므로 tray 가 브래킷을 감싼다.
   *   label: `` `[${it.providerLabel}] #${it.itemId}  ${it.title}` ``
   */
  updateRecentItems(items: ReviewItemSummary[]): void;
  updateLastChecked(at: Date): void;
  destroy(): void;
}

export function createTray(
  iconDir: string,
  onToggleNotification: () => void,
  onOpenSettings: () => void,
  onOpenItem: (webUrl: string) => void,
  onQuit: () => void,
): TrayController;
```

### notifier.ts

```typescript
import type { ReviewItem, NotificationAction } from '../shared/types';

export type NotificationActionCallback = (
  action: NotificationAction,
  item: ReviewItem,
) => void;

/**
 * Windows 토스트. 제목에 providerLabel prefix 포함:
 *   title: `[${item.providerLabel}] #${item.itemId} ${item.title}`
 *   body:  `${item.author.name} · ${item.sourceBranch} → ${item.targetBranch}`
 *   버튼: [열기] [AI 리뷰]
 * (REVISION 6: `providerLabel` 은 raw `'GL'`/`'GH'` → notifier 가 브래킷 감쌈)
 */
export function sendItemNotification(
  item: ReviewItem,
  onAction: NotificationActionCallback,
): void;
```

---

## 9. 프롬프트 구성 (v2)

AIProvider에 공급되는 prompt는 provider 중립적이어야 함 (Claude/Codex/Ollama 모두 동일):

```
# System
당신은 시니어 코드 리뷰어입니다. 아래 {MR|PR}의 변경 사항을 한국어 마크다운으로 간결히 리뷰.
항목: 버그 위험 / 성능 / 보안 / 가독성 / 개선 제안.

# 항목 정보
- 서비스: {providerType === 'gitlab' ? 'GitLab MR' : 'GitHub PR'}
- 제목: {item.title}
- 브랜치: {item.sourceBranch} → {item.targetBranch}
- 작성자: @{item.author.username}
- 설명: {item.description || '(없음)'}

# 변경 파일 ({selected.length}/{item.changes.length}개)

## {change.new_path}  [added|removed|renamed|modified]
```diff
{change.diff.slice(0, MAX_DIFF_CHARS)}
```
...
```

`buildPrompt(item: ReviewItemWithChanges)` 헬퍼는 `src/main/prompt.ts`에 단독 분리 (backend 구현).

---

## 10. 산출물 체크리스트

| 항목 | 위치 | 상태 |
|---|---|---|
| GitConfig / AIConfig / ReviewItem 타입 | shared/types.ts | 설계 완료 |
| IPC 채널 상수 + 유니온 | shared/constants.ts | 설계 완료 |
| preload.ts contextBridge v2 | src/preload.ts | 설계 완료 |
| GitProvider 인터페이스 + factory | providers/git/git-provider.ts | 설계 완료 |
| AIProvider 인터페이스 + factory | providers/ai/ai-provider.ts | 설계 완료 |
| store 마이그레이션 | main/store-migrate.ts | 설계 완료 |
| poller v2 (병렬) | main/poller.ts | 설계 완료 |
| ipc v2 (신규 7 채널) | main/ipc.ts | 설계 완료 |
| review-runner | main/review-runner.ts | 설계 완료 |
| tray v2 | main/tray.ts | 설계 완료 |
| notifier v2 | main/notifier.ts | 설계 완료 |

---

## 11. backend 구현 시 주의사항

1. **providers/git/git-provider.ts의 factory**: 현재 throw로 stub. backend가 `gitlab-provider.ts`, `github-provider.ts`를 만든 뒤 factory 내부 `switch`를 실제 구현으로 교체.
2. **axios 인스턴스 분리**: provider별로 별도 axios 인스턴스(baseURL/headers 프리셋) + 공통 response 인터셉터로 토큰 마스킹 로깅 (v1에서 이미 명시된 패턴 재사용).
3. **GitHub rate limit**: `X-RateLimit-Remaining` 헤더 감지 → 소진 시 다음 주기 스킵 (트레이에 `[GH] ⚠️ rate-limit` 상태 표시). poller의 PollStatusCallback `error` 필드에 기록.
4. **ITEM_NEW 두 번 송신**: 리뷰 윈도우 오픈 시 Summary → REVIEW_START 처리 중 fetchChanges 완료 후 WithChanges. renderer는 `'changes' in item`로 분기 (기존 v1 패턴 유지).
5. **seenItemIds 키 포맷 고정** (REVISION 5): `${gitConfigId}::${providerType}::${projectId}::${itemId}` — 4-part 복합키. delimiter는 `::` (team-lead 지시 + reviewer Critical), projectId 포함으로 동일 itemId 프로젝트 간 충돌도 방지. 단, gitConfigId가 새로 생성되면 (연결 삭제→재추가) 재알림 위험이 발생 — **REVISION 6 방침**: §11.8 orphan pruning (삭제 시점) + §6.1.1 silent pre-seed (추가 시점) 를 쌍으로 적용하여 최종적으로 **사용자 시각에서 재알림 0회** 를 목표로 한다.
6. **frontend가 MR_NEW를 계속 import 가능**: constants에서 alias 유지됨. 신규 코드는 ITEM_NEW 사용 권장.
7. **config.schema — loose schema 유지 전략** *(REVISION 5 정정)*: v1은 JSON Schema로 엄격 validate 했으나 v2 union 타입(`GitConfig`/`AIConfig`)은 JSON Schema 표현이 장황하고 에러 메시지가 나쁨. 따라서 **electron-store `schema` 옵션은 loose 레벨로만 유지** (`settings: { type: 'object' }`, `seenItemIds: { type: 'array', items: { type: 'string' } }`, `recentItems: { type: 'array', maxItems: 5 }`). union 내부 구조는 TS 타입 + 런타임 guard(`store-migrate.ts`의 `isV1Settings`)로 보증. loose schema는 **디스크 파손/외부 편집에 대한 최소 방어선**으로 유지가 구현에서도 이미 채택됨.

8. **Git 연결 변경 시 pruning + silent pre-seed (`GIT_CONNECTIONS_SAVE` 핸들러)** — REVISION 6:
   삭제/추가가 동시에 일어날 수 있으므로 **diff 기반** 으로 처리한다.
   ```ts
   // inside GIT_CONNECTIONS_SAVE handler:
   async function handleGitConnectionsSave(nextConfigs: GitConfig[]): Promise<void> {
     const prev = store.get('settings').gitConnections;
     const prevIds = new Set(prev.map((c) => c.id));
     const nextIds = new Set(nextConfigs.map((c) => c.id));

     // (a) orphan pruning — 삭제된 gitConfigId 제거
     const prunedRecent = store.get('recentItems').filter((it) => nextIds.has(it.gitConfigId));
     const prunedSeen   = store.get('seenItemIds').filter((id) => {
       const [gitConfigId] = id.split('::');
       return nextIds.has(gitConfigId);
     });
     store.set('recentItems', prunedRecent);
     store.set('seenItemIds', prunedSeen);

     // (b) settings 저장 후 provider 재구성
     store.set('settings', { ...store.get('settings'), gitConnections: nextConfigs });
     const providers = rebuildProviders(nextConfigs);

     // (c) silent pre-seed — 신규 gitConfigId 만 대상으로 1회 fetchOpenItems
     //     결과 id 를 seenItemIds 에 추가 (알림/ITEM_NEW 미발송)
     const added = providers.filter((p) => !prevIds.has(p.config.id));
     if (added.length > 0) {
       const results = await Promise.allSettled(added.map((p) => p.fetchOpenItems()));
       const seedIds: string[] = [];
       for (const r of results) {
         if (r.status === 'fulfilled') seedIds.push(...r.value.map((it) => it.id));
         // 실패 시 다음 정규 폴링에서 "새 MR" 로 올라올 수 있으나 재알림 위험은 1회에 한정
       }
       if (seedIds.length > 0) {
         const merged = Array.from(new Set([...store.get('seenItemIds'), ...seedIds]));
         store.set('seenItemIds', merged);
       }
     }

     // (d) poller 재시작
     poller.restart(store.get('settings'), providers);
   }
   ```
   이유:
   - orphan `recentItems` 클릭 시 "AI 리뷰" → `resolveGitProvider(gitConfigId)` 실패. webUrl 브라우저 열기만 되어 일관성 저하.
   - 신규 연결(또는 동일 URL/token 재추가로 새 UUID 발급) 시 첫 폴링에서 **모든** open MR/PR 이 새 항목으로 올라와 스팸 알림 발생. silent pre-seed 가 이를 완전 차단.
   - 적용 범위 = (v1→v2 마이그레이션 부트스트랩) **∪** (`GIT_CONNECTIONS_SAVE` 의 신규 gitConfigId). §6.1.1 참조.

---

## 12. frontend 영향 요약

- **설정 UI**: 단일 폼 → [Git 연결] + [AI] 2탭. 각 GitConfig는 카드로 표시, 추가/편집/삭제. AI는 라디오 + 조건부 폼.
- **리뷰 윈도우**: `ReviewItemSummary/WithChanges` 사용. 필드 rename:
  - `mr.iid` → `item.itemId`
  - `mr.project_id` → `item.projectId`
  - `mr.source_branch` → `item.sourceBranch` (snake→camel)
  - `mr.web_url` → `item.webUrl`
  - provider 뱃지 헤더에 `item.providerLabel` 표시
- **MR_NEW 구독**: `electronAPI.onMrNew` alias는 유지되므로 기존 코드 호환. 신규 코드는 `onItemNew` 사용.

---

## 13. reviewer 사전 리뷰 요청 포인트

- GitHub 중복 PR 병합 정책 (review-requested + assignee 교집합): `id` 기준 dedupe — 구현 시 Map 기반
- seenItemIds 마이그레이션 & **신규 연결 추가**: 첫 폴링에서 대량 '새 MR' 감지 — **silent pre-seed** 적용 (REVISION 6 에서 범위 확장):
  - **트리거 1** `main.ts` 부트스트랩 (v1→v2 마이그레이션 또는 첫 실행): 모든 provider 에 대해 `fetchOpenItems()` 1회 → 전부 seenIds 추가, 알림 미발송
  - **트리거 2** `GIT_CONNECTIONS_SAVE` 에서 **이전 목록에 없던 gitConfigId** 발견 시: 해당 신규 provider 에만 한정하여 동일 루틴 수행 (§11.8 의 코드 예시)
  - 실패 (네트워크/토큰 오류) 시 seed 스킵 — 다음 정규 폴링에서 '새 MR' 로 올라올 수 있으나 1회 한정
- Ollama streaming NDJSON 파싱 에러 복구: 라인 중간 끊김 시 lineBuffer 유지 (claude-cli와 동일 패턴)
- Anthropic SDK 스트리밍 API 버전: `@anthropic-ai/sdk` v0.30+ 기준 `client.messages.stream()` — backend가 package 버전 고정 필요
- electron-store v8: 중첩 키 set(`settings.gitConnections`) 지원 확인됨

---

## 14. REVISION 4 — reviewer 사전 권고 반영 내역

| # | 권고 | 반영 위치 | 요지 |
|---|---|---|---|
| Critical | `ReviewItemSummary.id` delimiter | §1.3, §4, §11.5 | `-` → **`::`** 로 변경. 포맷: `${gitConfigId}::${providerType}::${itemId}`. UUID(`-` 포함) 및 정수와 충돌 없음, `id.split('::')` 로 역파싱 안전. |
| 기타 1 | 마이그레이션 정책 명시 | §6.1.1 (신규 표) | `seenMrIds`→`seenItemIds` 및 `recentMrs`→`recentItems` 모두 **`[]` 초기화** 결정. 1회 재알림 가능성은 silent pre-seed (§13)로 완화. |
| 기타 2 | AIConfig factory exhaustive | §5 | `createAIProvider` switch를 5개 variant별 case로 분리 → 신규 variant 추가 시 `const _exhaustive: never = config` 에서 TS 컴파일 에러 발생. |
| 기타 3 | ItemChange 매핑 스펙 | §4 (GitLab/GitHub 가이드) | GitLab `changes[]` 1:1 매핑, GitHub `files[]` → `old_path: previous_filename ?? filename`, `diff: patch ?? ''` (binary 대비), `new_file/deleted_file/renamed_file`은 `status === 'added'/'removed'/'renamed'` 로 도출. 'modified'/'changed'/'copied' 는 3개 불리언 모두 false. |
| 기타 4 | testConnection 반환 분기 | §4 (양 provider 말미 공통 규약) | `ConnectionTestResult.{userId?, username?}` 둘 다 optional. 호출 측(설정 UI)이 `config.type`으로 분기 선택. GitLab→userId, GitHub→username. 실패 시 `{success:false, error}`. |

---

## 15. REVISION 5 — reviewer 사전 리뷰 결과 반영 (2026-04-16)

### 15.1 설계 문서 정정 (architect 책임, 본 REVISION 에서 해결)

| # | 리뷰 항목 | 조치 | 위치 |
|---|---|---|---|
| M4 | schema "제거" ↔ 실제 loose schema 유지 불일치 | 설계 문서를 **loose schema 유지**로 정정. union 내부는 TS+런타임 guard, 디스크 파손 대비 최소 방어선으로 schema 유지 명문화. | §11.7 |
| M5 | Git 연결 삭제 시 recentItems/seenItemIds orphan | `GIT_CONNECTIONS_SAVE` 핸들러에 pruning 로직 추가 (코드 예시 포함). | §11.8 |

### 15.2 backend 구현 정정 필요 항목 (backend 책임, 본 REVISION 에서는 명시만)

REVISION 4 설계와 실제 `src/` 구현 간 불일치. **설계 문서는 이미 올바른 상태**이며, backend가 REVISION 4를 따라 구현 수정.

| # | 항목 | 설계 문서 (REVISION 4 이후) | 현재 backend 구현 | 조치 |
|---|---|---|---|---|
| C1 | `onMrNew` deprecated alias | §3 preload.ts에 `onMrNew` 포함 | `src/preload.ts` 에 미노출 | backend가 alias 메서드 추가 (설계와 일치시킴) |
| C2 | id delimiter | §1.3에 `::` 확정 (team-lead 지시 + reviewer Critical 반영) | `src/shared/types.ts:88` 주석 `:` 사용, provider들도 `:` 생성 | backend가 `::` 로 교체 (team-lead 지시대로). `projectId` 포함한 4-part 구성은 유지 가능하나 **delimiter는 `::` 고정** — 새 포맷: `${gitConfigId}::${providerType}::${projectId}::${itemId}` |
| M1 | 마이그레이션 이월 정책 | §6.1.1에 `[]` 초기화 확정, silent pre-seed로 재알림 완화 | `store.ts:167-169` 에서 `legacy:gitlab:{MR.id}` prefix 이월 | backend가 이월 로직 제거, `[]` 초기화로 교체 |
| M2 | `ConnectionTestResult` 중복 | §1.1에 `ConnectionTestResult` 단일 타입 | `types.ts`에 `ConnectionTestResult` + `GitConnectionTestResult` 둘 존재 | backend가 `GitConnectionTestResult` 를 `ConnectionTestResult` 로 일원화 (또는 alias) |
| M3 | factory `never` exhaustive | §4, §5에 명시적 default + `never` 가드 | git/ai provider factory에 default 분기 없음 (암묵적) | backend가 default 추가 (미래 variant 방어) |

### 15.3 delimiter 3-part vs 4-part 최종 결정

reviewer가 지적한 backend 구현의 **4-part 복합키(`gitConfigId:providerType:projectId:itemId`)** 는 좋은 개선입니다. `projectId`를 포함하면 같은 `itemId` 정수라도 프로젝트 간 충돌 없이 전역 unique 보장이 더 탄탄합니다. 따라서:

- **최종 포맷 (REVISION 5 확정)**: `${gitConfigId}::${providerType}::${projectId}::${itemId}`
- `id.split('::')` 결과 length 정확히 4
- 파싱 시 `[gitConfigId, providerType, projectIdStr, itemIdStr]` 분해
- `projectId = Number(projectIdStr)`, `itemId = Number(itemIdStr)`
- GitHub의 경우 `projectId = repo DB id` (숫자). `repoFullName` ("owner/repo") 는 복합 id 문자열에 포함하지 않고 별도 필드로 유지 (API 호출 시 `repoFullName` 사용)

§1.3, §4, §11.5 의 이전 3-part 표기는 본 REVISION 5 의 4-part 로 업그레이드 (backend 구현 수정 시 이 포맷 준수).

---

## 15.4 REVISION 6 — reviewer Q1/Q2 확답 + 비차단 관찰 반영 (2026-04-16)

### 설계 문서 정정 (architect 책임, 본 REVISION 에서 해결)

| # | 항목 | 조치 | 위치 |
|---|---|---|---|
| 문서-A | `providerLabel` 값 규약 명확화 | raw 문자열 `'GL'`/`'GH'` 저장 + 소비자(tray/notifier/review header)가 `[${label}]` 표시. 구현의 `PROVIDER_SHORT_LABEL` 과 일치. | §1.3, §2 (`PROVIDER_SHORT_LABEL`), §4 주석 2곳, §8 tray, §9 notifier/prompt |
| 문서-B | `SETTINGS_TEST` 제거 반영 | v2 에서 완전 제거 확정 — 상수 정의/유니온에서 삭제. v1 호환 위임 설명 제거. | §2 (상수/유니온), §3 preload (이미 alias 로만 존재하므로 별도 제거 필요 없음 — backend/preload 에서 미노출이 현재 상태) |
| 문서-C | `CommentPostPayload.providerType` 방침 | 포함하지 않음. `gitConfigId` 로 충분. v2 초기 구현에 존재하면 제거 대상. | §1.5 (CommentPostPayload 주석) |

### backend 구현 정정 필요 항목 (backend 책임, 본 REVISION 에서는 명시만)

| # | 항목 | 설계 (REVISION 6) | 현재 구현 | 조치 |
|---|---|---|---|---|
| ~~M4~~ | ~~`projectPath` → `repoFullName` rename~~ **철회 (REVISION 7)** | 설계 전반 `projectPath` 유지 | v2 구현도 `projectPath` 사용 중 — rename 불필요 | **조치 없음**. team-lead Option A 승인 (2026-04-16): provider-중립 이름 유지가 낫다는 판단으로 원안 유지. §15.5 참조. |
| M6 | `GIT_CONNECTIONS_SAVE` silent pre-seed | §11.8 코드 예시대로 diff 기반 처리 | 현재 없음 (마이그레이션 부트스트랩에만 있음) | backend 가 handler 확장: (a) orphan pruning (기존 M5) + (b) 신규 gitConfigId 대상 `fetchOpenItems()` pre-seed (신규) + (c) poller.restart 순서로 수행 |
| m1 | `CommentPostPayload.providerType` 제거 | 설계에 없음 | `src/shared/types.ts:165-172`, `main/ipc.ts` 댓글 핸들러 | backend 가 페이로드 필드 제거. frontend `review.ts` 의 `postComment()` 호출부도 `providerType` 제거 필요 — frontend 에 공지. |

### frontend 영향 (공지)

- `onMrNew` → `onItemNew` 전환은 이미 frontend 완료 (frontend.md §4 참조).
- ~~M4 rename~~: REVISION 7 에서 철회. frontend 의 `review.ts` 는 기존 `projectPath` 그대로 유지 — 추가 작업 없음.
- m1: `CommentPostPayload.providerType` 제거. `src/renderer/review/review.ts` 의 `postComment()` 호출부도 함께 제거 필요.

### Q1/Q2 최종 답변 요약

- **Q1 (projectPath vs repoFullName)**: REVISION 6 에서는 `repoFullName` 으로 rename 권고했으나, REVISION 7 에서 team-lead Option A 승인으로 **`projectPath` 유지** 로 최종 확정. 설계 문서 전체가 `projectPath` 로 통일됨.
- **Q2 (silent pre-seed 적용 범위)**: v1→v2 마이그레이션 부트스트랩 **∪** `GIT_CONNECTIONS_SAVE` 의 신규 gitConfigId. `§6.1.1` 정책표 + `§11.8` 코드 예시 + `§13` 트리거 설명에 반영 (REVISION 7 에서도 유지).

---

## 15.5 REVISION 7 — team-lead Option A 반영: `projectPath` 로 통일 (2026-04-16)

### 배경
REVISION 6 에서는 reviewer Q1 에 답하며 `repoFullName` 으로 rename 하는 방향으로 확정했으나, team-lead 가 **Option A** 를 승인:
- 이유: 구현 범위(backend 5개 파일 + frontend 1개 파일)가 작지 않고, `projectPath` 가 GitLab/GitHub 양쪽을 아우르는 **provider-중립 이름** 이라 장기적으로 더 적합.
- 결과: REVISION 6 의 M4 지시는 **철회**. 설계 문서 전체를 `projectPath` 로 일괄 통일.

### 변경 사항 (설계 문서만 정정, 구현은 그대로)

| 위치 | 변경 |
|---|---|
| §1.3 `ReviewItemSummary.projectId` 주석 | "필요 시 repoFullName 사용" → "필요 시 projectPath 사용" |
| §1.3 GitHub 전용 필드 | `repoFullName?: string` → `projectPath?: string` (JSDoc 도 provider-중립 설명으로 재작성) |
| §1.5 `CommentPostPayload` | `repoFullName?: string` → `projectPath?: string` (JSDoc 내부 언급 포함) |
| §4 `GitProvider.fetchChanges` 주석 | "item.projectId/repoFullName" → "item.projectId/projectPath" |
| §4 GitLab/GitHub 구현 가이드 | id 매핑 예시 `repoFullName: ...` → `projectPath: ...` (2곳) |
| §4 GitHub API URL 예시 | `{item.repoFullName}` → `{item.projectPath}` (files, issues/comments 2곳) |
| §15.3 4-part delimiter 설명 | "API 호출 시 `repoFullName`/`projectPath` 별도 사용" → "API 호출 시 `projectPath` 사용" |
| §15.4 M4 행 | **철회** 표시 (~~취소선~~ + "REVISION 7" 명시) |
| §15.4 frontend 공지 | M4 라인 철회 명시 |
| §15.4 Q1 최종 답변 | REVISION 7 결정 반영 |

### 영향 범위
- **backend**: 추가 작업 **없음**. REVISION 6 기준으로 남아있던 M4 지시가 사라지고, C1/C2/M1/M3/M6/m1 만 정정 대상.
- **frontend**: 추가 작업 **없음**. `review.ts` 의 `projectPath` 필드 그대로 사용. (m1 의 `providerType` 제거는 별건으로 그대로 필요)
- **reviewer**: 2차 리뷰 시 `projectPath` 로 일관성 확인.

---

---

## 15.6 REVISION 8 — team-lead 최종 확정: `repoFullName` (2026-04-16)

### 배경
REVISION 7 의 `projectPath` 복구 지시는 team-lead 에 의해 **취소**. 현재 구현 상태:
- `src/shared/types.ts`: `repoFullName` (구현 완료)
- `src/renderer/review/review.ts`: `repoFullName` (구현 완료)
- `src/main/ipc.ts`, `src/main/providers/git/github-provider.ts`: `repoFullName` 으로 통일
- `tsc -p tsconfig.json --noEmit` → **0 errors** (repoFullName 기준 통과)

코드가 이미 `repoFullName` 기준으로 완성되어 있어 설계 문서가 구현을 따라가도록 재정렬. **team-lead 명시: "이 필드명은 더 이상 변경하지 않음".**

### 변경 사항 (설계 문서만 재정정 — 구현은 그대로)

| 위치 | REVISION 8 최종 값 |
|---|---|
| §1.3 `ReviewItemSummary.projectId` 주석 | "필요 시 **repoFullName** 사용" |
| §1.3 GitHub 전용 필드 | `repoFullName?: string` (JSDoc 에 "REVISION 8 최종 확정, 이후 변경 없음" 명시) |
| §1.5 `CommentPostPayload` | `repoFullName?: string` |
| §4 `GitProvider.fetchChanges` 주석 | "item.projectId/**repoFullName** 활용" |
| §4 GitLab/GitHub id 매핑 예시 | `repoFullName: undefined` / `repoFullName: \`${owner}/${repo}\`` |
| §4 GitHub API URL 예시 | `{item.repoFullName}/pulls/...`, `{item.repoFullName}/issues/.../comments` |
| §15.3 4-part delimiter 설명 | "API 호출 시 **repoFullName** 사용" |
| footer/NEXT | REVISION 8 로 갱신, M4 다시 **활성화 (이미 backend 구현 완료 상태로 간주)** |

### REVISION 6 의 M4 상태 (명시)
REVISION 7 에서 "철회" 로 표기했던 M4 는 REVISION 8 에서 **다시 유효** 하지만, 이미 backend 가 구현을 완료했으므로 **추가 작업은 없음**. 역사적 이력 보존을 위해 §15.4 의 취소선 표기는 그대로 두되, §15.6 의 본 섹션이 최종 진실 기준.

### 영향 범위
- **backend**: 추가 작업 **없음** (구현이 이미 repoFullName 기반). 남은 정정 = C1/C2/M1/M3/M6/m1.
- **frontend**: 추가 작업 **없음** (구현이 이미 repoFullName 기반). m1 의 `providerType` 제거만 별건으로 필요.
- **reviewer**: 2차 리뷰 시 설계 문서 ↔ 구현 모두 `repoFullName` 로 일관 확인.

---

STATUS: DONE
PHASE: 1 (v2)
REVISION: 8 — team-lead 최종 확정: `repoFullName` 으로 통일 (구현 기준). 필드명 변경 종결.
NEXT:
- **backend**: REVISION 5 의 C1/C2/M1/M3 + REVISION 6 의 M6/m1 구현 정정. (필드명 변경 작업은 모두 종료 — 이미 구현 완료.)
- **frontend**: m1 의 `CommentPostPayload.providerType` 제거에 맞춘 `review.ts` 수정만 필요. `repoFullName` 은 그대로 유지.
- **reviewer**: backend 정정 완료 후 2차 리뷰 착수. REVISION 8 기준으로 `repoFullName` 일관성 확인.
