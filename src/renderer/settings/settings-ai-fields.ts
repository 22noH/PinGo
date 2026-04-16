// settings-ai-fields.ts — [AI] 탭용 폼 빌더 + Ollama 모델 동적 로드
// settings-ai.ts 에서 분리 (300줄 제한)
// strict mode — no `any`, no console.log, textContent 기반 XSS 방지
import type { OllamaModelsFetchResult } from '../../shared/types';

export function makeField(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const l = document.createElement('label');
  l.className = 'field-label';
  l.textContent = label;
  if (control.id) l.htmlFor = control.id;
  wrap.appendChild(l);
  wrap.appendChild(control);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'field-hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

export function makeInput(
  label: string, id: string, type: string, value: string,
  placeholder: string, hint?: string,
): HTMLElement {
  const input = document.createElement('input');
  input.className = 'input';
  input.id = id;
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  return makeField(label, input, hint);
}

export function makeTokenField(id: string, value: string, placeholder: string): HTMLElement {
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
  return makeField('API Key', group);
}

export function makeModelSelect(
  id: string, value: string, models: string[], label: string,
): HTMLElement {
  const sel = document.createElement('select');
  sel.id = id;
  sel.className = 'select';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return makeField(label, sel);
}

/** Ollama 모델 드롭다운 (초기 로딩 상태 포함) 렌더 */
export function makeOllamaModelField(): HTMLElement {
  const modelField = document.createElement('div');
  modelField.className = 'field';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = 'ai-model';
  label.textContent = '모델';
  modelField.appendChild(label);

  const select = document.createElement('select');
  select.id = 'ai-model';
  select.className = 'select';
  select.disabled = true;
  const loadingOpt = document.createElement('option');
  loadingOpt.textContent = '불러오는 중…';
  select.appendChild(loadingOpt);
  modelField.appendChild(select);

  const hint = document.createElement('span');
  hint.className = 'field-hint';
  hint.textContent = 'Base URL 변경 후 "연결 테스트"로 모델 목록 재조회';
  modelField.appendChild(hint);
  return modelField;
}

export async function loadOllamaModels(
  host: HTMLElement, baseUrl: string, preferred?: string,
): Promise<void> {
  try {
    const r: OllamaModelsFetchResult = await window.electronAPI.fetchOllamaModels({ baseUrl });
    const sel = host.querySelector<HTMLSelectElement>('#ai-model');
    if (!sel) return;
    sel.innerHTML = '';
    sel.disabled = false;
    const models = r.success && r.models ? r.models : [];
    if (models.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = r.error ? `오류: ${r.error}` : '설치된 모델 없음';
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === preferred) opt.selected = true;
      sel.appendChild(opt);
    }
  } catch (err) {
    const sel = host.querySelector<HTMLSelectElement>('#ai-model');
    if (!sel) return;
    sel.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = err instanceof Error ? err.message : String(err);
    opt.disabled = true;
    sel.appendChild(opt);
  }
}

export function showStatus(
  el: HTMLSpanElement, kind: 'success' | 'error' | 'loading', text: string,
): void {
  el.hidden = false;
  el.className = `status-line is-${kind}`;
  el.innerHTML = '';
  if (kind === 'loading') {
    const s = document.createElement('span'); s.className = 'spinner';
    el.appendChild(s);
  } else {
    const d = document.createElement('span');
    d.className = `dot is-${kind === 'success' ? 'active' : 'error'}`;
    el.appendChild(d);
  }
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
}
