// settings-jira-form.ts — Jira 연결 인라인 편집 폼
// Cloud(email+apiToken) / Server(apiToken) 전환, URL/라벨/프로젝트 키, 연결 테스트
// strict mode — no `any`, no console.log, XSS 방어 (textContent 우선)
import type { JiraConfig, JiraAuthType, JiraConnectionTestResult } from '../../shared/types';

export interface JiraFormCallbacks {
  onSubmit: (cfg: JiraConfig) => void;
  onCancel: () => void;
  onAuthTypeChange: (next: JiraAuthType) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: Array<HTMLElement | string>,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  }
  if (children) {
    for (const c of children) {
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return n;
}

function field(labelText: string, hintText?: string): {
  wrap: HTMLDivElement;
  labelEl: HTMLLabelElement;
  hintEl?: HTMLSpanElement;
} {
  const wrap = el('div', { class: 'field' });
  const labelEl = el('label', { class: 'field-label' });
  labelEl.textContent = labelText;
  wrap.appendChild(labelEl);
  let hintEl: HTMLSpanElement | undefined;
  if (hintText) {
    hintEl = el('span', { class: 'field-hint' });
    hintEl.textContent = hintText;
  }
  return { wrap, labelEl, hintEl };
}

function passwordInput(id: string, value: string, placeholder: string): HTMLDivElement {
  const group = el('div', { class: 'input-group' });
  const input = el('input', {
    id,
    class: 'input',
    type: 'password',
    placeholder,
    autocomplete: 'new-password',
  }) as HTMLInputElement;
  input.value = value;
  const toggle = el('button', { type: 'button', class: 'input-icon-btn', 'aria-label': '토큰 보기' });
  toggle.textContent = '\u{1F441}';
  toggle.addEventListener('click', (): void => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  group.appendChild(input);
  group.appendChild(toggle);
  return group;
}

function parseKeys(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s.length > 0 && /^[A-Z][A-Z0-9_]+$/.test(s));
}

export function renderJiraForm(
  existing: JiraConfig | null,
  callbacks: JiraFormCallbacks,
): HTMLDivElement {
  const authType: JiraAuthType = existing?.authType ?? 'cloud';
  const root = el('div', { class: 'inline-form', role: 'form', 'aria-label': 'Jira 연결 편집' });

  const title = el('div', { class: 'inline-form-title' });
  title.textContent = existing ? 'Jira 연결 편집' : 'Jira 연결 추가';
  root.appendChild(title);

  // ── 인증 방식 (Cloud / Server) ───────────────────────────
  const typeField = field('인증 방식', 'Cloud: email + API Token / Server: Personal Access Token');
  const typeSelect = el('select', { id: 'jira-auth-type', class: 'select' }) as HTMLSelectElement;
  const optCloud = el('option', { value: 'cloud' }); optCloud.textContent = 'Jira Cloud (Atlassian)';
  const optServer = el('option', { value: 'server' }); optServer.textContent = 'Jira Server / Data Center';
  typeSelect.appendChild(optCloud);
  typeSelect.appendChild(optServer);
  typeSelect.value = authType;
  typeSelect.disabled = existing !== null;
  typeSelect.addEventListener('change', (): void => {
    if (typeSelect.value === 'cloud' || typeSelect.value === 'server') {
      callbacks.onAuthTypeChange(typeSelect.value);
    }
  });
  typeField.wrap.appendChild(typeSelect);
  if (typeField.hintEl) typeField.wrap.appendChild(typeField.hintEl);
  root.appendChild(typeField.wrap);

  // ── URL ──────────────────────────────────────────────────
  const urlField = field(
    'Jira URL',
    authType === 'cloud' ? 'https://{site}.atlassian.net' : 'https://jira.example.com',
  );
  const urlInput = el('input', {
    id: 'jira-url',
    class: 'input',
    type: 'url',
    placeholder: authType === 'cloud' ? 'https://myorg.atlassian.net' : 'https://jira.example.com',
    autocomplete: 'off',
  }) as HTMLInputElement;
  urlInput.value = existing?.url ?? '';
  urlField.wrap.appendChild(urlInput);
  if (urlField.hintEl) urlField.wrap.appendChild(urlField.hintEl);
  root.appendChild(urlField.wrap);

  // ── Email (Cloud 전용) ───────────────────────────────────
  const emailField = field('이메일 (Cloud Atlassian 계정)');
  const emailInput = el('input', {
    id: 'jira-email',
    class: 'input',
    type: 'email',
    placeholder: 'you@example.com',
    autocomplete: 'email',
  }) as HTMLInputElement;
  emailInput.value = existing?.email ?? '';
  emailField.wrap.appendChild(emailInput);
  if (authType !== 'cloud') emailField.wrap.hidden = true;
  root.appendChild(emailField.wrap);

  // ── API Token / PAT ──────────────────────────────────────
  const tokenField = field(
    authType === 'cloud' ? 'API Token' : 'Personal Access Token (PAT)',
    authType === 'cloud'
      ? 'id.atlassian.com/manage-profile/security/api-tokens 에서 발급'
      : 'Jira → 프로필 → Personal Access Tokens 에서 발급',
  );
  tokenField.wrap.appendChild(passwordInput('jira-token', existing?.apiToken ?? '', '●●●●●●●●●●'));
  if (tokenField.hintEl) tokenField.wrap.appendChild(tokenField.hintEl);
  root.appendChild(tokenField.wrap);

  // ── 프로젝트 키 목록 ─────────────────────────────────────
  const keysField = field(
    '감시 프로젝트 키',
    '쉼표 또는 공백으로 구분 (예: PROJ, OPS). 비워두면 모든 프로젝트',
  );
  const keysInput = el('input', {
    id: 'jira-keys',
    class: 'input',
    type: 'text',
    placeholder: 'PROJ, OPS',
    autocomplete: 'off',
  }) as HTMLInputElement;
  keysInput.value = (existing?.watchedProjectKeys ?? []).join(', ');
  keysField.wrap.appendChild(keysInput);
  if (keysField.hintEl) keysField.wrap.appendChild(keysField.hintEl);
  root.appendChild(keysField.wrap);

  // ── 라벨 ─────────────────────────────────────────────────
  const labelField = field('표시 이름 (선택)', '트레이/설정에서 보일 별칭. 없으면 URL 자동 사용');
  const labelInput = el('input', {
    id: 'jira-label',
    class: 'input',
    type: 'text',
    placeholder: '예: 회사 Jira',
    autocomplete: 'off',
    maxlength: '40',
  }) as HTMLInputElement;
  labelInput.value = existing?.label ?? '';
  labelField.wrap.appendChild(labelInput);
  if (labelField.hintEl) labelField.wrap.appendChild(labelField.hintEl);
  root.appendChild(labelField.wrap);

  // ── 연결 테스트 ──────────────────────────────────────────
  const testRow = el('div', { class: 'row' });
  const testBtn = el('button', { type: 'button', class: 'btn btn-secondary' }) as HTMLButtonElement;
  testBtn.textContent = '연결 테스트';
  const testResult = el('span', { class: 'status-line', hidden: 'hidden' }) as HTMLSpanElement;
  testRow.appendChild(testBtn);
  testRow.appendChild(testResult);
  root.appendChild(testRow);

  testBtn.addEventListener('click', (): void => {
    void runTest();
  });

  async function runTest(): Promise<void> {
    const cfg = collect(true);
    if (!cfg) return;
    testBtn.disabled = true;
    testResult.hidden = false;
    testResult.className = 'status-line is-loading';
    testResult.textContent = '확인 중…';
    try {
      const r: JiraConnectionTestResult = await window.electronAPI.testJiraConnection({ config: cfg });
      if (r.success) {
        testResult.className = 'status-line is-success';
        testResult.textContent = `성공 · ${r.displayName ?? r.accountId ?? '연결 확인됨'}`;
      } else {
        testResult.className = 'status-line is-error';
        testResult.textContent = `실패: ${r.error ?? '알 수 없는 오류'}`;
      }
    } catch (err) {
      testResult.className = 'status-line is-error';
      testResult.textContent = `실패: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      testBtn.disabled = false;
    }
  }

  // ── 저장/취소 ────────────────────────────────────────────
  const actions = el('div', { class: 'inline-form-actions' });
  const cancelBtn = el('button', { type: 'button', class: 'btn btn-ghost' }) as HTMLButtonElement;
  cancelBtn.textContent = '취소';
  cancelBtn.addEventListener('click', callbacks.onCancel);
  const submitBtn = el('button', { type: 'button', class: 'btn btn-jira' }) as HTMLButtonElement;
  submitBtn.textContent = existing ? '변경 저장' : '추가';
  submitBtn.addEventListener('click', (): void => {
    const cfg = collect(false);
    if (cfg) callbacks.onSubmit(cfg);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  root.appendChild(actions);

  // ── 유효성 검사 + 수집 ──────────────────────────────────
  function collect(isTest: boolean): JiraConfig | null {
    const url = urlInput.value.trim();
    const token = (root.querySelector('#jira-token') as HTMLInputElement).value.trim();
    const email = emailInput.value.trim();
    const keys = parseKeys(keysInput.value);
    const label = labelInput.value.trim();

    urlInput.removeAttribute('aria-invalid');
    emailInput.removeAttribute('aria-invalid');
    (root.querySelector('#jira-token') as HTMLInputElement).removeAttribute('aria-invalid');

    if (!url || !/^https?:\/\//.test(url)) {
      urlInput.setAttribute('aria-invalid', 'true');
      urlInput.focus();
      return null;
    }
    if (authType === 'cloud' && !email) {
      emailInput.setAttribute('aria-invalid', 'true');
      emailInput.focus();
      return null;
    }
    if (!token) {
      const t = root.querySelector('#jira-token') as HTMLInputElement;
      t.setAttribute('aria-invalid', 'true');
      t.focus();
      return null;
    }
    if (isTest) {
      // 테스트 시에는 임시 id 허용 (실제 저장 안 함)
    }
    return {
      type: 'jira',
      id: existing?.id ?? crypto.randomUUID(),
      label: label || undefined,
      authType,
      url,
      email: authType === 'cloud' ? email : undefined,
      apiToken: token,
      watchedProjectKeys: keys,
    };
  }

  return root;
}
