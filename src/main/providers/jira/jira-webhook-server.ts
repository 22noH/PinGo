// providers/jira/jira-webhook-server.ts — 로컬 HTTP 웹훅 수신기 (v3, §20.12.A / §20.13.I1)
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import log from 'electron-log';
import type { JiraEvent, JiraIssueSummary } from '../../../shared/types';
import {
  JIRA_WEBHOOK_BODY_LIMIT_BYTES,
  JIRA_WEBHOOK_PATH_PREFIX,
  JIRA_WEBHOOK_REQUEST_TIMEOUT_MS,
} from '../../../shared/constants';

/**
 * Jira Cloud/Server 가 보내는 webhook payload — 필요한 최소 필드만 좁혀서 수용.
 * 참고: https://developer.atlassian.com/cloud/jira/platform/webhooks/
 */
interface JiraWebhookRawPayload {
  webhookEvent?: string;
  issue_event_type_name?: string;
  issue?: {
    id?: string;
    key?: string;
    fields?: {
      summary?: string;
      status?: { name?: string };
      priority?: { name?: string };
      assignee?: { accountId?: string; key?: string; name?: string; displayName?: string; emailAddress?: string; avatarUrls?: Record<string, string> } | null;
      reporter?: { accountId?: string; key?: string; name?: string; displayName?: string; emailAddress?: string; avatarUrls?: Record<string, string> } | null;
      project?: { key?: string };
      created?: string;
      updated?: string;
    };
  };
}

export interface JiraWebhookController {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly token: string;
  readonly localUrl: string;
  rotateToken(): Promise<string>;
}

export interface JiraWebhookDeps {
  port: number;
  token: string;
  onEvent: (ev: JiraEvent) => void;
  onTokenRotate: (newToken: string) => Promise<void>;
  /**
   * 토큰으로 사용 중인 JiraConfig 를 찾기 위해 전달. webhook 유입 시점에서
   * 어떤 connection 의 이벤트인지 판별 불가(Jira 는 보낼 때 식별자 미포함) →
   * JiraConfig 의 baseUrl 매칭은 config 별로 별도 webhook 등록 권장.
   * 이 서버는 단일 token 만 검증하고 payload → JiraIssueSummary 로 변환.
   */
  resolveJiraConfigId: () => string | null;
  resolveBaseUrl: () => string | null;
}

