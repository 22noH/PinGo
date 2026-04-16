// settings.ts — Pingo 설정 윈도우 v2 엔트리
// 역할: 탭 전환 + 공통 푸터(폴링/알림) + 저장/취소 orchestration
// Git 탭은 settings-git.ts, AI 탭은 settings-ai.ts 에 위임
// strict mode — no `any`, no console.log
import type { AppSettings } from '../../shared/types';
import { initGitTab, flushGitPendingChanges, hasUnsavedGitChanges } from './settings-git';
import { initAITab, flushAIPendingChanges, hasUnsavedAIChanges } from './settings-ai';

// ── DOM 참조 ─────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const tabGit       = $<HTMLButtonElement>('tab-git');
const tabAi        = $<HTMLButtonElement>('tab-ai');
const panelGit     = $<HTMLElement>('panel-git');
const panelAi      = $<HTMLElement>('panel-ai');

const pollInput       = $<HTMLInputElement>('poll-interval');
const pollValue       = $<HTMLSpanElement>('poll-value');
const notifInput      = $<HTMLInputElement>('notification-enabled');
const startupInput    = $<HTMLInputElement>('launch-on-startup');

const saveBtn      = $<HTMLButtonElement>('btn-save');
const cancelBtn    = $<HTMLButtonElement>('btn-cancel');

// ── 탭 전환 ──────────────────────────────────────────────────
type TabName = 'git' | 'ai';

function switchTab(name: TabName): void {
  const gitActive = name === 'git';
  tabGit.classList.toggle('is-active', gitActive);
  tabAi.classList.toggle('is-active', !gitActive);
  tabGit.setAttribute('aria-selected', String(gitActive));
  tabAi.setAttribute('aria-selected', String(!gitActive));
  panelGit.classList.toggle('is-active', gitActive);
  panelAi.classList.toggle('is-active', !gitActive);
  panelGit.hidden = !gitActive;
  panelAi.hidden  = gitActive;
}

tabGit.addEventListener('click', (): void => switchTab('git'));
tabAi.addEventListener('click',  (): void => switchTab('ai'));

// ── 폴링 슬라이더 ────────────────────────────────────────────
function renderPollValue(sec: number): void {
  pollValue.textContent = sec >= 60
    ? `${Math.round(sec / 60 * 10) / 10}m`
    : `${sec}s`;
}

pollInput.addEventListener('input', (): void => {
  renderPollValue(Number(pollInput.value));
});

// ── 저장 ─────────────────────────────────────────────────────
async function save(): Promise<void> {
  const original = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span><span>저장 중…</span>';

  try {
    // Git 연결 저장
    const connections = flushGitPendingChanges();
    await window.electronAPI.saveGitConnections({ gitConnections: connections });

    // AI 설정 저장
    const ai = flushAIPendingChanges();
    await window.electronAPI.saveAIConfig({ ai });

    // 공통 설정 저장 (기존 저장된 settings 기반으로 덮어쓰기)
    const current = await window.electronAPI.loadSettings();
    const merged: AppSettings = {
      ...current.settings,
      gitConnections: connections,
      ai,
      pollIntervalMs: Number(pollInput.value) * 1000,
      notificationEnabled: notifInput.checked,
      launchOnStartup: startupInput.checked,
    };
    await window.electronAPI.saveSettings({ settings: merged });
    window.close();
  } catch (err) {
    saveBtn.disabled = false;
    saveBtn.innerHTML = original;
    const msg = err instanceof Error ? err.message : String(err);
    showSaveError(msg);
  }
}

function showSaveError(message: string): void {
  showInlineError('save-error', `저장 실패: ${message}`);
}

function showLoadError(message: string): void {
  showInlineError('load-error', message);
}

function showInlineError(id: string, message: string): void {
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement('div');
    box.id = id;
    box.className = 'status-line is-error';
    box.style.marginBottom = 'var(--space-2)';
    box.setAttribute('role', 'alert');
    saveBtn.parentElement?.insertBefore(box, saveBtn);
  }
  box.textContent = message;
}

saveBtn.addEventListener('click', (): void => { void save(); });
cancelBtn.addEventListener('click', (): void => {
  if (hasUnsavedGitChanges() || hasUnsavedAIChanges()) {
    const ok = window.confirm('저장하지 않은 변경 사항이 있습니다. 창을 닫을까요?');
    if (!ok) return;
  }
  window.close();
});

// 키보드 단축키
document.addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) {
    cancelBtn.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !saveBtn.disabled) {
    void save();
  }
  // 탭 전환 단축키 (Ctrl/Cmd + 1/2)
  if ((e.ctrlKey || e.metaKey) && (e.key === '1' || e.key === '2')) {
    e.preventDefault();
    switchTab(e.key === '1' ? 'git' : 'ai');
  }
});

// ── 초기 로드 ────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  try {
    const { settings } = await window.electronAPI.loadSettings();
    const sec = Math.max(10, Math.min(300, Math.round(settings.pollIntervalMs / 1000)));
    pollInput.value = String(sec);
    renderPollValue(sec);
    notifInput.checked   = settings.notificationEnabled;
    startupInput.checked = settings.launchOnStartup ?? false;

    await initGitTab(settings.gitConnections);
    initAITab(settings.ai);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showLoadError(`설정 로드 실패: ${msg}`);
    // 빈 값으로도 UI는 동작하도록 초기화
    await initGitTab([]);
    initAITab({ type: 'claude-cli' });
  }
}

void bootstrap();
