// settings-git-form.ts — Git 연결 인라인 편집 폼 (렌더/검증/테스트)
// settings-git.ts 에서 분리 (300줄 제한)
// strict mode — no `any`, no console.log
import type {
  GitConfig,
  GitLabConfig,
  GitHubConfig,
  GitProviderType,
  GitConnectionTestResult,
} from '../../shared/types';
import { PROVIDER_DISPLAY_NAME } from '../../shared/constants';

export interface FormCallbacks {
  onSubmit: (cfg: GitConfig) => void;
  onCancel: () => void;
  onTypeChange: (type: GitProviderType) => void;
}

export function renderForm(
  type: GitProviderType,
  existing: GitConfig | null,
  cb: FormCallbacks,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'inline-form';

  const title = document.createElement('div');
  title.className = 'inline-form-title';
  title.textContent = existing ? '연결 편집' : '새 서비스 추가';
  root.appendChild(title);

  // 서비스 타입 선택 (편집 중이면 비활성화)
  root.appendChild(makeField('서비스', (): HTMLElement => {
    const sel = document.createElement('select');
    sel.className = 'select';
    sel.id = 'form-type';
    sel.disabled = existing !== null;
    for (const t of ['gitlab', 'github'] as const) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = PROVIDER_DISPLAY_NAME[t];
      if (t === type) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', (): void => {
      const next = (sel.value === 'github' ? 'github' : 'gitlab') as GitProviderType;
      cb.onTypeChange(next);
    });
    return sel;
  }));

  // 타입별 필드
  const fields = document.createElement('div');
  fields.className = 'col';
  fields.style.gap = 'var(--space-4)';
  if (type === 'gitlab') {
    renderGitLabFields(fields, existing?.type === 'gitlab' ? existing : null);
  } else {
    renderGitHubFields(fields, existing?.type === 'github' ? existing : null);
  }
  root.appendChild(fields);

  // 테스트 버튼
  const testRow = document.createElement('div');
  testRow.className = 'field';
  const testWrap = document.createElement('div');
  testWrap.className = 'row';
  testWrap.style.gap = 'var(--space-3)';
  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn-secondary';
  testBtn.textContent = '연결 테스트';
  const testResult = document.createElement('span');
  testResult.className = 'status-line';
  testResult.hidden = true;
  testWrap.appendChild(testBtn);
  testWrap.appendChild(testResult);
  testRow.appendChild(testWrap);
  root.appendChild(testRow);

  testBtn.addEventListener('click', (): void => {
    const cfg = buildConfigFromForm(existing?.id);
    if (!cfg) { showStatus(testResult, 'error', '필드를 모두 채워주세요.'); return; }
    void runTest(cfg, testBtn, testResult);
  });

  // 저장/취소
  const actions = document.createElement('div');
  actions.className = 'inline-form-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('click', cb.onCancel);
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = existing ? '변경 적용' : '추가';
  saveBtn.addEventListener('click', (): void => {
    const cfg = buildConfigFromForm(existing?.id);
    if (!cfg) { showStatus(testResult, 'error', '필드를 모두 채워주세요.'); return; }
    cb.onSubmit(cfg);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  root.appendChild(actions);

  return root;
}

function renderGitLabFields(host: HTMLElement, existing: GitLabConfig | null): void {
  host.appendChild(makeInputField('URL', 'form-url', 'url',
    existing?.url ?? '', 'https://gitlab.example.com'));
  host.appendChild(makeTokenField('form-token', existing?.token ?? '',
    'glpat-xxxxxxxxxxxxxxxxxxxx'));
  host.appendChild(makeInputField('User ID', 'form-user-id', 'number',
    existing && existing.userId > 0 ? String(existing.userId) : '', '123',
    '연결 테스트로 자동 입력'));
  host.appendChild(makeInputField('라벨 (선택)', 'form-label', 'text',
    existing?.label ?? '', '예: 사내 GitLab'));
}

function renderGitHubFields(host: HTMLElement, existing: GitHubConfig | null): void {
  host.appendChild(makeTokenField('form-token', existing?.token ?? '',
    'ghp_xxxxxxxxxxxxxxxxxxxx'));
  host.appendChild(makeInputField('Username', 'form-username', 'text',
    existing?.username ?? '', 'myhandle', 'review_requested / assignee 필터에 사용'));
  host.appendChild(makeInputField('라벨 (선택)', 'form-label', 'text',
    existing?.label ?? '', '예: 회사 GitHub'));
}

function makeField(label: string, buildControl: () => HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lbl = document.createElement('label');
  lbl.className = 'field-label';
  lbl.textContent = label;
  const ctrl = buildControl();
  if (ctrl instanceof HTMLElement && ctrl.id) lbl.htmlFor = ctrl.id;
  wrap.appendChild(lbl);
  wrap.appendChild(ctrl);
  return wrap;
}

function makeInputField(
  label: string, id: string, type: string, value: string,
  placeholder: string, hint?: string,
): HTMLElement {
  return makeField(label, (): HTMLElement => {
    const wrap = document.createElement('div');
    const input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    wrap.appendChild(input);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'field-hint';
      h.textContent = hint;
      h.style.display = 'block';
      h.style.marginTop = '4px';
      wrap.appendChild(h);
    }
    return wrap;
  });
}

