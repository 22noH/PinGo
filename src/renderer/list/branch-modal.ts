// branch-modal.ts — Orchestrator: 상태/이벤트/IPC 호출.
// slugify/validate 는 branch-utils.ts, DOM 구축은 branch-modal-view.ts.
// strict mode — no `any`, no console.log
import type {
  BranchCreatePayload,
  BranchCreateResult,
  BranchListResult,
  GitConfig,
  GitProjectSummary,
  JiraIssueSummary,
  ProjectListResult,
} from '../../shared/types';
import { BRANCH_NAME_PREFIX } from '../../shared/constants';
import { slugify, validateBranchName } from './branch-utils';
import {
  buildBranchModalView,
  type BranchModalView,
} from './branch-modal-view';

export interface BranchModalOpenArgs {
  issue: JiraIssueSummary;
  gitConnections: GitConfig[];
  preferredGitConfigId?: string;
}

/** 연결별 프로젝트 목록 캐시 — 모달 여러 번 열 때 매번 API 호출 안 하도록 */
const projectListCache = new Map<string, GitProjectSummary[]>();

export function openBranchModal(args: BranchModalOpenArgs): () => void {
  const { issue, gitConnections } = args;
  if (gitConnections.length === 0) {
    window.alert('먼저 설정에서 Git 연결을 하나 이상 추가하세요.');
    return (): void => { /* noop */ };
  }

  const initialBranchName = `${BRANCH_NAME_PREFIX}/${issue.issueKey}-${slugify(issue.summary)}`;
  let selectedGitId = args.preferredGitConfigId ?? gitConnections[0].id;
  let baseBranch = '';
  let projectRef = '';
  /** 현재 연결의 프로젝트 목록 (로드 후 채움). defaultBranch 자동선택용으로도 사용. */
  let currentProjects: GitProjectSummary[] = [];

  const view: BranchModalView = buildBranchModalView({
    issue,
    gitConnections,
    initialBranchName,
    initialGitId: selectedGitId,
    onGitChange: (id: string): void => {
      selectedGitId = id;
      projectRef = '';
      baseBranch = '';
      void loadProjects();
    },
    onProjectChange: (value: string): void => {
      projectRef = value;
      void loadBranches();
    },
    onBaseChange: (name: string): void => { baseBranch = name; validateAndPaint(); },
    onNameInput: (): void => { validateAndPaint(); },
    onCopy: (): void => { void copyBranch(); },
    onCancel: close,
    onCreate: (): void => { void create(); },
  });

  document.body.appendChild(view.backdrop);
  view.nameInput.focus();
  view.nameInput.select();

  const keyHandler = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', keyHandler);
  view.backdrop.addEventListener('click', (e: MouseEvent): void => {
    if (e.target === view.backdrop) close();
  });

  function validateAndPaint(): boolean {
    const err = validateBranchName(view.nameInput.value.trim());
    if (err) {
      view.nameInput.setAttribute('aria-invalid', 'true');
      view.nameError.textContent = err;
      view.nameError.hidden = false;
      view.createBtn.disabled = true;
      return false;
    }
    view.nameInput.removeAttribute('aria-invalid');
    view.nameError.hidden = true;
    view.createBtn.disabled = !baseBranch;
    return true;
  }

  async function copyBranch(): Promise<void> {
    try {
      await navigator.clipboard.writeText(view.nameInput.value.trim());
      view.copyBtn.classList.add('is-copied');
      view.copyBtn.textContent = '복사됨';
      window.setTimeout((): void => {
        view.copyBtn.classList.remove('is-copied');
        view.copyBtn.textContent = '복사';
      }, 1600);
    } catch (err) {
      showFeedback('error', `복사 실패: ${msg(err)}`);
    }
  }

  function renderProjectSelect(projects: GitProjectSummary[]): void {
    view.projectSelect.innerHTML = '';
    if (projects.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '접근 가능한 프로젝트가 없습니다';
      opt.disabled = true;
      opt.selected = true;
      view.projectSelect.appendChild(opt);
      view.projectSelect.disabled = true;
      return;
    }
    // placeholder
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— 프로젝트 선택 —';
    placeholder.disabled = true;
    placeholder.selected = true;
    view.projectSelect.appendChild(placeholder);
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.name;
      if (p.description) opt.title = p.description;
      view.projectSelect.appendChild(opt);
    }
    view.projectSelect.disabled = false;
  }

  async function loadProjects(): Promise<void> {
    const cfg = gitConnections.find((c) => c.id === selectedGitId);
    if (!cfg) return;
    // 베이스 브랜치 초기화
    view.baseSelect.innerHTML = '';
    const waitOpt = document.createElement('option');
    waitOpt.value = '';
    waitOpt.textContent = '프로젝트를 먼저 선택하세요';
    view.baseSelect.appendChild(waitOpt);
    view.baseSelect.disabled = true;
    view.createBtn.disabled = true;

    // 캐시 확인
    const cached = projectListCache.get(cfg.id);
    if (cached) {
      currentProjects = cached;
      renderProjectSelect(cached);
      return;
    }

    // 로딩 표시
    view.projectSelect.innerHTML = '';
    const loading = document.createElement('option');
    loading.value = '';
    loading.textContent = '프로젝트 목록 로드 중…';
    view.projectSelect.appendChild(loading);
    view.projectSelect.disabled = true;

    try {
      const res: ProjectListResult = await window.electronAPI.listProjects({ gitConfigId: cfg.id });
      if (!res.success || !Array.isArray(res.projects)) {
        showFeedback('error', `프로젝트 목록 로드 실패: ${res.error ?? '알 수 없음'}`);
        currentProjects = [];
        renderProjectSelect([]);
        return;
      }
      currentProjects = res.projects;
      projectListCache.set(cfg.id, res.projects);
      renderProjectSelect(res.projects);
    } catch (err) {
      showFeedback('error', `프로젝트 목록 로드 실패: ${msg(err)}`);
      currentProjects = [];
      renderProjectSelect([]);
    }
  }

  async function loadBranches(): Promise<void> {
    const cfg = gitConnections.find(c => c.id === selectedGitId);
    if (!cfg || !projectRef) return;
    view.baseSelect.disabled = true;
    view.baseSelect.innerHTML = '';
    const loading = document.createElement('option');
    loading.value = '';
    loading.textContent = '브랜치 목록 로드 중…';
    view.baseSelect.appendChild(loading);

    const isNumericId = /^\d+$/.test(projectRef);
    const payloadProjectId: number | string = cfg.type === 'gitlab'
      ? (isNumericId ? Number(projectRef) : projectRef)
      : 0;
    const payloadRepoFullName = cfg.type === 'github' ? projectRef : undefined;
    try {
      const res: BranchListResult = await window.electronAPI.listBranches({
        gitConfigId: cfg.id,
        projectId: payloadProjectId,
        repoFullName: payloadRepoFullName,
      });
      if (!res.success || !Array.isArray(res.branches)) {
        showFeedback('error', `베이스 브랜치 로드 실패: ${res.error ?? '알 수 없음'}`);
        baseBranch = '';
        view.createBtn.disabled = true;
        return;
      }
      view.baseSelect.innerHTML = '';
      // 프로젝트 메타의 defaultBranch 와 API 응답 양쪽 고려해 기본 선택
      const projectMeta = currentProjects.find((p) => p.value === projectRef);
      const pickDefault = projectMeta?.defaultBranch ?? pickDefaultBranch(res);
      for (const name of normalizeBranchNames(res)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name === pickDefault ? `${name}  (default)` : name;
        if (name === pickDefault) opt.selected = true;
        view.baseSelect.appendChild(opt);
      }
      baseBranch = pickDefault ?? '';
      view.baseSelect.disabled = false;
      validateAndPaint();
    } catch (err) {
      showFeedback('error', `베이스 브랜치 로드 실패: ${msg(err)}`);
    }
  }

  async function create(): Promise<void> {
    if (!validateAndPaint()) return;
    const cfg = gitConnections.find(c => c.id === selectedGitId);
    if (!cfg) return;
    view.createBtn.disabled = true;
    showFeedback('info', '브랜치 생성 중…');
    const isNumericId = /^\d+$/.test(projectRef);
    const projectId: number | string = cfg.type === 'gitlab'
      ? (isNumericId ? Number(projectRef) : projectRef)
      : 0;
    const repoFullName = cfg.type === 'github' ? projectRef : undefined;
    const payload: BranchCreatePayload = {
      gitConfigId: cfg.id,
      jiraIssueKey: issue.issueKey,
      branchName: view.nameInput.value.trim(),
      baseBranch,
      projectId,
      repoFullName,
    };
    try {
      const res: BranchCreateResult = await window.electronAPI.createBranch(payload);
      if (res.success) {
        try { await navigator.clipboard.writeText(res.branchName ?? payload.branchName); } catch { /* noop */ }
        showFeedback('success', `${res.branchName ?? payload.branchName} 생성 완료. 클립보드에 복사됨.`);
        window.setTimeout(close, 1500);
      } else {
        showFeedback('error', translateBranchError(res.errorCode));
        view.createBtn.disabled = false;
      }
    } catch (err) {
      showFeedback('error', `실패: ${msg(err)}`);
      view.createBtn.disabled = false;
    }
  }

  function showFeedback(kind: 'success' | 'error' | 'info', text: string): void {
    view.feedback.className = `action-feedback is-${kind}`;
    view.feedback.textContent = text;
    view.feedback.hidden = false;
  }

  function close(): void {
    document.removeEventListener('keydown', keyHandler);
    view.backdrop.remove();
  }

  // 최초 로드: 프로젝트 목록부터
  void loadProjects();
  return close;
}

