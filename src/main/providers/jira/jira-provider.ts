// providers/jira/jira-provider.ts — Jira REST API 클라이언트 (v3)
import axios, { AxiosError, AxiosInstance, AxiosRequestHeaders } from 'axios';
import log from 'electron-log';
import type {
  JiraConfig,
  JiraConnectionTestResult,
  JiraIssueSummary,
  JiraUserBrief,
} from '../../../shared/types';

interface JiraUserRaw {
  accountId?: string;
  key?: string;
  name?: string;
  displayName?: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

interface JiraIssueRaw {
  id: string;
  key: string;
  fields: {
    summary: string;
    status?: { name: string };
    priority?: { name: string } | null;
    assignee?: JiraUserRaw | null;
    reporter?: JiraUserRaw | null;
    issuetype?: { name?: string; iconUrl?: string; subtask?: boolean } | null;
    created: string;
    updated: string;
    project: { key: string };
  };
}

interface JiraSearchResponse {
  issues: JiraIssueRaw[];
  /** 구 엔드포인트(Server/DC /rest/api/2/search)에서만 제공 */
  total?: number;
  /** Cloud enhanced search(/rest/api/3/search/jql)에서만 제공 */
  nextPageToken?: string;
  isLast?: boolean;
}

interface JiraMyselfResponse {
  accountId?: string;
  key?: string;
  name?: string;
  displayName: string;
}

function maskHeaders(headers: AxiosRequestHeaders | undefined): Record<string, unknown> {
  if (!headers) return {};
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'authorization') safe[k] = '[REDACTED]';
    else safe[k] = v;
  }
  return safe;
}

function classifyJiraError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const s = ax.response?.status;
    if (s === 401) return new Error('Jira 인증 실패 (401): 토큰/이메일을 확인하세요');
    if (s === 403) return new Error('Jira 권한 없음 (403)');
    if (s === 404) return new Error('Jira 리소스 없음 (404)');
    if (s && s >= 500) return new Error(`Jira 서버 오류 (${s})`);
    return new Error(`Jira 요청 실패: ${ax.message}`);
  }
  return err instanceof Error ? err : new Error('알 수 없는 Jira 오류');
}

function buildAuthHeader(config: JiraConfig): string {
  if (config.authType === 'cloud') {
    const userPass = `${config.email ?? ''}:${config.apiToken}`;
    return `Basic ${Buffer.from(userPass, 'utf-8').toString('base64')}`;
  }
  return `Bearer ${config.apiToken}`;
}

function toUserBrief(raw: JiraUserRaw | null | undefined): JiraUserBrief | undefined {
  if (!raw) return undefined;
  const avatar = raw.avatarUrls?.['48x48'] ?? raw.avatarUrls?.['32x32'] ?? '';
  return {
    accountId: raw.accountId ?? raw.key ?? raw.name ?? '',
    displayName: raw.displayName ?? raw.name ?? '(unknown)',
    email: raw.emailAddress,
    avatarUrl: avatar,
  };
}

export class JiraProvider {
  readonly config: JiraConfig;
  private readonly client: AxiosInstance;
  private cachedAccountId: string | null = null;

  constructor(config: JiraConfig) {
    this.config = config;
    // Jira Cloud 는 2025-05-01 부로 구 `/rest/api/{2,3}/search` 제거 → v3 + /search/jql 전용
    // Server/DC 는 여전히 /rest/api/2/search 사용
    const apiVersion = config.authType === 'cloud' ? '3' : '2';
    this.client = axios.create({
      baseURL: `${config.url.replace(/\/$/, '')}/rest/api/${apiVersion}`,
      headers: {
        Authorization: buildAuthHeader(config),
        Accept: 'application/json',
      },
      timeout: 15_000,
    });
    this.client.interceptors.response.use(
      (res) => res,
      (err: unknown) => {
        if (axios.isAxiosError(err)) {
          const status = err.response?.status;
          const safe = maskHeaders(err.config?.headers as AxiosRequestHeaders | undefined);
          log.warn(`jira[${config.id.slice(0, 8)}]: status=${status ?? 'n/a'} url=${err.config?.url ?? ''}`, safe);
        }
        return Promise.reject(err);
      },
    );
  }

  async testConnection(): Promise<JiraConnectionTestResult> {
    try {
      const res = await this.client.get<JiraMyselfResponse>('/myself');
      const accountId = res.data.accountId ?? res.data.key ?? res.data.name ?? '';
      return { success: true, accountId, displayName: res.data.displayName };
    } catch (err) {
      return { success: false, error: classifyJiraError(err).message };
    }
  }

  /** 감시 대상 프로젝트 필터를 JQL project in (…) 로 구성. 비어있으면 제약 없음. */
  private projectClause(): string {
    const keys = this.config.watchedProjectKeys.filter(Boolean);
    if (keys.length === 0) return '';
    return `project in (${keys.map((k) => `"${k}"`).join(',')})`;
  }

