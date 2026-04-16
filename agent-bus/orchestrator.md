# orchestrator

STATUS: IN_PROGRESS
PHASE: 1
CURRENT_ACTION: v2 설계 착수 — 팀 킥오프
LAST_UPDATED: 2026-04-16

---

## v2 목표 (사용자 확정)

1. **Multi-provider Git** — GitLab + GitHub 동시 연결 가능 (각각 독립 폴링)
2. **AI Provider 추상화** — Claude CLI → Codex CLI → Anthropic API → OpenAI API → Ollama (우선순위 순)
3. **설정 UI 재설계** — [Git 연결] 탭 + [AI] 탭, 다중 Git 연결 카드 추가/삭제/편집
4. **Store 마이그레이션** — v1 AppSettings(gitlabUrl/token/userId) → v2 (gitConnections[], ai)

---

## v2 핵심 타입 (architect가 구체화할 것)

### Git Config

```typescript
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
```

### AI Config

```typescript
export type AIProviderType = 'claude-cli' | 'codex-cli' | 'anthropic-api' | 'openai-api' | 'ollama';

export interface ClaudeCLIConfig   { type: 'claude-cli';      execPath?: string; }
export interface CodexCLIConfig    { type: 'codex-cli';       execPath?: string; }
export interface AnthropicAPIConfig { type: 'anthropic-api';  apiKey: string; model: string; }
export interface OpenAIAPIConfig   { type: 'openai-api';      apiKey: string; model: string; baseUrl?: string; }
export interface OllamaConfig      { type: 'ollama';          baseUrl: string;  model: string; }

export type AIConfig =
  | ClaudeCLIConfig | CodexCLIConfig
  | AnthropicAPIConfig | OpenAIAPIConfig | OllamaConfig;
```

### 통합 ReviewItem (MR + PR 공통)

```typescript
export interface ReviewItemSummary {
  id: string;              // `${gitConfigId}-${itemId}`
  gitConfigId: string;     // 어느 연결에서 왔는지
  providerType: GitProviderType;
  providerLabel: string;   // 트레이 메뉴 표시용 "[GL]" "[GH]"
  itemId: number;          // GitLab iid / GitHub PR number
  title: string;
  description: string;
  author: { id: number; name: string; username: string; avatar_url: string };
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  projectId: number;       // GitLab projectId / GitHub repo number
  createdAt: string;
  updatedAt: string;
}

export interface ReviewItemWithChanges extends ReviewItemSummary {
  changes: ItemChange[];
}

export interface ItemChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}
```

### 업데이트된 AppSettings / StoreSchema

```typescript
export interface AppSettings {
  gitConnections: GitConfig[];   // [] 이면 미설정 상태
  ai: AIConfig;                  // 기본값: { type: 'claude-cli' }
  pollIntervalMs: number;
  notificationEnabled: boolean;
}

export interface StoreSchema {
  settings: AppSettings;
  seenItemIds: string[];         // v1 seenMrIds → string (복합 ID)
  recentItems: ReviewItemSummary[]; // 최대 5개
}
```

### 마이그레이션

앱 시작 시 store에 `settings.gitlabUrl` 존재하면 자동 변환:
```typescript
// 구 v1 → 신 v2 자동 마이그레이션
if ('gitlabUrl' in rawSettings) {
  store.set('settings', {
    gitConnections: [{
      type: 'gitlab',
      id: crypto.randomUUID(),
      url: rawSettings.gitlabUrl,
      token: rawSettings.token,
      userId: rawSettings.userId,
    }],
    ai: { type: 'claude-cli' },
    pollIntervalMs: rawSettings.pollIntervalMs,
    notificationEnabled: rawSettings.notificationEnabled,
  });
}
```

---

## v2 파일 구조 (변경 사항)