function makeTokenField(id: string, value: string, placeholder: string): HTMLElement {
  return makeField('Token', (): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'input-group';
    const input = document.createElement('input');
    input.className = 'input';
    input.id = id;
    input.type = 'password';
    input.value = value;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    group.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'input-icon-btn';
    btn.setAttribute('aria-label', '토큰 표시 전환');
    btn.title = '표시/숨김';
    btn.textContent = '👁';
    btn.addEventListener('click', (): void => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    group.appendChild(btn);
    return group;
  });
}

function getVal(id: string): string {
  const el = document.getElementById(id);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value.trim();
  return '';
}

export function buildConfigFromForm(existingId: string | undefined): GitConfig | null {
  const type = (getVal('form-type') === 'github' ? 'github' : 'gitlab') as GitProviderType;
  const id = existingId ?? generateId();
  const label = getVal('form-label') || undefined;
  const token = getVal('form-token');
  if (!token) return null;
  if (type === 'gitlab') {
    const url = getVal('form-url');
    const userIdStr = getVal('form-user-id');
    const userId = Number(userIdStr);
    if (!url) return null;
    return {
      type: 'gitlab', id, label, url, token,
      userId: Number.isInteger(userId) && userId > 0 ? userId : 0,
    };
  }
  const username = getVal('form-username');
  if (!username) return null;
  return { type: 'github', id, label, token, username };
}

function generateId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cfg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function runTest(
  cfg: GitConfig, btn: HTMLButtonElement, out: HTMLSpanElement,
): Promise<void> {
  btn.disabled = true;
  showStatus(out, 'loading', '테스트 중…');
  try {
    const r: GitConnectionTestResult = await window.electronAPI.testGitConnection({ config: cfg });
    if (r.success) {
      if (cfg.type === 'gitlab' && r.userId) {
        const uidInput = document.getElementById('form-user-id');
        if (uidInput instanceof HTMLInputElement && !uidInput.value) {
          uidInput.value = String(r.userId);
        }
      }
      if (cfg.type === 'github' && r.username) {
        const unInput = document.getElementById('form-username');
        if (unInput instanceof HTMLInputElement && !unInput.value) unInput.value = r.username;
      }
      const detail = cfg.type === 'gitlab' && r.userId
        ? ` · User ID ${r.userId}`
        : r.username ? ` · @${r.username}` : '';
      showStatus(out, 'success', `연결 성공${detail}`);
    } else {
      showStatus(out, 'error', r.error ?? '알 수 없는 오류');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showStatus(out, 'error', `IPC 오류: ${msg}`);
  } finally {
    btn.disabled = false;
  }
}

function showStatus(el: HTMLSpanElement, kind: 'success' | 'error' | 'loading', text: string): void {
  el.hidden = false;
  el.className = `status-line is-${kind}`;
  el.innerHTML = '';
  if (kind === 'loading') {
    const s = document.createElement('span');
    s.className = 'spinner';
    el.appendChild(s);
  } else {
    const dot = document.createElement('span');
    dot.className = `dot is-${kind === 'success' ? 'active' : 'error'}`;
    el.appendChild(dot);
  }
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
}