  private async getMyselfAccountId(): Promise<string | null> {
    if (this.cachedAccountId) return this.cachedAccountId;
    try {
      const res = await this.client.get<JiraMyselfResponse>('/myself');
      this.cachedAccountId = res.data.accountId ?? res.data.key ?? res.data.name ?? null;
      return this.cachedAccountId;
    } catch {
      return null;
    }
  }

  private async search(jql: string, signal?: AbortSignal): Promise<JiraIssueSummary[]> {
    const fields = ['summary', 'status', 'priority', 'assignee', 'reporter', 'issuetype', 'created', 'updated', 'project'];
    // 안전 상한 — 무한루프/과다 요청 방지.
    const HARD_CAP = 500;
    const PAGE_SIZE = 100;
    const out: JiraIssueRaw[] = [];

    if (this.config.authType === 'cloud') {
      // Cloud enhanced search: nextPageToken 기반 페이지네이션.
      let nextPageToken: string | undefined = undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const body: Record<string, unknown> = { jql, fields, maxResults: PAGE_SIZE };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        const res = await this.client.post<JiraSearchResponse>('/search/jql', body, { signal });
        out.push(...res.data.issues);
        if (out.length >= HARD_CAP) break;
        nextPageToken = res.data.nextPageToken;
        if (!nextPageToken || res.data.isLast) break;
      }
    } else {
      // Server/DC: startAt/total 기반 페이지네이션.
      let startAt = 0;
      for (let guard = 0; guard < 20; guard += 1) {
        const res = await this.client.post<JiraSearchResponse & { startAt?: number }>(
          '/search',
          { jql, fields, maxResults: PAGE_SIZE, startAt },
          { signal },
        );
        out.push(...res.data.issues);
        if (out.length >= HARD_CAP) break;
        const total = res.data.total ?? out.length;
        startAt += res.data.issues.length;
        if (res.data.issues.length === 0 || startAt >= total) break;
      }
    }

    return out.slice(0, HARD_CAP).map((raw) => this.normalize(raw));
  }

  /** 나에게 할당된 open 이슈 (Epic 제외 — 에픽은 상위 컨테이너라 작업 대상이 아님) */
  async fetchAssignedIssues(signal?: AbortSignal): Promise<JiraIssueSummary[]> {
    const base = 'assignee = currentUser() AND resolution = Unresolved AND issuetype != Epic';
    const proj = this.projectClause();
    const jql = proj ? `${base} AND ${proj}` : base;
    return this.search(`${jql} ORDER BY updated DESC`, signal);
  }

  /** 최근 생성된 이슈 (감시 프로젝트 내) — 알림용 */
  async fetchRecentlyCreated(signal?: AbortSignal): Promise<JiraIssueSummary[]> {
    const proj = this.projectClause();
    if (!proj) return []; // 프로젝트 지정 없으면 'created' 알림은 오남용 방지로 비활성
    const jql = `${proj} AND created >= -1d ORDER BY created DESC`;
    return this.search(jql, signal);
  }

  /** 키 한 개로 단건 조회 — 웹훅 수신 후 세부 필드 로드용 */
  async fetchByKey(issueKey: string): Promise<JiraIssueSummary | null> {
    try {
      const res = await this.client.get<JiraIssueRaw>(`/issue/${encodeURIComponent(issueKey)}`);
      return this.normalize(res.data);
    } catch (err) {
      log.warn(`jira: fetchByKey(${issueKey}) failed: ${String(err)}`);
      return null;
    }
  }

  normalize(raw: JiraIssueRaw): JiraIssueSummary {
    const assignee = toUserBrief(raw.fields.assignee);
    const reporter = toUserBrief(raw.fields.reporter) ?? {
      accountId: '',
      displayName: '(unknown)',
      avatarUrl: '',
    };
    const baseUrl = this.config.url.replace(/\/$/, '');
    return {
      id: `${this.config.id}::${raw.key}`,
      jiraConfigId: this.config.id,
      issueKey: raw.key,
      summary: raw.fields.summary,
      status: raw.fields.status?.name ?? '',
      priority: raw.fields.priority?.name ?? '',
      issueType: raw.fields.issuetype?.name ?? '',
      issueTypeIconUrl: raw.fields.issuetype?.iconUrl,
      assignee,
      reporter,
      webUrl: `${baseUrl}/browse/${raw.key}`,
      projectKey: raw.fields.project.key,
      createdAt: raw.fields.created,
      updatedAt: raw.fields.updated,
    };
  }

  /** 현재 사용자가 담당자인지 (웹훅 이벤트에서 빠르게 판정) */
  async isAssignedToMe(issue: JiraIssueSummary): Promise<boolean> {
    if (!issue.assignee) return false;
    const me = await this.getMyselfAccountId();
    if (!me) return false;
    return issue.assignee.accountId === me;
  }
}
