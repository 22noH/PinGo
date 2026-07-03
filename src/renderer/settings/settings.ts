// settings.ts — Pingo 설정 윈도우 v2 엔트리
// 역할: 탭 전환 + 공통 푸터(폴링/알림) + 저장/취소 orchestration
// Git 탭은 settings-git.ts, AI 탭은 settings-ai.ts 에 위임
// strict mode — no `any`, no console.log
import type { AppSettings } from '../../shared/types';
import { initGitTab, flushGitPendingChanges, hasUnsavedGitChanges } from './settings-git';
import { initAITab, flushAIPendingChanges, hasUnsavedAIChanges } from './settings-ai';
import { initJiraTab, flushJiraPendingChanges, hasUnsavedJiraChanges } from './settings-jira';
import { initProjectFiltersTab, flushProjectFiltersPendingChanges, hasUnsavedProjectFiltersChanges } from './settings-project-filters';

// ── DOM 참조 ─────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const tabGit       = $<HTMLButtonElement>('tab-git');
const tabAi        = $<HTMLButtonElement>('tab-ai');
const tabJira      = $<HTMLButtonElement>('tab-jira');
const tabFilters   = $<HTMLButtonElement>('tab-filters');
const panelGit     = $<HTMLElement>('panel-git');
const panelAi      = $<HTMLElement>('panel-ai');
const panelJira    = $<HTMLElement>('panel-jira');
const panelFilters = $<HTMLElement>('panel-filters');

const pollInput       = $<HTMLInputElement>('poll-interval');
const pollValue       = $<HTMLSpanElement>('poll-value');
const notifInput      = $<HTMLInputElement>('notification-enabled');
const commentNotifInput = $<HTMLInputElement>('comment-notifications-enabled');
const autoReviewInput = $<HTMLInputElement>('auto-review-enabled');
const startupInput    = $<HTMLInputElement>('launch-on-startup');
const hotkeyInput     = $<HTMLInputElement>('dashboard-hotkey');
const mergeDirInput   = $<HTMLInputElement>('merge-work-dir');

const saveBtn      = $<HTMLButtonElement>('btn-save');
const cancelBtn    = $<HTMLButtonElement>('btn-cancel');

// ── 탭 전환 ──────────────────────────────────────────────────
type TabName = 'git' | 'ai' | 'jira' | 'filters';

const tabMap: Record<TabName, { btn: HTMLButtonElement; panel: HTMLElement }> = {
  git:     { btn: tabGit,     panel: panelGit     },
  ai:      { btn: tabAi,      panel: panelAi      },
  jira:    { btn: tabJira,    panel: panelJira    },
  filters: { btn: tabFilters, panel: panelFilters },
};

function switchTab(name: TabName): void {
  for (const key of Object.keys(tabMap) as TabName[]) {
    const isActive = key === name;
    const { btn, panel } = tabMap[key];
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    panel.classList.toggle('is-active', isActive);
    panel.hidden = !isActive;
  }
}

tabGit.addEventListener('click',     (): void => switchTab('git'));
tabAi.addEventListener('click',      (): void => switchTab('ai'));
tabJira.addEventListener('click',    (): void => switchTab('jira'));
tabFilters.addEventListener('click', (): void => switchTab('filters'));

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

    // Jira 연결 저장
    const jira = flushJiraPendingChanges();
    await window.electronAPI.saveJiraConnections({ jiraConnections: jira.connections });

    // 프로젝트 필터 저장
    const projectFilters = flushProjectFiltersPendingChanges();
    await window.electronAPI.saveProjectFilters({ projectFilters });

    // 공통 설정 저장 (기존 저장된 settings 기반으로 덮어쓰기)
    const current = await window.electronAPI.loadSettings();
    const merged: AppSettings = {
      ...current.settings,
      gitConnections: connections,
      ai,
      pollIntervalMs: Number(pollInput.value) * 1000,
      notificationEnabled: notifInput.checked,
      commentNotificationsEnabled: commentNotifInput.checked,
      autoReviewEnabled: autoReviewInput.checked,
      launchOnStartup: startupInput.checked,
      dashboardHotkey: hotkeyInput.value.trim() || undefined,
      mergeWorkDir: mergeDirInput.value.trim() || undefined,
      jiraConnections: jira.connections,
      jiraWebhookEnabled: jira.webhookEnabled,
      jiraWebhookPort: jira.webhookPort,
      projectFilters,
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
  const anyDirty = hasUnsavedGitChanges()
    || hasUnsavedAIChanges()
    || hasUnsavedJiraChanges()
    || hasUnsavedProjectFiltersChanges();
  if (anyDirty) {
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
  // 탭 전환 단축키 (Ctrl/Cmd + 1~4)
  if ((e.ctrlKey || e.metaKey) && ['1','2','3','4'].includes(e.key)) {
    e.preventDefault();
    const order: TabName[] = ['git', 'ai', 'jira', 'filters'];
    const idx = Number(e.key) - 1;
    const target = order[idx];
    if (target) switchTab(target);
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
    commentNotifInput.checked = settings.commentNotificationsEnabled ?? true;
    autoReviewInput.checked = settings.autoReviewEnabled ?? false;
    startupInput.checked = settings.launchOnStartup ?? false;
    hotkeyInput.value    = settings.dashboardHotkey ?? 'CommandOrControl+Shift+D';
    mergeDirInput.value  = settings.mergeWorkDir ?? '';

    await initGitTab(settings.gitConnections);
    initAITab(settings.ai);
    await initJiraTab(settings);
    await initProjectFiltersTab(settings);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showLoadError(`설정 로드 실패: ${msg}`);
    // 빈 값으로도 UI는 동작하도록 초기화
    await initGitTab([]);
    initAITab({ type: 'claude-cli' });
    const fallback: AppSettings = {
      gitConnections: [],
      ai: { type: 'claude-cli' },
      pollIntervalMs: 30_000,
      notificationEnabled: true,
      commentNotificationsEnabled: true,
      launchOnStartup: false,
    };
    await initJiraTab(fallback);
    await initProjectFiltersTab(fallback);
  }
}

void bootstrap();
