// settings-jira.ts — [Jira] 탭 로직
// 연결 카드 목록 + 인라인 폼 + webhook 수신기 토글/URL/복사
// strict mode — no `any`, no console.log, XSS 방어
import type { JiraAuthType, JiraConfig, AppSettings } from '../../shared/types';
import { DEFAULT_JIRA_WEBHOOK_PORT, JIRA_WEBHOOK_PATH_PREFIX } from '../../shared/constants';
import { renderJiraForm } from './settings-jira-form';

// ── 상태 ─────────────────────────────────────────────────────
let connections: JiraConfig[] = [];
let editingId: string | null = null;
let formOpen = false;
let dirty = false;

let webhookEnabled = false;
let webhookPort = DEFAULT_JIRA_WEBHOOK_PORT;
let webhookDirty = false;

// ── DOM ──────────────────────────────────────────────────────
const q = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`${sel} not found`);
  return el as T;
};

let listEl: HTMLUListElement;
let emptyEl: HTMLDivElement;
let formHost: HTMLDivElement;
let addBtn: HTMLButtonElement;
let webhookEnabledInput: HTMLInputElement;
let webhookPortInput: HTMLInputElement;
let webhookUrlEl: HTMLElement;
let webhookCopyBtn: HTMLButtonElement;
let webhookRegenBtn: HTMLButtonElement;
let webhookStatusBadge: HTMLSpanElement;
let webhookFeedbackEl: HTMLSpanElement;

// ── Public API ───────────────────────────────────────────────
export async function initJiraTab(initial: AppSettings): Promise<void> {
  listEl  = q<HTMLUListElement>('#jira-connection-list');
  emptyEl = q<HTMLDivElement>('#jira-connection-empty');
  formHost = q<HTMLDivElement>('#jira-form-host');
  addBtn = q<HTMLButtonElement>('#btn-add-jira-connection');
  webhookEnabledInput = q<HTMLInputElement>('#jira-webhook-enabled');
  webhookPortInput    = q<HTMLInputElement>('#jira-webhook-port');
  webhookUrlEl        = q<HTMLElement>('#jira-webhook-url');
  webhookCopyBtn      = q<HTMLButtonElement>('#btn-jira-webhook-copy');
  webhookRegenBtn     = q<HTMLButtonElement>('#btn-jira-webhook-regen');
  webhookStatusBadge  = q<HTMLSpanElement>('#jira-webhook-status-badge');
  webhookFeedbackEl   = q<HTMLSpanElement>('#jira-webhook-feedback');

  try {
    const r = await window.electronAPI.loadJiraConnections();
    connections = Array.isArray(r.jiraConnections) ? r.jiraConnections.slice() : [];
  } catch {
    connections = Array.isArray(initial.jiraConnections) ? initial.jiraConnections.slice() : [];
  }
  webhookEnabled = initial.jiraWebhookEnabled ?? false;
  webhookPort    = initial.jiraWebhookPort ?? DEFAULT_JIRA_WEBHOOK_PORT;
  dirty = false;
  webhookDirty = false;

  webhookEnabledInput.checked = webhookEnabled;
  webhookPortInput.value = String(webhookPort);
  renderList();

  try {
    webhookToken = await window.electronAPI.getJiraWebhookSecret();
  } catch {
    webhookToken = '';
  }
  renderWebhookUrl();

  addBtn.addEventListener('click', (): void => openForm(null));
  webhookEnabledInput.addEventListener('change', (): void => {
    webhookEnabled = webhookEnabledInput.checked;
    webhookDirty = true;
    renderWebhookUrl();
  });
  webhookPortInput.addEventListener('input', (): void => {
    const v = Number(webhookPortInput.value);
    if (Number.isFinite(v) && v >= 1024 && v <= 65535) {
      webhookPort = Math.trunc(v);
      webhookDirty = true;
      renderWebhookUrl();
    }
  });
  webhookCopyBtn.addEventListener('click', (): void => { void copyWebhookUrl(); });
  webhookRegenBtn.addEventListener('click', (): void => { void regenerateToken(); });
}

export function flushJiraPendingChanges(): {
  connections: JiraConfig[];
  webhookEnabled: boolean;
  webhookPort: number;
} {
  return { connections: connections.slice(), webhookEnabled, webhookPort };
}

export function hasUnsavedJiraChanges(): boolean {
  return dirty || formOpen || webhookDirty;
}

// ── 연결 카드 목록 ───────────────────────────────────────────
function renderList(): void {
  listEl.innerHTML = '';
  if (connections.length === 0) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  for (const c of connections) listEl.appendChild(renderCard(c));
}

function renderCard(c: JiraConfig): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'connection-card';
  li.dataset.id = c.id;

  const badge = document.createElement('span');
  badge.className = 'provider-badge is-jira';
  badge.textContent = 'JR';
  li.appendChild(badge);

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

  const actions = document.createElement('div');
  actions.className = 'connection-card-actions';
  actions.appendChild(ghostBtn('편집', (): void => openForm(c.id)));
  actions.appendChild(ghostBtn('삭제', (): void => removeConnection(c.id)));
  li.appendChild(actions);
  return li;
}

function ghostBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-ghost btn-sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function describeTitle(c: JiraConfig): string {
  const kind = c.authType === 'cloud' ? 'Cloud' : 'Server';
  if (c.label && c.label.trim()) return `Jira · ${kind} · ${c.label.trim()}`;
  return `Jira · ${kind} · ${safeHost(c.url)}`;
}

function describeMeta(c: JiraConfig): string {
  const keys = c.watchedProjectKeys.length ? c.watchedProjectKeys.join(', ') : '모든 프로젝트';
  const who = c.authType === 'cloud' && c.email ? `  ·  ${c.email}` : '';
  return `${c.url}${who}  ·  ${keys}`;
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function removeConnection(id: string): void {
  const c = connections.find(x => x.id === id);
  const label = c ? describeTitle(c) : '이 Jira 연결';
  if (!window.confirm(`${label}을(를) 삭제할까요?`)) return;
  connections = connections.filter(x => x.id !== id);
  dirty = true;
  if (editingId === id) closeForm();
  renderList();
}

// ── 편집 폼 ──────────────────────────────────────────────────
function openForm(id: string | null): void {
  editingId = id;
  formOpen = true;
  const existing = id ? connections.find(c => c.id === id) ?? null : null;
  mountForm(existing);
}

function mountForm(existing: JiraConfig | null): void {
  formHost.hidden = false;
  formHost.innerHTML = '';
  formHost.appendChild(renderJiraForm(existing, {
    onSubmit: (cfg: JiraConfig): void => {
      upsert(cfg);
      dirty = true;
      closeForm();
      renderList();
    },
    onCancel: closeForm,
    onAuthTypeChange: (_: JiraAuthType): void => {
      // 신규 추가 모드에서만 타입 전환 가능
      mountForm(null);
    },
  }));
}

function closeForm(): void {
  formOpen = false;
  editingId = null;
  formHost.innerHTML = '';
  formHost.hidden = true;
}

function upsert(cfg: JiraConfig): void {
  const idx = connections.findIndex(c => c.id === cfg.id);
  if (idx >= 0) connections[idx] = cfg;
  else connections.push(cfg);
}

// ── Webhook URL 표시/복사/재생성 ─────────────────────────────
// §20.13.C1: URL 포맷 `${JIRA_WEBHOOK_PATH_PREFIX}${token}`.
// token 은 JIRA_WEBHOOK_SECRET_GET / _REGENERATE IPC 로 조회.
let webhookToken = '';

function buildWebhookUrl(port: number): string {
  const suffix = webhookToken || '<토큰-미조회>';
  return `http://127.0.0.1:${port}${JIRA_WEBHOOK_PATH_PREFIX}${suffix}`;
}

function renderWebhookUrl(): void {
  webhookUrlEl.textContent = buildWebhookUrl(webhookPort);
  webhookCopyBtn.disabled = !webhookToken;
  renderWebhookStatusBadge();
}

function renderWebhookStatusBadge(): void {
  // §20.12.A 단순화 — settings.jiraWebhookEnabled 단일 bool 기반 2상태.
  // 실제 bind 실패/port busy 는 electron-log 에만 기록.
  if (webhookEnabled) {
    webhookStatusBadge.className = 'badge badge-success';
    webhookStatusBadge.textContent = '활성 (Webhook 수신 중)';
  } else {
    webhookStatusBadge.className = 'badge badge-muted';
    webhookStatusBadge.textContent = '비활성 (폴링만 사용)';
  }
}

async function copyWebhookUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(buildWebhookUrl(webhookPort));
    webhookFeedbackEl.className = 'action-feedback is-success';
    webhookFeedbackEl.textContent = '복사됨';
    webhookFeedbackEl.hidden = false;
    window.setTimeout((): void => { webhookFeedbackEl.hidden = true; }, 1800);
  } catch (err) {
    webhookFeedbackEl.className = 'action-feedback is-error';
    webhookFeedbackEl.textContent = `복사 실패: ${err instanceof Error ? err.message : String(err)}`;
    webhookFeedbackEl.hidden = false;
  }
}

async function regenerateToken(): Promise<void> {
  const ok = window.confirm(
    '토큰을 재생성하면 기존 URL 은 즉시 무효화되어 webhook 수신이 중단됩니다.\nAtlassian 대시보드의 webhook URL 을 반드시 새 값으로 재등록해 주세요.\n\n계속하시겠습니까?',
  );
  if (!ok) return;
  webhookRegenBtn.disabled = true;
  webhookFeedbackEl.className = 'action-feedback is-info';
  webhookFeedbackEl.textContent = '재생성 중…';
  webhookFeedbackEl.hidden = false;
  try {
    const next = await window.electronAPI.regenerateJiraWebhookSecret();
    webhookToken = next;
    renderWebhookUrl();
    webhookFeedbackEl.className = 'action-feedback is-success';
    webhookFeedbackEl.textContent = '토큰 재생성 완료. 새 URL 로 재등록하세요.';
    window.setTimeout((): void => { webhookFeedbackEl.hidden = true; }, 2500);
  } catch (err) {
    webhookFeedbackEl.className = 'action-feedback is-error';
    webhookFeedbackEl.textContent = `재생성 실패: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    webhookRegenBtn.disabled = false;
  }
}