```
src/main/
├── providers/
│   ├── git/
│   │   ├── git-provider.ts        # GitProvider interface + createGitProvider() factory
│   │   ├── gitlab-provider.ts     # GitLabProvider implements GitProvider
│   │   └── github-provider.ts    # GitHubProvider implements GitProvider
│   └── ai/
│       ├── ai-provider.ts         # AIProvider interface + createAIProvider() factory
│       ├── claude-cli.ts
│       ├── codex-cli.ts
│       ├── anthropic-api.ts
│       ├── openai-api.ts
│       └── ollama.ts
├── poller.ts                      # GitProvider[] 주입, 병렬 폴링
├── review-runner.ts               # AIProvider 주입
└── ipc.ts
```

---

## GitProvider 인터페이스

```typescript
export interface GitProvider {
  readonly config: GitConfig;
  fetchOpenItems(): Promise<ReviewItemSummary[]>;
  fetchChanges(item: ReviewItemSummary): Promise<ReviewItemWithChanges>;
  postComment(item: ReviewItemSummary, body: string): Promise<{ success: boolean; id?: string; error?: string }>;
  testConnection(): Promise<{ success: boolean; userId?: number; username?: string; error?: string }>;
}

export function createGitProvider(config: GitConfig): GitProvider;
```

### GitLab API 엔드포인트 (v2)
- MR 목록: `GET {url}/api/v4/merge_requests?scope=all&state=opened&reviewer_id={userId}`
- 변경: `GET {url}/api/v4/projects/{id}/merge_requests/{iid}/changes`
- 댓글: `POST {url}/api/v4/projects/{id}/merge_requests/{iid}/discussions`
- 연결 테스트: `GET {url}/api/v4/user`

### GitHub API 엔드포인트 (v2)
- PR 목록: `GET https://api.github.com/search/issues?q=is:pr+is:open+review-requested:{username}`
  + `GET https://api.github.com/search/issues?q=is:pr+is:open+assignee:{username}`
- 변경: `GET https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files`
- 댓글: `POST https://api.github.com/repos/{owner}/{repo}/issues/{number}/comments`
- 연결 테스트: `GET https://api.github.com/user`
- Header: `Authorization: Bearer {token}`, `Accept: application/vnd.github+json`

---

## AIProvider 인터페이스

```typescript
export interface AIProvider {
  readonly config: AIConfig;
  streamReview(
    prompt: string,
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): () => void;  // abort 함수 반환
  testAvailability(): Promise<{ success: boolean; version?: string; error?: string }>;
}

export function createAIProvider(config: AIConfig): AIProvider;
```

### 각 AI Provider 구현 전략
- **claude-cli**: `spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'])` stdin 주입
- **codex-cli**: `spawn('codex', ['-p', prompt])` — stdout 텍스트 스트림
- **anthropic-api**: `@anthropic-ai/sdk` Messages API streaming
- **openai-api**: `openai` npm streaming, baseUrl 지원
- **ollama**: `fetch(baseUrl + '/api/generate', { stream: true })` NDJSON 파싱

### testAvailability 구현
- CLI 타입: `which claude` / `which codex` → 존재 확인
- API 타입: 최소 API 호출 (모델 목록 조회 또는 단순 ping)
- Ollama: `GET {baseUrl}/api/tags` → 모델 목록 반환도 겸함

---

## 신규 IPC 채널 (v2 추가)

```typescript
// Renderer → Main
export const GIT_CONNECTIONS_LOAD  = 'git:connections:load'  as const;
export const GIT_CONNECTIONS_SAVE  = 'git:connections:save'  as const;
export const GIT_CONNECTION_TEST   = 'git:connection:test'   as const;  // payload: GitConfig
export const AI_CONFIG_LOAD        = 'ai:config:load'        as const;
export const AI_CONFIG_SAVE        = 'ai:config:save'        as const;
export const AI_AVAILABILITY_TEST  = 'ai:availability:test'  as const;  // payload: AIConfig
export const OLLAMA_MODELS_FETCH   = 'ollama:models:fetch'   as const;  // payload: { baseUrl }

// Main → Renderer (기존 REVIEW_CHUNK/DONE/ERROR/MR_NEW 유지)
// MR_NEW → ITEM_NEW 로 rename (하위호환 위해 별칭 유지)
export const ITEM_NEW = 'item:new' as const;
```

