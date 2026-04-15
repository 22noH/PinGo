// main/poller.ts — GitLab MR 폴러
import axios, { AxiosError, AxiosInstance, AxiosRequestHeaders } from 'axios';
import log from 'electron-log';
import type {
  AppSettings,
  MergeRequestSummary,
  MergeRequestWithChanges,
} from '../shared/types';

export type MrFoundCallback = (newMrs: MergeRequestSummary[]) => void;
export type PollErrorCallback = (error: Error) => void;
export type PollTickCallback = (at: Date) => void;

export interface PollerController {
  start(): void;
  stop(): void;
  restart(settings: AppSettings): void;
}

// ── GitLab API 원시 응답 타입 (internal) ────────────────────
interface GitLabMRListItem {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  author: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
  };
  web_url: string;
  source_branch: string;
  target_branch: string;
  reviewers?: Array<{ id: number }>;
  project_id: number;
  diff_refs: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  } | null;
  created_at: string;
  updated_at: string;
}

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

interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

function normalize(raw: GitLabMRListItem): MergeRequestSummary {
  return {
    id: raw.id,
    iid: raw.iid,
    title: raw.title,
    description: raw.description ?? '',
    author: raw.author,
    web_url: raw.web_url,
    source_branch: raw.source_branch,
    target_branch: raw.target_branch,
    reviewer_ids: (raw.reviewers ?? []).map((r) => r.id),
    project_id: raw.project_id,
    diff_refs: raw.diff_refs ?? { base_sha: '', head_sha: '', start_sha: '' },
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function maskHeaders(headers: AxiosRequestHeaders | undefined): Record<string, unknown> {
  if (!headers) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'PRIVATE-TOKEN' || key === 'Authorization') {
      safe[key] = '[REDACTED]';
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function makeClient(gitlabUrl: string, token: string): AxiosInstance {
  const client = axios.create({
    baseURL: `${gitlabUrl.replace(/\/$/, '')}/api/v4`,
    headers: { 'PRIVATE-TOKEN': token },
    timeout: 15_000,
  });
  client.interceptors.response.use(
    (res) => res,
    (err: unknown) => {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const safe = maskHeaders(err.config?.headers as AxiosRequestHeaders | undefined);
        log.warn(`axios error status=${status ?? 'n/a'} url=${err.config?.url ?? ''}`, safe);
      }
      return Promise.reject(err);
    },
  );
  return client;
}

export async function fetchOpenMrs(
  gitlabUrl: string,
  token: string,
  userId: number,
  signal?: AbortSignal,
): Promise<MergeRequestSummary[]> {
  const client = makeClient(gitlabUrl, token);
  const res = await client.get<GitLabMRListItem[]>('/merge_requests', {
    params: {
      scope: 'all',
      state: 'opened',
      reviewer_id: userId,
      order_by: 'updated_at',
      sort: 'desc',
      per_page: 20,
    },
    signal,
  });
  return res.data.map(normalize);
}

export async function fetchMrChanges(
  gitlabUrl: string,
  token: string,
  projectId: number,
  iid: number,
): Promise<MergeRequestWithChanges> {
  const client = makeClient(gitlabUrl, token);
  const res = await client.get<GitLabMRChanges>(
    `/projects/${projectId}/merge_requests/${iid}/changes`,
  );
  const base = normalize(res.data);
  return { ...base, changes: res.data.changes };
}

/** GET /user — 연결/토큰 검증용 */
export async function fetchCurrentUser(
  gitlabUrl: string,
  token: string,
): Promise<GitLabUser> {
  const client = makeClient(gitlabUrl, token);
  const res = await client.get<GitLabUser>('/user');
  return res.data;
}

export function classifyError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    if (status === 401) return new Error('GitLab 인증 실패 (401): 토큰을 확인하세요');
    if (status === 403) return new Error('GitLab 권한 없음 (403)');
    if (status === 429) return new Error('GitLab rate limit (429)');
    if (status && status >= 500) return new Error(`GitLab 서버 오류 (${status})`);
    return new Error(`GitLab 요청 실패: ${ax.message}`);
  }
  if (err instanceof Error) return err;
  return new Error('알 수 없는 오류');
}

export function createPoller(
  initialSettings: AppSettings,
  seenIds: Set<number>,
  onFound: MrFoundCallback,
  onError: PollErrorCallback,
  onTick?: PollTickCallback,
): PollerController {
  let settings: AppSettings = { ...initialSettings };
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let abortController: AbortController | null = null;

  const abortInFlight = (reason: string): void => {
    if (abortController) {
      log.info(`poller: aborting in-flight request (${reason})`);
      abortController.abort();
      abortController = null;
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight) {
      log.debug('poller: previous tick still running, skipping');
      return;
    }
    if (!settings.gitlabUrl || !settings.token || !settings.userId) {
      log.debug('poller: settings incomplete, skipping tick');
      return;
    }
    inFlight = true;
    abortController = new AbortController();
    const mySignal = abortController.signal;
    try {
      const list = await fetchOpenMrs(
        settings.gitlabUrl,
        settings.token,
        settings.userId,
        mySignal,
      );
      const now = new Date();
      onTick?.(now);

      const newMrs = list.filter((m) => !seenIds.has(m.id));
      if (newMrs.length > 0) {
        log.info(`poller: ${newMrs.length} new MR(s) detected`);
        onFound(newMrs);
      } else {
        log.debug(`poller: no new MRs (total open: ${list.length})`);
      }
    } catch (err) {
      // abort된 요청은 stop/restart가 이미 기록했으므로 에러 콜백 스킵
      if (mySignal.aborted || axios.isCancel(err)) {
        log.debug('poller: tick aborted');
      } else {
        onError(classifyError(err));
      }
    } finally {
      inFlight = false;
      if (abortController && abortController.signal === mySignal) {
        abortController = null;
      }
    }
  };

  const scheduleNext = (): void => {
    if (timer) clearInterval(timer);
    timer = setInterval((): void => {
      void tick();
    }, settings.pollIntervalMs);
  };

  return {
    start: (): void => {
      log.info(`poller: start (interval=${settings.pollIntervalMs}ms)`);
      void tick();
      scheduleNext();
    },
    stop: (): void => {
      log.info('poller: stop');
      abortInFlight('stop');
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    restart: (next: AppSettings): void => {
      log.info('poller: restart with new settings');
      abortInFlight('restart');
      settings = { ...next };
      if (timer) clearInterval(timer);
      void tick();
      scheduleNext();
    },
  };
}
