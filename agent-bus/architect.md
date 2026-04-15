STATUS: DONE
PHASE: 1
LAST_UPDATED: 2026-04-15
REVISION: 2 — stream-json 채택, AppSettings에 includeMentioned 옵션 추가

---

## Types (shared/types.ts)

```typescript
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
  created_at: string;   // ISO 8601
  updated_at: string;   // ISO 8601
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
  /** true이면 assignee_id 도 함께 폴링 (기본값 false — reviewer_id 전용) */
  includeMentioned?: boolean;
}

export interface StoreSchema {
  settings: AppSettings;
  seenMrIds: number[];
  recentMrs: MergeRequestSummary[]; // 최대 5개 — 트레이 메뉴용, changes 불필요
}

// IPC 페이로드 타입
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

/** 연결 테스트 결과 */
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
```

---

## Constants (shared/constants.ts)

```typescript
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
/** GitLab 연결 테스트 (설정 창에서 "테스트" 버튼) */
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
```

---

## preload.ts 설계

### 보안 원칙
- `contextIsolation: true`, `nodeIntegration: false` 필수
- 허용된 채널명만 화이트리스트로 ipcRenderer 접근
- renderer가 임의 채널에 접근하지 못하도록 채널 검증

### window.electronAPI 노출 메서드 목록

```typescript
// preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import type {
  ReviewStartPayload,
  CommentPostPayload,
  CommentPostResult,
  SettingsSavePayload,
  SettingsLoadResult,
  ReviewChunkPayload,
  ReviewErrorPayload,
  MergeRequest,
  TrayStateChangedPayload,
} from './shared/types';
import {
  REVIEW_START,
  REVIEW_ABORT,
  REVIEW_CHUNK,
  REVIEW_DONE,
  REVIEW_ERROR,
  COMMENT_POST,
  SETTINGS_SAVE,
  SETTINGS_LOAD,
  WINDOW_OPEN_MR,
  NOTIFICATION_TOGGLE,
  MR_NEW,
  TRAY_STATE_CHANGED,
} from './shared/constants';

// 채널 화이트리스트 상수 삭제 (Reviewer 권장 A안 채택)
// — 각 메서드가 이미 고정 채널 상수를 직접 참조하므로 런타임 중복 검증 불필요
// — 코드 단순화, 타입 시스템이 컴파일 타임에 채널 안전성 보장

export interface ElectronAPI {
  // ── Renderer → Main (fire-and-forget) ─────────────────────
  startReview: (payload: ReviewStartPayload) => void;
  abortReview: () => void;
  openMrInBrowser: (webUrl: string) => void;
  toggleNotification: () => void;

  // ── Renderer → Main (invoke, 응답 대기) ───────────────────
  postComment: (payload: CommentPostPayload) => Promise<CommentPostResult>;
  saveSettings: (payload: SettingsSavePayload) => Promise<void>;
  loadSettings: () => Promise<SettingsLoadResult>;
  /** GitLab GET /api/v4/user 호출하여 토큰/URL 유효성 확인 */
  testConnection: () => Promise<ConnectionTestResult>;

  // ── Main → Renderer (이벤트 구독) ─────────────────────────
  onReviewChunk: (cb: (payload: ReviewChunkPayload) => void) => () => void;
  onReviewDone: (cb: () => void) => () => void;
  onReviewError: (cb: (payload: ReviewErrorPayload) => void) => () => void;
  onMrNew: (cb: (mr: MergeRequestSummary) => void) => () => void;
  onTrayStateChanged: (cb: (payload: TrayStateChangedPayload) => void) => () => void;
}

contextBridge.exposeInMainWorld('electronAPI', {
  startReview: (payload: ReviewStartPayload) =>
    ipcRenderer.send(REVIEW_START, payload),

  abortReview: () =>
    ipcRenderer.send(REVIEW_ABORT),

  openMrInBrowser: (webUrl: string) =>
    ipcRenderer.send(WINDOW_OPEN_MR, webUrl),

  toggleNotification: () =>
    ipcRenderer.send(NOTIFICATION_TOGGLE),

  postComment: (payload: CommentPostPayload): Promise<CommentPostResult> =>
    ipcRenderer.invoke(COMMENT_POST, payload),

  saveSettings: (payload: SettingsSavePayload): Promise<void> =>
    ipcRenderer.invoke(SETTINGS_SAVE, payload),

  loadSettings: (): Promise<SettingsLoadResult> =>
    ipcRenderer.invoke(SETTINGS_LOAD),

  testConnection: (): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke(SETTINGS_TEST),

  // 구독 후 언서브스크라이브 함수 반환 (메모리 누수 방지)
  onReviewChunk: (cb: (payload: ReviewChunkPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ReviewChunkPayload) => cb(payload);
    ipcRenderer.on(REVIEW_CHUNK, handler);
    return () => ipcRenderer.removeListener(REVIEW_CHUNK, handler);
  },

  onReviewDone: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(REVIEW_DONE, handler);
    return () => ipcRenderer.removeListener(REVIEW_DONE, handler);
  },

  onReviewError: (cb: (payload: ReviewErrorPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ReviewErrorPayload) => cb(payload);
    ipcRenderer.on(REVIEW_ERROR, handler);
    return () => ipcRenderer.removeListener(REVIEW_ERROR, handler);
  },

  onMrNew: (cb: (mr: MergeRequestSummary) => void) => {
    const handler = (_: Electron.IpcRendererEvent, mr: MergeRequestSummary) => cb(mr);
    ipcRenderer.on(MR_NEW, handler);
    return () => ipcRenderer.removeListener(MR_NEW, handler);
  },

  onTrayStateChanged: (cb: (payload: TrayStateChangedPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: TrayStateChangedPayload) => cb(payload);
    ipcRenderer.on(TRAY_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(TRAY_STATE_CHANGED, handler);
  },
} satisfies ElectronAPI);
```

