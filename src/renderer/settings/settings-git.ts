// settings-git.ts — [Git 연결] 탭 로직
// 카드 목록 렌더 + 인라인 편집 폼 open/close orchestration (폼 렌더는 settings-git-form 위임)
// strict mode — no `any`, no console.log, XSS 방지
import type { GitConfig, GitProviderType } from '../../shared/types';
import { PROVIDER_SHORT_LABEL, PROVIDER_DISPLAY_NAME } from '../../shared/constants';
import { renderForm } from './settings-git-form';

// ── 상태 ─────────────────────────────────────────────────────
let connections: GitConfig[] = [];
let editingId: string | null = null;
let formOpen = false;
let dirty = false;

// ── DOM ──────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const listEl   = $<HTMLUListElement>('connection-list');
const emptyEl  = $<HTMLDivElement>('connection-empty');
const addBtn   = $<HTMLButtonElement>('btn-add-connection');
const formHost = $<HTMLDivElement>('git-form-host');

// ── Public API (settings.ts가 호출) ──────────────────────────
export async function initGitTab(initial: GitConfig[]): Promise<void> {
  try {
    const r = await window.electronAPI.loadGitConnections();
    connections = Array.isArray(r.gitConnections) ? r.gitConnections.slice() : initial.slice();
  } catch {
    connections = initial.slice();
  }
  dirty = false;
  renderList();
  addBtn.addEventListener('click', (): void => openForm(null));
}

export function flushGitPendingChanges(): GitConfig[] {
  return connections.slice();
}

export function hasUnsavedGitChanges(): boolean {
  return dirty || formOpen;
}

// ── 목록 렌더 ────────────────────────────────────────────────
function renderList(): void {
  listEl.innerHTML = '';
  if (connections.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const c of connections) listEl.appendChild(renderCard(c));
}

function renderCard(c: GitConfig): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'connection-card';
  li.dataset.id = c.id;

  // provider 배지
  const badge = document.createElement('span');
  badge.className = `provider-badge is-${c.type}`;
  badge.textContent = PROVIDER_SHORT_LABEL[c.type];
  li.appendChild(badge);

  // 본문
  const body = document.createElement('div');
  body.className = 'connection-card-body';

  const title = document.createElement('div');
  title.className = 'connection-card-title';
  const titleText = document.createElement('span');
  titleText.className = 'truncate';
  titleText.textContent = describeTitle(c);
  title.appendChild(titleText);
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'connection-card-meta';
  meta.textContent = describeMeta(c);
  body.appendChild(meta);
  li.appendChild(body);

  // 액션
  const actions = document.createElement('div');
  actions.className = 'connection-card-actions';
  actions.appendChild(makeGhostBtn('편집', (): void => openForm(c.id)));
  actions.appendChild(makeGhostBtn('삭제', (): void => removeConnection(c.id)));
  li.appendChild(actions);
  return li;
}

function makeGhostBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost btn-sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function describeTitle(c: GitConfig): string {
  const name = PROVIDER_DISPLAY_NAME[c.type];
  if (c.label && c.label.trim()) return `${name} · ${c.label.trim()}`;
  if (c.type === 'gitlab') return `${name} · ${safeHost(c.url)}`;
  return `${name} · @${c.username}`;
}

function describeMeta(c: GitConfig): string {
  if (c.type === 'gitlab') return `${c.url}${c.userId ? `  ·  User ID ${c.userId}` : ''}`;
  return `github.com  ·  @${c.username}`;
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function removeConnection(id: string): void {
  const c = connections.find(x => x.id === id);
  const label = c ? describeTitle(c) : '이 연결';
  if (!window.confirm(`${label}을(를) 삭제할까요?`)) return;
  connections = connections.filter(x => x.id !== id);
  dirty = true;
  if (editingId === id) closeForm();
  renderList();
}

// ── 편집 폼 open/close ──────────────────────────────────────
function openForm(id: string | null): void {
  editingId = id;
  formOpen = true;
  const existing = id ? connections.find(c => c.id === id) ?? null : null;
  const type: GitProviderType = existing?.type ?? 'gitlab';
  mountForm(type, existing);
}

function mountForm(type: GitProviderType, existing: GitConfig | null): void {
  formHost.hidden = false;
  formHost.innerHTML = '';
  formHost.appendChild(renderForm(type, existing, {
    onSubmit: (cfg: GitConfig): void => {
      upsert(cfg);
      dirty = true;
      closeForm();
      renderList();
    },
    onCancel: closeForm,
    onTypeChange: (next: GitProviderType): void => {
      // 신규 추가 모드에서만 타입 전환 가능 — 기존 편집은 disabled된 select
      mountForm(next, null);
    },
  }));
}

function closeForm(): void {
  formOpen = false;
  editingId = null;
  formHost.innerHTML = '';
  formHost.hidden = true;
}

function upsert(cfg: GitConfig): void {
  const idx = connections.findIndex(c => c.id === cfg.id);
  if (idx >= 0) connections[idx] = cfg;
  else connections.push(cfg);
}
