// settings.ts — Pingo 설정 윈도우 로직
// strict mode: no any, no console.log (renderer는 alert/UI만)
// window.electronAPI 타입은 renderer/global.d.ts에서 선언
import type { AppSettings, ConnectionTestResult } from '../../shared/types';

// ── DOM 참조 ─────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const urlInput      = $<HTMLInputElement>('gitlab-url');
const tokenInput    = $<HTMLInputElement>('token');
const userIdInput   = $<HTMLInputElement>('user-id');
const pollInput     = $<HTMLInputElement>('poll-interval');
const pollValue     = $<HTMLSpanElement>('poll-value');
const notifInput    = $<HTMLInputElement>('notification-enabled');
const toggleTokenBtn = $<HTMLButtonElement>('toggle-token');
const iconEye       = $<SVGElement>('icon-eye');
const iconEyeOff    = $<SVGElement>('icon-eye-off');
const testBtn       = $<HTMLButtonElement>('btn-test');
const testIcon      = $<HTMLSpanElement>('test-icon');
const testResult    = $<HTMLSpanElement>('test-result');
const saveBtn       = $<HTMLButtonElement>('btn-save');
const cancelBtn     = $<HTMLButtonElement>('btn-cancel');

const errUrl    = $<HTMLSpanElement>('err-gitlab-url');
const errToken  = $<HTMLSpanElement>('err-token');
const errUserId = $<HTMLSpanElement>('err-user-id');

// ── 유효성 검사 ──────────────────────────────────────────────
interface ValidationErrors {
  gitlabUrl?: string;
  token?: string;
  userId?: string;
}

function validate(): ValidationErrors {
  const errs: ValidationErrors = {};
  const url = urlInput.value.trim();
  if (!url) errs.gitlabUrl = 'URL이 필요합니다';
  else {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) errs.gitlabUrl = 'http 또는 https만 허용';
    } catch {
      errs.gitlabUrl = '유효하지 않은 URL';
    }
  }
  if (!tokenInput.value.trim()) errs.token = 'Token이 필요합니다';
  const uid = Number(userIdInput.value);
  if (!Number.isInteger(uid) || uid <= 0) errs.userId = '양의 정수여야 합니다';
  return errs;
}

function renderErrors(errs: ValidationErrors): void {
  const apply = (span: HTMLSpanElement, input: HTMLInputElement, msg?: string): void => {
    if (msg) {
      span.textContent = msg;
      span.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      span.hidden = true;
      span.textContent = '';
      input.removeAttribute('aria-invalid');
    }
  };
  apply(errUrl, urlInput, errs.gitlabUrl);
  apply(errToken, tokenInput, errs.token);
  apply(errUserId, userIdInput, errs.userId);
}

function refreshSaveButton(): void {
  const errs = validate();
  saveBtn.disabled = Object.keys(errs).length > 0;
}

// ── 입력 이벤트 ──────────────────────────────────────────────
const onInput = (): void => {
  renderErrors({});        // 타이핑 중에는 에러 클리어
  refreshSaveButton();
  // 설정 변경 시 이전 테스트 결과 무효화
  testResult.hidden = true;
  testResult.className = 'status-line';
  testResult.textContent = '';
};
[urlInput, tokenInput, userIdInput, notifInput].forEach(el => {
  el.addEventListener('input', onInput);
});

pollInput.addEventListener('input', (): void => {
  const sec = Number(pollInput.value);
  pollValue.textContent = sec >= 60 ? `${Math.round(sec / 60 * 10) / 10}m` : `${sec}s`;
});

// 토큰 표시/숨김
toggleTokenBtn.addEventListener('click', (): void => {
  const show = tokenInput.type === 'password';
  tokenInput.type = show ? 'text' : 'password';
  iconEye.toggleAttribute('hidden', show);
  iconEyeOff.toggleAttribute('hidden', !show);
});