---

## 모듈 인터페이스

### main/main.ts
```typescript
// 앱 생명주기 엔트리포인트 — 직접 export 없음
// 내부적으로 아래를 초기화:
// - app.requestSingleInstanceLock() → false이면 즉시 app.quit() (트레이 앱 중복 실행 방지)
//   두 번째 인스턴스 실행 시 'second-instance' 이벤트 → 트레이 아이콘 flash로 사용자 안내
// - createTray()
// - startPoller(store, tray, notifier)
// - registerIpcHandlers(store, tray)
// - app.on('window-all-closed', ...) → macOS 제외 quit
// - app.on('activate', ...) → macOS dock 클릭 대응
```

### main/tray.ts
```typescript
import type { TrayState, MergeRequest } from '../shared/types';
import type { Tray as ElectronTray } from 'electron';

export interface TrayController {
  /** 현재 트레이 상태 반환 */
  getState(): TrayState;
  /** 트레이 상태 전환 + 아이콘 교체 + 메뉴 재빌드 */
  setState(state: TrayState): void;
  /** 최근 MR 목록으로 컨텍스트 메뉴 갱신 — Summary만 필요 */
  updateRecentMrs(mrs: MergeRequestSummary[]): void;
  /** 마지막 폴링 시각 갱신 (메뉴 상태바 표시) */
  updateLastChecked(at: Date): void;
  /** 트레이 리소스 해제 */
  destroy(): void;
}

export function createTray(
  iconDir: string,
  onToggleNotification: () => void,
  onOpenSettings: () => void,
  onOpenMr: (webUrl: string) => void,
  onQuit: () => void,
): TrayController;
```

### main/poller.ts
```typescript
import type { MergeRequest, AppSettings } from '../shared/types';

/** poller가 새 MR 감지 시 Summary 목록만 전달 — changes는 lazy fetch */
export type MrFoundCallback = (newMrs: MergeRequestSummary[]) => void;
export type PollErrorCallback = (error: Error) => void;

export interface PollerController {
  /** 폴링 즉시 시작 (interval 기반 반복) */
  start(): void;
  /** 폴링 중단 */
  stop(): void;
  /** 설정 변경 시 재시작 (interval 갱신) */
  restart(settings: AppSettings): void;
}

export function createPoller(
  settings: AppSettings,
  seenIds: Set<number>,
  onFound: MrFoundCallback,
  onError: PollErrorCallback,
): PollerController;

/** GitLab /merge_requests 단일 호출 — Summary 목록 반환 */
export async function fetchOpenMrs(
  gitlabUrl: string,
  token: string,
  userId: number,
): Promise<MergeRequestSummary[]>;

/** GitLab /projects/{id}/merge_requests/{iid}/changes 단일 호출 — WithChanges 반환 */
export async function fetchMrChanges(
  gitlabUrl: string,
  token: string,
  projectId: number,
  iid: number,
): Promise<MergeRequestWithChanges>;
```

