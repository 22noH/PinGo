// main/ipc-branch.ts — 브랜치 생성/목록 IPC (v3, §20.13.I4 sanitize 강화)
import { ipcMain } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  BranchCreatePayload,
  BranchCreateResult,
  BranchListPayload,
  BranchListResult,
  ProjectListPayload,
  ProjectListResult,
  StoreSchema,
} from '../shared/types';
import {
  BRANCH_CREATE,
  BRANCH_LIST,
  BRANCH_NAME_MAX_SLUG_LEN,
  BRANCH_NAME_MAX_TOTAL_LEN,
  BRANCH_NAME_PREFIX,
  PROJECT_LIST,
} from '../shared/constants';
import { createGitProvider } from './providers/git/git-provider';

export interface BranchIpcDeps {
  store: Store<StoreSchema>;
}

/**
 * slug 생성 — §20.12.C / §20.13.I4
 *   1) NFKD 정규화 후 ASCII 범위 외 문자/이모지/제어문자 → 공백
 *   2) 소문자 변환
 *   3) [^a-z0-9]+ → '-' 치환
 *   4) 연속 '-' 축약, 앞뒤 '-' 트림
 *   5) 길이 ≤ BRANCH_NAME_MAX_SLUG_LEN (40)
 */
export function buildSlug(title: string): string {
  const normalized = title.normalize('NFKD');
  // \p{Extended_Pictographic} 이모지 + 제어문자 + 비ASCII → 공백
  const ascii = normalized.replace(/[\u0000-\u001F]|[^\x20-\x7E]/g, ' ');
  const lower = ascii.toLowerCase();
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return hyphen.slice(0, BRANCH_NAME_MAX_SLUG_LEN);
}

export function buildBranchName(issueKey: string, title: string): string {
  const slug = buildSlug(title) || 'work';
  return `${BRANCH_NAME_PREFIX}/${issueKey}-${slug}`;
}

/**
 * 전체 branchName 검증 (§20.13.I4):
 *  - [a-zA-Z0-9/_-] 허용
 *  - slash ≤ 2
 *  - 첫 글자 영문자
 *  - 길이 ≤ BRANCH_NAME_MAX_TOTAL_LEN (255)
 *  - 금지: '..', '~', '^', ':', '?', '*', '[', '\\', 공백, '//', trailing '.', '.lock', leading '-'
 */
export function isValidBranchName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > BRANCH_NAME_MAX_TOTAL_LEN) return false;
  if (!/^[a-zA-Z]/.test(name)) return false;
  if (!/^[a-zA-Z0-9/_-]+$/.test(name)) return false;
  if ((name.match(/\//g) ?? []).length > 2) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.startsWith('-')) return false;
  const bad = ['~', '^', ':', '?', '*', '[', '\\', ' '];
  for (const ch of bad) if (name.includes(ch)) return false;
  return true;
}

/**
 * baseBranch 검증 — §20.13.I4, §20.12.C.
 * 임의 IPC 위변조 방지: renderer 드롭다운에서 왔다고 해도 서버에서 재검증.
 * 단 base 는 기존 브랜치이므로 prefix 규칙(영문자 시작) 대신 git ref 안전 문자만 확인.
 */
export function isValidBaseBranch(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > BRANCH_NAME_MAX_TOTAL_LEN) return false;
  if (!/^[a-zA-Z0-9/_.-]+$/.test(name)) return false;
  if (name.includes('..') || name.includes('//')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name.startsWith('-') || name.startsWith('/')) return false;
  const bad = ['~', '^', ':', '?', '*', '[', '\\', ' '];
  for (const ch of bad) if (name.includes(ch)) return false;
  return true;
}

async function handleCreate(
  deps: BranchIpcDeps,
  payload: BranchCreatePayload,
): Promise<BranchCreateResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다', errorCode: 'not_found' };
  if (!payload.branchName || !payload.baseBranch) {
    return { success: false, error: '브랜치명/베이스 브랜치가 비어있습니다', errorCode: 'unknown' };
  }
  if (!isValidBranchName(payload.branchName)) {
    return { success: false, error: 'invalid_branch_name', errorCode: 'unknown' };
  }
  if (!isValidBaseBranch(payload.baseBranch)) {
    return { success: false, error: 'invalid_base_branch', errorCode: 'unknown' };
  }

  const provider = createGitProvider(cfg);
  if (!provider.createBranch) {
    return {
      success: false,
      error: '이 provider 는 브랜치 생성을 지원하지 않습니다',
      errorCode: 'unknown',
    };
  }
  try {
    return await provider.createBranch(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 원문 API error body 노출 금지 — 요약만.
    log.error(`ipc-branch: createBranch failed (${payload.gitConfigId.slice(0, 8)}): ${msg.slice(0, 200)}`);
    return { success: false, error: 'create_failed', errorCode: 'unknown' };
  }
}

async function handleList(
  deps: BranchIpcDeps,
  payload: BranchListPayload,
): Promise<BranchListResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다' };
  const provider = createGitProvider(cfg);
  if (!provider.listBranches) {
    return { success: false, error: '이 provider 는 브랜치 목록을 지원하지 않습니다' };
  }
  try {
    return await provider.listBranches(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ipc-branch: listBranches failed: ${msg.slice(0, 200)}`);
    return { success: false, error: 'list_failed' };
  }
}

async function handleListProjects(
  deps: BranchIpcDeps,
  payload: ProjectListPayload,
): Promise<ProjectListResult> {
  const settings = deps.store.get('settings');
  const cfg = settings.gitConnections.find((c) => c.id === payload.gitConfigId);
  if (!cfg) return { success: false, error: '연결을 찾을 수 없습니다' };
  const provider = createGitProvider(cfg);
  if (!provider.listProjects) {
    return { success: false, error: '이 provider 는 프로젝트 목록을 지원하지 않습니다' };
  }
  try {
    const projects = await provider.listProjects();
    return { success: true, projects };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ipc-branch: listProjects failed: ${msg.slice(0, 200)}`);
    return { success: false, error: 'list_failed' };
  }
}

export function registerBranchHandlers(deps: BranchIpcDeps): void {
  ipcMain.handle(
    BRANCH_CREATE,
    (_e, payload: BranchCreatePayload): Promise<BranchCreateResult> =>
      handleCreate(deps, payload),
  );
  ipcMain.handle(
    BRANCH_LIST,
    (_e, payload: BranchListPayload): Promise<BranchListResult> =>
      handleList(deps, payload),
  );
  ipcMain.handle(
    PROJECT_LIST,
    (_e, payload: ProjectListPayload): Promise<ProjectListResult> =>
      handleListProjects(deps, payload),
  );
  log.info('ipc-branch: handlers registered');
}

export function unregisterBranchHandlers(): void {
  ipcMain.removeHandler(BRANCH_CREATE);
  ipcMain.removeHandler(BRANCH_LIST);
  ipcMain.removeHandler(PROJECT_LIST);
}