---

## 설정 UI v2 상세

### [Git 연결] 탭
```
── 연결된 서비스 ─────────────────────────────────────

┌─ GitLab · gitlab.example.com ──────────── [편집] [삭제] ─┐
│  연결됨 · User: john_doe (ID: 42)                        │
└──────────────────────────────────────────────────────────┘
┌─ GitHub · myusername ──────────────────── [편집] [삭제] ─┐
│  연결됨 · @myusername                                    │
└──────────────────────────────────────────────────────────┘

[+ 서비스 추가]  → 드롭다운: GitLab / GitHub

── 인라인 편집 폼 (추가/편집 시 카드 아래 슬라이드 다운) ──

서비스   [GitLab ▼]
URL      [https://gitlab.example.com  ]   (GitLab만)
Token    [glpat-xxx                👁 ]
         [연결 테스트] → userId/username 자동 입력
라벨     [내 GitLab  (선택)         ]
[저장] [취소]
```

### [AI] 탭
```
AI 제공자  [Claude CLI ▼]

── Claude CLI / Codex CLI ──────────────────
실행 파일  [자동 감지: /usr/local/bin/claude]  (편집 가능)
           [가용성 확인]  → "v1.2.3 감지됨" 또는 "설치되지 않음"

── Anthropic API ────────────────────────────
API Key   [sk-ant-xxxx                    👁 ]
모델      [claude-sonnet-4-6              ▼ ]
          (고정 목록: opus-4-6 / sonnet-4-6 / haiku-4-5)
          [연결 테스트]

── OpenAI API ───────────────────────────────
API Key   [sk-xxxx                        👁 ]
모델      [gpt-4o                         ▼ ]
Base URL  [https://api.openai.com/v1        ]  (변경 가능)
          [연결 테스트]

── Ollama ───────────────────────────────────
Base URL  [http://localhost:11434           ]
모델      [불러오는 중… / qwen2.5-coder ▼ ]  (동적 로드)
          [연결 테스트]
```

### 공통 하단
```
폴링 간격   [──●──────]  30s
알림        [✓] 활성화

[취소]  [저장]
```

---

## 트레이 메뉴 v2

```
🟢 폴링 중 — GitLab ✓ · GitHub ✓  (마지막: 00:30전)
──────────────────────────────────────
🔔 알림 켜짐
──────────────────────────────────────
최근 MR/PR
  [GL] #42  feat/login-refactor
  [GH] #12  fix/null-pointer
  [GL] #40  chore/deps-update
──────────────────────────────────────
⚙️  설정
──────────────────────────────────────
종료
```

오류 있는 연결만 표시: `🟡 폴링 중 — GitLab ✓ · GitHub ✗`

---

## Phase 계획

| Phase | 담당 | 내용 |
|---|---|---|
| 1 | architect | v2 타입/인터페이스/채널 완전한 설계 산출 |
| 2 | backend | providers/ 구현 + store 마이그레이션 + 기존 파일 리팩터 |
| 3 | frontend | 설정 UI v2 (탭/카드) + 리뷰 윈도우 ReviewItem 통합 |
| 4 | reviewer | 전체 리뷰 + PASS/FAIL |

---

## 현재 지시

**architect**: 위 설계를 기반으로 shared/types.ts, shared/constants.ts, preload.ts, 각 provider interface를 완전한 코드로 산출. v1과의 하위호환(마이그레이션 코드) 포함.

**backend**: architect DONE 대기 후 providers/ 구현 시작.

**frontend**: architect DONE 대기 후 설정 UI v2 (탭 구조) 착수. review 윈도우는 ReviewItemSummary/WithChanges 기준으로 교체.

**reviewer**: architect.md 나오면 즉시 설계 사전 리뷰. Critical 발견 시 architect에게 직접 SendMessage.