### main/notifier.ts
```typescript
import type { MergeRequest, NotificationAction } from '../shared/types';

export type NotificationActionCallback = (
  action: NotificationAction,
  mr: MergeRequest,
) => void;

/** Windows 토스트 알림 발송. 버튼 클릭 시 onAction 호출 */
export function sendMrNotification(
  mr: MergeRequest,
  onAction: NotificationActionCallback,
): void;
```

### main/ipc.ts
```typescript
import type { AppSettings } from '../shared/types';
import type { TrayController } from './tray';
import type Store from 'electron-store';
import type { StoreSchema } from '../shared/types';

/** 모든 ipcMain.handle / ipcMain.on 등록 */
export function registerIpcHandlers(
  store: Store<StoreSchema>,
  tray: TrayController,
): void;

/** 특정 webContents로 스트리밍 청크 전송 (poller → ipc → renderer) */
export function sendReviewChunk(
  webContentsId: number,
  chunk: string,
): void;
```

---

## GitLab API

### 엔드포인트 + 응답 타입 매핑

#### 1. MR 목록 조회
```
GET {gitlabUrl}/api/v4/merge_requests
  ?scope=all
  &state=opened
  &reviewer_id={userId}
  &order_by=updated_at
  &sort=desc
  &per_page=20

Headers:
  PRIVATE-TOKEN: {token}

응답: GitLabMRListItem[]
```

```typescript
// GitLab API 원시 응답 타입 (internal, shared/types.ts에 포함하지 않음)
interface GitLabMRListItem {
  id: number;
  iid: number;
  title: string;
  description: string;
  author: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
  };
  web_url: string;
  source_branch: string;
  target_branch: string;
  reviewers: Array<{ id: number }>;  // reviewer_ids로 변환 필요
  project_id: number;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
  created_at: string;
  updated_at: string;
}
```

매핑 전략: `reviewers.map(r => r.id)` → `reviewer_ids`

#### 2. MR 변경 파일 조회
```
GET {gitlabUrl}/api/v4/projects/{projectId}/merge_requests/{iid}/changes

Headers:
  PRIVATE-TOKEN: {token}

응답: GitLabMRChanges
```

```typescript
interface GitLabMRChanges extends GitLabMRListItem {
  changes: Array<{
    old_path: string;
    new_path: string;
    diff: string;
    new_file: boolean;
    deleted_file: boolean;
    renamed_file: boolean;
  }>;
}
```

#### 3. 댓글(Discussion) 등록
```
POST {gitlabUrl}/api/v4/projects/{projectId}/merge_requests/{iid}/discussions

Headers:
  PRIVATE-TOKEN: {token}
  Content-Type: application/json

Body:
  { "body": "<마크다운 AI 리뷰 본문>" }

응답 성공: 201 Created
  { "id": "<discussion_id>", ... }

응답 실패: 4xx/5xx
```

#### HTTP 에러 처리 전략
- 401: 토큰 만료 → TrayState = 'ERROR', 토스트 "GitLab 인증 실패"
- 403: 권한 없음 → 로그 기록, 스킵
- 429: Rate limit → 다음 폴링 주기까지 대기
- 5xx: TrayState = 'ERROR', 재시도는 다음 폴 주기에 자동 수행

---

## Claude CLI 전략

### 프롬프트 구성

```
[시스템 프롬프트]
당신은 시니어 코드 리뷰어입니다. 아래 GitLab MR의 변경 사항을 분석하고
한국어로 간결하게 리뷰하세요. 형식: 마크다운.
리뷰 항목: 버그 위험, 성능, 보안, 가독성, 개선 제안.

[사용자 프롬프트 구조]
## MR 정보
- 제목: {mr.title}
- 브랜치: {mr.source_branch} → {mr.target_branch}
- 설명: {mr.description | '없음'}

## 변경 파일 ({selectedChanges.length}개 / 전체 {mr.changes.length}개)

### {change.new_path}  [{new|deleted|renamed|modified}]
```diff
{change.diff.slice(0, 4000)}
```

[반복...]
```

### 파일 선택 전략 (토큰 초과 방지)
1. `mr.changes.length > 10` 이면 상위 10개만 선택
2. 선택 기준: diff 변경 라인 수 내림차순 (`diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length`)
3. 각 파일 diff는 4000자로 절단 (`diff.slice(0, 4000)`)
4. 언어 감지: `path.extname(change.new_path)` → 코드 블록 언어 힌트 삽입

### 스트리밍 파싱 전략 — --output-format stream-json 채택

claude CLI는 `--output-format stream-json` 플래그를 지원합니다.
각 stdout 라인이 JSON 객체이므로 텍스트 파싱보다 안정적입니다.