// ── 헬퍼 ─────────────────────────────────────────────────────
function msg(err: unknown): string { return err instanceof Error ? err.message : String(err); }

/**
 * §20.12.C — errorCode 번역 테이블.
 * API error body 는 로그 전용, UI 에는 친화 문자열만 노출.
 */
function translateBranchError(code: BranchCreateResult['errorCode']): string {
  switch (code) {
    case 'conflict':  return '이미 같은 이름의 브랜치가 존재합니다.';
    case 'forbidden': return '브랜치를 생성할 권한이 없습니다. 토큰 scope 를 확인하세요.';
    case 'not_found': return '대상 저장소 또는 베이스 브랜치를 찾을 수 없습니다.';
    case 'network':   return '네트워크 오류로 브랜치 생성에 실패했습니다.';
    default:          return '브랜치 생성에 실패했습니다.';
  }
}

interface BranchListResultExt { branches?: unknown; defaultBranch?: string }

function normalizeBranchNames(res: BranchListResult): string[] {
  const b = (res as BranchListResultExt).branches;
  if (!Array.isArray(b)) return [];
  return b.map((x): string => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object' && 'name' in x && typeof (x as { name: unknown }).name === 'string') {
      return (x as { name: string }).name;
    }
    return '';
  }).filter((n): n is string => n.length > 0);
}

function pickDefaultBranch(res: BranchListResult): string | undefined {
  const r = res as BranchListResultExt;
  if (typeof r.defaultBranch === 'string' && r.defaultBranch) return r.defaultBranch;
  const b = r.branches;
  if (Array.isArray(b)) {
    for (const x of b) {
      if (x && typeof x === 'object' && 'isDefault' in x && (x as { isDefault?: boolean }).isDefault) {
        const name = (x as { name?: unknown }).name;
        if (typeof name === 'string') return name;
      }
    }
    if (b.length > 0) {
      const first = b[0];
      if (typeof first === 'string') return first;
      if (first && typeof first === 'object' && 'name' in first && typeof (first as { name: unknown }).name === 'string') {
        return (first as { name: string }).name;
      }
    }
  }
  return undefined;
}
