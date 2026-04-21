// branch-modal-view.ts — 브랜치 생성 모달 DOM 구축 (로직 없음)
// strict mode — no `any`, no console.log, XSS 방어 (textContent 만 사용)
import type { GitConfig, JiraIssueSummary } from '../../shared/types';
import { PROVIDER_SHORT_LABEL } from '../../shared/constants';

export interface BranchModalView {
  backdrop: HTMLDivElement;
  gitSelect: HTMLSelectElement;
  projectSelect: HTMLSelectElement;
  baseSelect: HTMLSelectElement;
  nameInput: HTMLInputElement;
  nameError: HTMLSpanElement;
  copyBtn: HTMLButtonElement;
  createBtn: HTMLButtonElement;
  feedback: HTMLDivElement;
}

export interface BranchModalViewArgs {
  issue: JiraIssueSummary;
  gitConnections: GitConfig[];
  initialBranchName: string;
  initialGitId: string;
  onGitChange: (id: string) => void;
  onProjectChange: (value: string) => void;
  onBaseChange: (name: string) => void;
  onNameInput: () => void;
  onCopy: () => void;
  onCancel: () => void;
  onCreate: () => void;
}

export function buildBranchModalView(a: BranchModalViewArgs): BranchModalView {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', '브랜치 생성');

  const modal = document.createElement('div');
  modal.className = 'modal modal-sm';
  backdrop.appendChild(modal);

  modal.appendChild(buildHeader(a.issue, a.onCancel));
  const body = document.createElement('div');
  body.className = 'modal-body col';
  modal.appendChild(body);

  // 이슈 요약
  const summary = document.createElement('p');
  summary.className = 'text-secondary';
  summary.style.margin = '0 0 var(--space-3)';
  summary.textContent = a.issue.summary;
  body.appendChild(summary);

  // Git 연결 선택
  const gitSelect = buildGitSelect(a.gitConnections, a.initialGitId);
  body.appendChild(fieldWrap('Git 연결', 'branch-git-select', gitSelect));
  gitSelect.addEventListener('change', (): void => a.onGitChange(gitSelect.value));

  // 프로젝트/저장소 — API 로 목록 로드 후 채움 (branch-modal.ts 에서 주입)
  const projectSelect = document.createElement('select');
  projectSelect.id = 'branch-project-select';
  projectSelect.className = 'select';
  projectSelect.disabled = true;
  const projectLoading = document.createElement('option');
  projectLoading.value = '';
  projectLoading.textContent = '프로젝트 목록 로드 중…';
  projectSelect.appendChild(projectLoading);
  projectSelect.addEventListener('change', (): void => a.onProjectChange(projectSelect.value));
  body.appendChild(fieldWrap('프로젝트 / 저장소', 'branch-project-select', projectSelect));

  // 베이스 브랜치
  const baseSelect = document.createElement('select');
  baseSelect.id = 'branch-base-select';
  baseSelect.className = 'select';
  baseSelect.disabled = true;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '브랜치 목록 로드 중…';
  baseSelect.appendChild(placeholder);
  body.appendChild(fieldWrap('베이스 브랜치', 'branch-base-select', baseSelect));
  baseSelect.addEventListener('change', (): void => a.onBaseChange(baseSelect.value));

  // 브랜치명 (모노폰트 + copy)
  const nameLabel = document.createElement('label');
  nameLabel.className = 'field-label';
  nameLabel.setAttribute('for', 'branch-name-input');
  nameLabel.textContent = '브랜치명';

  const nameGroup = document.createElement('div');
  nameGroup.className = 'branch-input-group';

  const nameInput = document.createElement('input');
  nameInput.id = 'branch-name-input';
  nameInput.className = 'input';
  nameInput.type = 'text';
  nameInput.spellcheck = false;
  nameInput.value = a.initialBranchName;
  nameInput.addEventListener('input', (): void => a.onNameInput());
  nameGroup.appendChild(nameInput);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'branch-copy-btn';
  copyBtn.textContent = '복사';
  copyBtn.addEventListener('click', (): void => a.onCopy());
  nameGroup.appendChild(copyBtn);

  const nameError = document.createElement('span');
  nameError.className = 'field-error';
  nameError.hidden = true;

  const nameWrap = document.createElement('div');
  nameWrap.className = 'field';
  nameWrap.appendChild(nameLabel);
  nameWrap.appendChild(nameGroup);
  nameWrap.appendChild(nameError);
  body.appendChild(nameWrap);

  // 피드백 라인
  const feedback = document.createElement('div');
  feedback.className = 'action-feedback is-info';
  feedback.hidden = true;
  body.appendChild(feedback);

  // 푸터
  const footer = document.createElement('footer');
  footer.className = 'modal-footer';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('click', (): void => a.onCancel());
  const sep = document.createElement('span');
  sep.className = 'sep';
  const createBtn = document.createElement('button');
  createBtn.type = 'button';
  createBtn.className = 'btn btn-jira';
  createBtn.textContent = '브랜치 생성';
  createBtn.disabled = true;
  createBtn.addEventListener('click', (): void => a.onCreate());
  footer.appendChild(cancelBtn);
  footer.appendChild(sep);
  footer.appendChild(createBtn);
  modal.appendChild(footer);

  return { backdrop, gitSelect, projectSelect, baseSelect, nameInput, nameError, copyBtn, createBtn, feedback };
}

function buildHeader(issue: JiraIssueSummary, onClose: () => void): HTMLElement {
  const header = document.createElement('header');
  header.className = 'modal-header';
  const title = document.createElement('span');
  title.className = 'modal-title';
  title.textContent = `브랜치 생성 · ${issue.issueKey}`;
  header.appendChild(title);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'modal-close';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (): void => onClose());
  header.appendChild(closeBtn);
  return header;
}

function buildGitSelect(gits: GitConfig[], initial: string): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.id = 'branch-git-select';
  sel.className = 'select';
  for (const g of gits) {
    const opt = document.createElement('option');
    opt.value = g.id;
    const short = PROVIDER_SHORT_LABEL[g.type];
    const lbl = g.label?.trim() || (g.type === 'gitlab' ? g.url : `@${g.username}`);
    opt.textContent = `[${short}] ${lbl}`;
    if (g.id === initial) opt.selected = true;
    sel.appendChild(opt);
  }
  return sel;
}

function fieldWrap(labelText: string, forId: string, control: HTMLElement): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.setAttribute('for', forId);
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(control);
  return wrap;
}
