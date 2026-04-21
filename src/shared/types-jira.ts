// shared/types-jira.ts — Jira 연동 전용 타입 (v3, strict, no any)

/** Cloud(email + API Token, Basic Auth) / Server DC(PAT, Bearer) */
export type JiraAuthType = 'cloud' | 'server';

export interface JiraConfig {
  type: 'jira';
  /** crypto.randomUUID() */
  id: string;
  /** 표시용 별칭. 없으면 url에서 파생 */
  label?: string;
  /** 인증 방식 */
  authType: JiraAuthType;
  /** Jira 베이스 URL — Cloud: https://{site}.atlassian.net  /  Server/DC: https://jira.example.com */
  url: string;
  /** Cloud 전용 — 이메일 (Basic Auth username). Server/DC에서는 undefined */
  email?: string;
  /** Cloud: API Token  /  Server/DC: PAT */
  apiToken: string;
  /** 감시 대상 프로젝트 key 목록 (예: ['PROJ', 'OPS']). [] 이면 모든 프로젝트 */
  watchedProjectKeys: string[];
}

/** Jira 이슈 요약 — 트레이/알림/리스트 공용 (경량) */
export interface JiraIssueSummary {
  /**
   * 복합 ID: `${jiraConfigId}::${issueKey}` — 전역 unique.
   * delimiter는 `::` 고정 (git `ReviewItemSummary.id` 와 동일 정책).
   */
  id: string;
  /** 연결 id (어느 Jira 에서 왔는지) */
  jiraConfigId: string;
  /** Jira 이슈 키 (예: 'PROJ-123') */
  issueKey: string;
  /** 제목 (summary) */
  summary: string;
  /** 상태 이름 (예: 'To Do', 'In Progress', 'Done') */
  status: string;
  /** 우선순위 이름 (예: 'High', 'Medium'). 이슈가 우선순위 미설정이면 빈 문자열 */
  priority: string;
  /** 이슈 타입 이름 (예: 'Bug', 'Task', 'Story', 'Sub-task'). 미설정이면 빈 문자열 */
  issueType: string;
  /** 이슈 타입의 아이콘 URL (Jira가 제공). 없으면 undefined */
  issueTypeIconUrl?: string;
  /** 담당자 — 미지정 시 undefined */
  assignee?: JiraUserBrief;
  /** 보고자 */
  reporter: JiraUserBrief;
  /** 브라우저로 열 URL */
  webUrl: string;
  /** 프로젝트 키 (issueKey 의 접두부, 예: 'PROJ') */
  projectKey: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface JiraUserBrief {
  /** Cloud: accountId / Server: key 또는 name */
  accountId: string;
  displayName: string;
  /** Cloud: emailAddress (있을 때만) / Server: name 또는 undefined */
  email?: string;
  /** 48x48 아바타 URL. 없으면 빈 문자열 */
  avatarUrl: string;
}

/** Jira 이벤트 종류 */
export type JiraEventKind = 'jira_issue_assigned' | 'jira_issue_created';

export interface JiraEvent {
  kind: JiraEventKind;
  issue: JiraIssueSummary;
}

/** 연결 테스트 결과 — 성공 시 accountId/displayName 채움 */
export interface JiraConnectionTestResult {
  success: boolean;
  accountId?: string;
  displayName?: string;
  error?: string;
}

// ── IPC 페이로드 ─────────────────────────────────────────────
export interface JiraConnectionsLoadResult {
  jiraConnections: JiraConfig[];
}

export interface JiraConnectionsSavePayload {
  jiraConnections: JiraConfig[];
}

export interface JiraConnectionTestPayload {
  config: JiraConfig;
}

/** 리스트 윈도우 초기/업데이트 페이로드 — Jira 섹션 */
export interface JiraListLoadResult {
  issues: JiraIssueSummary[];
}

// ── Jira Webhook 수신기 ──────────────────────────────────────
// 웹훅 path/port/poll interval 상수는 shared/constants.ts 에 단일 정의 (중복 export 제거).
// 참조: JIRA_WEBHOOK_PATH_PREFIX / DEFAULT_JIRA_WEBHOOK_PORT / DEFAULT_POLL_INTERVAL_MS