// ── 연결 테스트 ──────────────────────────────────────────────
async function runConnectionTest(): Promise<void> {
  const errs = validate();
  if (errs.gitlabUrl || errs.token) {
    renderErrors(errs);
    return;
  }

  // 로딩 상태
  testBtn.disabled = true;
  testResult.hidden = false;
  testResult.className = 'status-line is-loading';
  testResult.innerHTML = '<span class="spinner"></span><span>테스트 중…</span>';

  // 설정을 먼저 임시 저장 (testConnection은 저장된 설정 기준)
  // 설계상 main의 testConnection은 현재 store의 settings를 읽음.
  // UX상 "입력 중인 값"으로 테스트하려면 저장 후 호출. 저장 버튼과 구분 위해
  // 이전 값을 백업하고 임시 저장 → 테스트 → 원복하지 않음(사용자가 저장 흐름으로 이어지는 걸로 간주)
  const tempSettings: AppSettings = {
    gitlabUrl: urlInput.value.trim(),
    token: tokenInput.value.trim(),
    userId: Number(userIdInput.value) || 0,
    pollIntervalMs: Number(pollInput.value) * 1000,
    notificationEnabled: notifInput.checked,
  };

  try {
    await window.electronAPI.saveSettings({ settings: tempSettings });
    const result: ConnectionTestResult = await window.electronAPI.testConnection();
    if (result.success) {
      testResult.className = 'status-line is-success';
      const uid = result.userId;
      testResult.innerHTML = `
        <span class="dot is-active"></span>
        <span>연결 성공${uid ? ` · User ID: <strong>${uid}</strong>` : ''}</span>
      `;
      // userId를 자동으로 채워주기 (사용자가 비워뒀거나 틀렸을 경우)
      if (uid && (userIdInput.value === '' || Number(userIdInput.value) !== uid)) {
        userIdInput.value = String(uid);
        refreshSaveButton();
      }
    } else {
      testResult.className = 'status-line is-error';
      testResult.innerHTML = `
        <span class="dot is-error"></span>
        <span>실패: ${escapeHtml(result.error ?? '알 수 없는 오류')}</span>
      `;
    }
  } catch (err) {
    testResult.className = 'status-line is-error';
    const msg = err instanceof Error ? err.message : String(err);
    testResult.innerHTML = `
      <span class="dot is-error"></span>
      <span>IPC 오류: ${escapeHtml(msg)}</span>
    `;
  } finally {
    testBtn.disabled = false;
    testIcon.hidden = false;
  }
}
testBtn.addEventListener('click', (): void => {
  void runConnectionTest();
});

// ── 저장/취소 ────────────────────────────────────────────────
async function save(): Promise<void> {
  const errs = validate();
  renderErrors(errs);
  if (Object.keys(errs).length > 0) return;
  const settings: AppSettings = {
    gitlabUrl: urlInput.value.trim(),
    token: tokenInput.value.trim(),
    userId: Number(userIdInput.value),
    pollIntervalMs: Number(pollInput.value) * 1000,
    notificationEnabled: notifInput.checked,
  };
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span><span>저장 중…</span>';
  try {
    await window.electronAPI.saveSettings({ settings });
    window.close();
  } catch (err) {
    saveBtn.disabled = false;
    saveBtn.textContent = '저장';
    testResult.hidden = false;
    testResult.className = 'status-line is-error';
    const msg = err instanceof Error ? err.message : String(err);
    testResult.innerHTML = `<span class="dot is-error"></span><span>저장 실패: ${escapeHtml(msg)}</span>`;
  }
}
saveBtn.addEventListener('click', (): void => { void save(); });
cancelBtn.addEventListener('click', (): void => window.close());

// ── 초기 로드 ────────────────────────────────────────────────
async function load(): Promise<void> {
  try {
    const { settings } = await window.electronAPI.loadSettings();
    urlInput.value      = settings.gitlabUrl;
    tokenInput.value    = settings.token;
    userIdInput.value   = settings.userId > 0 ? String(settings.userId) : '';
    const sec           = Math.max(10, Math.round(settings.pollIntervalMs / 1000));
    pollInput.value     = String(Math.min(300, sec));
    pollValue.textContent = sec >= 60 ? `${Math.round(sec / 60 * 10) / 10}m` : `${sec}s`;
    notifInput.checked  = settings.notificationEnabled;
    refreshSaveButton();
  } catch (err) {
    renderErrors({ gitlabUrl: '설정 로드 실패 — 기본값 사용' });
  }
}

// 키보드 단축키
document.addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.key === 'Escape') window.close();
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !saveBtn.disabled) void save();
});

// ── 유틸 ─────────────────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}

// 진입점
void load();