```typescript
// main/ipc.ts 내부 (개념 코드)
import { spawn } from 'child_process';

/**
 * stream-json 이벤트 형태 (claude CLI 공식 출력):
 *   {"type":"text","text":"..."}        — 텍스트 청크
 *   {"type":"tool_use",...}             — 무시 (리뷰에서 툴 미사용)
 *   {"type":"message_stop"}             — 스트리밍 완료 신호
 *   {"type":"error","error":{"message":"..."}} — 오류
 */
interface StreamJsonEvent {
  type: 'text' | 'tool_use' | 'message_stop' | 'error';
  text?: string;
  error?: { message: string };
}

function runClaudeReview(
  prompt: string,
  onChunk: (s: string) => void,
  onDone: () => void,
  onError: (e: Error) => void,
): () => void {
  // 프롬프트를 stdin으로 주입 — OS 인수 길이 한계(32,767자) 우회
  const proc = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  proc.stdin.write(prompt, 'utf-8');
  proc.stdin.end();

  let lineBuffer = '';
  proc.stdout.on('data', (data: Buffer) => {
    lineBuffer += data.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as StreamJsonEvent;
        if (event.type === 'text' && event.text) {
          onChunk(event.text);
        } else if (event.type === 'message_stop') {
          // onDone은 proc.close 에서 처리
        } else if (event.type === 'error' && event.error) {
          onError(new Error(event.error.message));
        }
      } catch {
        // JSON 파싱 실패 라인은 electron-log 기록 후 스킵
      }
    }
  });

  proc.stderr.on('data', (data: Buffer) => {
    // electron-log 기록만, renderer 전달 금지
  });

  proc.on('close', (code: number | null) => {
    if (code === 0) onDone();
    else onError(new Error(`claude exited with code ${String(code)}`));
  });

  proc.on('error', onError);

  return () => { proc.kill('SIGTERM'); };
}
```

### 토큰 초과 대응 정책
| 조건 | 처리 |
|---|---|
| `changes.length > 10` | 변경 라인 수 상위 10개만 포함 |
| 단일 diff > 4000자 | `diff.slice(0, 4000) + '\n... (truncated)'` |
| claude 프로세스 exit code != 0 | `REVIEW_ERROR` IPC 이벤트 발송 |
| stream-json `error` 이벤트 수신 | `event.error.message` → `REVIEW_ERROR` payload로 전달 |

### electron-log 헤더 마스킹 명세 (보안)
axios 인터셉터 또는 electron-log 포맷터에서 아래 헤더값을 마스킹해야 합니다.

```typescript
// main/poller.ts 또는 공통 axios 인스턴스 생성 시
import log from 'electron-log';

// electron-log 포맷터 — 로그 출력 전 토큰 마스킹
const TOKEN_PATTERN = /glpat-[A-Za-z0-9_-]{20,}/g;
log.hooks.push((message) => {
  message.data = message.data.map((item) => {
    if (typeof item === 'string') {
      return item.replace(TOKEN_PATTERN, 'glpat-[REDACTED]');
    }
    return item;
  });
  return message;
});

// axios 에러 로깅 시 Authorization / PRIVATE-TOKEN 헤더 마스킹
axiosInstance.interceptors.response.use(
  (res) => res,
  (err: unknown) => {
    if (isAxiosError(err) && err.config?.headers) {
      const safeHeaders = { ...err.config.headers };
      if ('PRIVATE-TOKEN' in safeHeaders) safeHeaders['PRIVATE-TOKEN'] = '[REDACTED]';
      if ('Authorization' in safeHeaders) safeHeaders['Authorization'] = '[REDACTED]';
      log.error('GitLab API error', { status: err.response?.status, headers: safeHeaders });
    }
    return Promise.reject(err);
  },
);
```

---

## electron-store 스키마

```typescript
// main/main.ts 또는 별도 store.ts에서 초기화

import Store from 'electron-store';
import type { StoreSchema, AppSettings } from '../shared/types';

const DEFAULT_SETTINGS: AppSettings = {
  gitlabUrl: '',       // 반드시 설정 필요
  token: '',           // 반드시 설정 필요
  userId: 0,           // 반드시 설정 필요
  pollIntervalMs: 30_000,
  notificationEnabled: true,
};

const store = new Store<StoreSchema>({
  name: 'pingo-config',
  defaults: {
    settings: DEFAULT_SETTINGS,
    seenMrIds: [],
    recentMrs: [],
  },
  schema: {
    settings: {
      type: 'object',
      properties: {
        gitlabUrl:           { type: 'string' },
        token:               { type: 'string' },
        userId:              { type: 'number' },
        pollIntervalMs:      { type: 'number', minimum: 10_000 },
        notificationEnabled: { type: 'boolean' },
      },
      required: ['gitlabUrl', 'token', 'userId', 'pollIntervalMs', 'notificationEnabled'],
    },
    seenMrIds: {
      type: 'array',
      items: { type: 'number' },
    },
    recentMrs: {
      type: 'array',
      maxItems: 5,
    },
  },
  encryptionKey: undefined, // token은 평문 저장 (OS keychain 연동은 v2에서)
});

export { store };
```