function pathMatches(reqUrl: string | undefined, expectedToken: string): boolean {
  if (!reqUrl) return false;
  const url = reqUrl.split('?')[0];
  if (!url.startsWith(JIRA_WEBHOOK_PATH_PREFIX)) return false;
  const seg = url.slice(JIRA_WEBHOOK_PATH_PREFIX.length).replace(/\/$/, '');
  if (seg.length !== expectedToken.length) return false;
  const a = Buffer.from(seg, 'utf-8');
  const b = Buffer.from(expectedToken, 'utf-8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function toIssueSummary(
  raw: JiraWebhookRawPayload,
  jiraConfigId: string,
  baseUrl: string,
): JiraIssueSummary | null {
  const issue = raw.issue;
  if (!issue || !issue.key) return null;
  const fields = issue.fields ?? {};
  const reporter = fields.reporter;
  const assignee = fields.assignee ?? null;
  return {
    id: `${jiraConfigId}::${issue.key}`,
    jiraConfigId,
    issueKey: issue.key,
    summary: fields.summary ?? '',
    status: fields.status?.name ?? '',
    priority: fields.priority?.name ?? '',
    assignee: assignee
      ? {
          accountId: assignee.accountId ?? assignee.key ?? assignee.name ?? '',
          displayName: assignee.displayName ?? assignee.name ?? '(unknown)',
          email: assignee.emailAddress,
          avatarUrl: assignee.avatarUrls?.['48x48'] ?? assignee.avatarUrls?.['32x32'] ?? '',
        }
      : undefined,
    reporter: {
      accountId: reporter?.accountId ?? reporter?.key ?? reporter?.name ?? '',
      displayName: reporter?.displayName ?? reporter?.name ?? '(unknown)',
      email: reporter?.emailAddress,
      avatarUrl: reporter?.avatarUrls?.['48x48'] ?? reporter?.avatarUrls?.['32x32'] ?? '',
    },
    webUrl: `${baseUrl.replace(/\/$/, '')}/browse/${issue.key}`,
    projectKey: fields.project?.key ?? issue.key.split('-')[0],
    createdAt: fields.created ?? new Date().toISOString(),
    updatedAt: fields.updated ?? new Date().toISOString(),
  };
}

function classifyKind(ev: string | undefined): 'jira_issue_assigned' | 'jira_issue_created' | null {
  if (!ev) return null;
  if (ev === 'jira:issue_created') return 'jira_issue_created';
  if (ev === 'jira:issue_assigned') return 'jira_issue_assigned';
  if (ev === 'jira:issue_updated') return 'jira_issue_assigned'; // assignee 변경은 updated 로 오는 경우가 많음
  return null;
}

export function createJiraWebhookServer(deps: JiraWebhookDeps): JiraWebhookController {
  let server: Server | null = null;
  let running = false;
  let currentToken = deps.token;

  const writeSilent = (res: ServerResponse, code: number): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
  };

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    req.setTimeout(JIRA_WEBHOOK_REQUEST_TIMEOUT_MS, () => {
      try {
        req.destroy();
      } catch {
        /* noop */
      }
    });

    if (req.method !== 'POST') {
      writeSilent(res, 404);
      return;
    }
    if (!pathMatches(req.url, currentToken)) {
      // 타이밍 공격 방어를 위해 401/404 응답 시간은 유사하게 유지 (timingSafeEqual 이 이미 상수 시간).
      writeSilent(res, 401);
      return;
    }
    const ct = (req.headers['content-type'] ?? '').toString().toLowerCase();
    if (!ct.includes('application/json')) {
      writeSilent(res, 400);
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;

    req.on('data', (c: Buffer) => {
      if (rejected) return;
      received += c.length;
      if (received > JIRA_WEBHOOK_BODY_LIMIT_BYTES) {
        rejected = true;
        writeSilent(res, 413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
      let parsed: JiraWebhookRawPayload;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as JiraWebhookRawPayload;
      } catch {
        writeSilent(res, 400);
        return;
      }
      const kind = classifyKind(parsed.webhookEvent);
      const jiraConfigId = deps.resolveJiraConfigId();
      const baseUrl = deps.resolveBaseUrl();
      if (!kind || !jiraConfigId || !baseUrl) {
        // 최소 로그 — 원문 body/token 기록 금지
        log.info(
          `jira-webhook: ignored event=${parsed.webhookEvent ?? 'n/a'} (resolved=${Boolean(jiraConfigId)})`,
        );
        res.writeHead(204);
        res.end();
        return;
      }
      const issueSummary = toIssueSummary(parsed, jiraConfigId, baseUrl);
      if (!issueSummary) {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        deps.onEvent({ kind, issue: issueSummary });
      } catch (err) {
        log.warn(`jira-webhook: onEvent handler threw: ${String(err)}`);
      }
      log.info(`jira-webhook: ${kind} key=${issueSummary.issueKey}`);
      res.writeHead(204);
      res.end();
    });
    req.on('error', (err) => {
      log.warn(`jira-webhook: req error ${String(err)}`);
      writeSilent(res, 500);
    });
  };

  return {
    get token(): string {
      return currentToken;
    },
    get localUrl(): string {
      return `http://127.0.0.1:${deps.port}${JIRA_WEBHOOK_PATH_PREFIX}${currentToken}`;
    },
    start: async (): Promise<void> => {
      if (running) return;
      await new Promise<void>((resolve, reject) => {
        server = createServer(handleRequest);
        server.once('error', (err) => reject(err));
        server.listen(deps.port, '127.0.0.1', () => {
          const addr = server?.address();
          if (!addr || typeof addr === 'string' || addr.address !== '127.0.0.1') {
            server?.close();
            reject(new Error('jira-webhook: bind address is not 127.0.0.1'));
            return;
          }
          running = true;
          log.info(`jira-webhook: listening on http://127.0.0.1:${addr.port}${JIRA_WEBHOOK_PATH_PREFIX}[REDACTED]`);
          resolve();
        });
      });
    },
    stop: async (): Promise<void> => {
      if (!server || !running) return;
      await new Promise<void>((resolve) => {
        server?.close(() => {
          running = false;
          log.info('jira-webhook: stopped');
          resolve();
        });
      });
      server = null;
    },
    rotateToken: async (): Promise<string> => {
      const fresh = randomBytes(32).toString('hex');
      await deps.onTokenRotate(fresh);
      currentToken = fresh;
      log.info('jira-webhook: token rotated');
      return fresh;
    },
  };
}