### seenMrIds 관리 정책
- 새 MR 알림 발송 후 즉시 추가
- 최대 200개 보관 (200 초과 시 오래된 것부터 제거)
- `seenMrIds.slice(-200)` 로 정리

### recentMrs 관리 정책
- 최신 5개만 유지: `[newMr, ...current].slice(0, 5)`
- 트레이 컨텍스트 메뉴에 직접 사용

---

## 아이콘 SVG 명세

### icon-active.svg (16x16 — 초록, 정상 폴링 중)
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <!-- 배경 원 -->
  <circle cx="8" cy="8" r="7.5" fill="#a6e3a1" stroke="#40a02b" stroke-width="0.5"/>
  <!-- GitLab 로고 형태: 상단 꼭짓점 + 좌우 날개 삼각형 -->
  <path d="M8 3.5 L11.5 10 L8 8.5 L4.5 10 Z" fill="#1e1e2e"/>
  <path d="M4.5 10 L3 7 L4.5 10 Z" fill="#40a02b"/>
  <path d="M11.5 10 L13 7 L11.5 10 Z" fill="#40a02b"/>
  <path d="M4.5 10 L8 12.5 L11.5 10 L8 8.5 Z" fill="#1e1e2e" opacity="0.7"/>
</svg>
```

### icon-muted.svg (16x16 — 빨강, 알림 꺼짐)
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <!-- 배경 원 -->
  <circle cx="8" cy="8" r="7.5" fill="#f38ba8" stroke="#e64553" stroke-width="0.5"/>
  <!-- 벨 모양 -->
  <path d="M8 3 C6 3 5 5 5 7 L5 10 L11 10 L11 7 C11 5 10 3 8 3 Z" fill="#1e1e2e"/>
  <rect x="7" y="10" width="2" height="1.5" rx="0.5" fill="#1e1e2e"/>
  <!-- 사선 (알림 끔 표시) -->
  <line x1="4" y1="12" x2="12" y2="4" stroke="#1e1e2e" stroke-width="1.5" stroke-linecap="round"/>
  <!-- 사선 흰 외곽 (가독성) -->
  <line x1="4" y1="12" x2="12" y2="4" stroke="#f38ba8" stroke-width="2.5" stroke-linecap="round" opacity="0.4"/>
</svg>
```

### icon-new-mr.svg (16x16 — 노랑, 새 MR 있음)
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <!-- 배경 원 -->
  <circle cx="8" cy="8" r="7.5" fill="#f9e2af" stroke="#df8e1d" stroke-width="0.5"/>
  <!-- 느낌표 몸통 -->
  <rect x="7.25" y="3.5" width="1.5" height="6" rx="0.75" fill="#1e1e2e"/>
  <!-- 느낌표 점 -->
  <circle cx="8" cy="11.5" r="0.9" fill="#1e1e2e"/>
</svg>
```

### icon-error.svg (16x16 — 회색, GitLab 연결 실패)
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <!-- 배경 원 -->
  <circle cx="8" cy="8" r="7.5" fill="#6c7a96" stroke="#45475a" stroke-width="0.5"/>
  <!-- X 표시 — 좌상→우하 -->
  <line x1="5" y1="5" x2="11" y2="11" stroke="#cdd6f4" stroke-width="1.8" stroke-linecap="round"/>
  <!-- X 표시 — 우상→좌하 -->
  <line x1="11" y1="5" x2="5" y2="11" stroke="#cdd6f4" stroke-width="1.8" stroke-linecap="round"/>
</svg>
```

> 참고: `scripts/generate-icons.js` 에서 위 SVG를 읽어 `sharp` 또는 `canvas` npm 패키지로 PNG 변환.
> 출력: `assets/icon-active.png`, `icon-muted.png`, `icon-new-mr.png`, `icon-error.png` (각 16x16, 필요시 32x32 @2x)
