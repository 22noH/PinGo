// settings-project-filters.ts — [프로젝트 필터] 탭 로직
// 로드된 ProjectFilter[] + 현재 Git/Jira 연결에서 파생된 projectKey 목록을
// 체크박스로 묶어 뮤트 상태를 편집한다.
// strict mode — no `any`, no console.log, XSS 방어
import type {
  AppSettings,
  GitConfig,
  JiraConfig,
  ProjectFilter,
  ReviewItemSummary,
} from '../../shared/types';
import { PROVIDER_SHORT_LABEL } from '../../shared/constants';

/** projectKey → 내부 표현. 3-part 합성키 */
interface FilterRow {
  projectKey: string;
  displayLabel: string;
  namespace: 'git' | 'jira';
  muted: boolean;
}

/**
 * §20.12.E / §20.13.I3 — 3-part projectKey 판별.
 * Git:  `${gitConfigId}::${providerType}::${projectId}`
 * Jira: `${jiraConfigId}::jira::${projectKey}` (중간 segment 고정값 'jira')
 */
export function isJiraFilterKey(projectKey: string): boolean {
  return projectKey.split('::')[1] === 'jira';
}

// ── 상태 ─────────────────────────────────────────────────────
let rows: FilterRow[] = [];
let originalMuted: Record<string, boolean> = {};
let dirty = false;

// ── DOM ──────────────────────────────────────────────────────
let hostEl: HTMLDivElement;

const q = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`${sel} not found`);
  return el as T;
};

// ── Public API ───────────────────────────────────────────────
export async function initProjectFiltersTab(initial: AppSettings): Promise<void> {
  hostEl = q<HTMLDivElement>('#filters-host');
  let storedFilters: ProjectFilter[] = Array.isArray(initial.projectFilters)
    ? initial.projectFilters.slice()
    : [];
  try {
    const r = await window.electronAPI.loadProjectFilters();
    if (Array.isArray(r.projectFilters)) storedFilters = r.projectFilters.slice();
  } catch {
    // fallthrough: initial.projectFilters 사용
  }

  const mutedMap = buildMutedMap(storedFilters);
  const gitRows = await collectGitProjectRows(initial.gitConnections, mutedMap);
  const jiraRows = collectJiraProjectRows(initial.jiraConnections ?? [], mutedMap);

  // 저장은 되어 있으나 현재 연결에서 파생되지 않는 키도 유지(고스트 행).
  const covered = new Set<string>([...gitRows, ...jiraRows].map(r => r.projectKey));
  const ghost: FilterRow[] = storedFilters
    .filter(f => !covered.has(f.projectKey))
    .map(f => ({
      projectKey: f.projectKey,
      displayLabel: f.projectKey,
      namespace: isJiraFilterKey(f.projectKey) ? 'jira' : 'git',
      muted: f.muted,
    }));

  rows = [...gitRows, ...jiraRows, ...ghost];
  originalMuted = Object.fromEntries(rows.map(r => [r.projectKey, r.muted]));
  dirty = false;
  render();
}

export function flushProjectFiltersPendingChanges(): ProjectFilter[] {
  return rows.map(r => ({
    projectKey: r.projectKey,
    displayLabel: r.displayLabel || undefined,
    muted: r.muted,
  }));
}

export function hasUnsavedProjectFiltersChanges(): boolean {
  return dirty;
}

// ── 수집 ─────────────────────────────────────────────────────
function buildMutedMap(list: ProjectFilter[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const f of list) m.set(f.projectKey, f.muted);
  return m;
}

async function collectGitProjectRows(
  gits: GitConfig[],
  mutedMap: Map<string, boolean>,
): Promise<FilterRow[]> {
  const seen = new Set<string>();
  const out: FilterRow[] = [];
  try {
    const r = await window.electronAPI.loadList();
    if (Array.isArray(r.items)) {
      for (const item of r.items) out.push(gitRowFromItem(item, gits, mutedMap, seen));
    }
  } catch {
    // loadList 실패해도 빈 배열로 계속
  }
  return out.filter((v): v is FilterRow => v !== null);
}

function gitRowFromItem(
  item: ReviewItemSummary,
  gits: GitConfig[],
  mutedMap: Map<string, boolean>,
  seen: Set<string>,
): FilterRow {
  const key = `${item.gitConfigId}::${item.providerType}::${item.projectId}`;
  if (seen.has(key)) return { projectKey: key, displayLabel: '', namespace: 'git', muted: false };
  seen.add(key);
  const cfg = gits.find(g => g.id === item.gitConfigId);
  const connLabel = cfg?.label?.trim() || (cfg?.type === 'gitlab' ? safeHost(cfg.url) : 'GitHub');
  const provShort = PROVIDER_SHORT_LABEL[item.providerType];
  const label = item.repoFullName ?? `#${item.projectId}`;
  return {
    projectKey: key,
    displayLabel: `[${provShort}] ${connLabel} · ${label}`,
    namespace: 'git',
    muted: mutedMap.get(key) ?? false,
  };
}

function collectJiraProjectRows(
  jiras: JiraConfig[],
  mutedMap: Map<string, boolean>,
): FilterRow[] {
  const out: FilterRow[] = [];
  for (const j of jiras) {
    const keys = j.watchedProjectKeys.length > 0 ? j.watchedProjectKeys : [];
    for (const k of keys) {
      const composite = `${j.id}::jira::${k}`;
      out.push({
        projectKey: composite,
        displayLabel: `[JR] ${j.label?.trim() || safeHost(j.url)} · ${k}`,
        namespace: 'jira',
        muted: mutedMap.get(composite) ?? false,
      });
    }
  }
  return out;
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

// ── 렌더 ─────────────────────────────────────────────────────
function render(): void {
  hostEl.innerHTML = '';
  const gitRows = rows.filter(r => r.namespace === 'git' && r.displayLabel);
  const jiraRows = rows.filter(r => r.namespace === 'jira' && r.displayLabel);

  if (gitRows.length === 0 && jiraRows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'connection-empty';
    empty.textContent = '아직 등록된 프로젝트가 없습니다. Git/Jira 연결을 추가하거나 폴링이 한 번 이상 완료되면 여기에 표시됩니다.';
    hostEl.appendChild(empty);
    return;
  }

  if (gitRows.length > 0) hostEl.appendChild(renderSection('Git 프로젝트', gitRows));
  if (jiraRows.length > 0) hostEl.appendChild(renderSection('Jira 프로젝트', jiraRows));
}

function renderSection(title: string, list: FilterRow[]): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'field';

  const header = document.createElement('span');
  header.className = 'field-label';
  header.textContent = `${title} (${list.length})`;
  sec.appendChild(header);

  const ul = document.createElement('ul');
  ul.className = 'connection-list';
  for (const row of list) ul.appendChild(renderRow(row));
  sec.appendChild(ul);
  return sec;
}

function renderRow(row: FilterRow): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'connection-card';
  li.dataset.key = row.projectKey;

  const body = document.createElement('div');
  body.className = 'connection-card-body';
  const title = document.createElement('div');
  title.className = 'connection-card-title';
  const span = document.createElement('span');
  span.className = 'truncate';
  span.textContent = row.displayLabel;
  title.appendChild(span);
  body.appendChild(title);
  const meta = document.createElement('div');
  meta.className = 'connection-card-meta text-mono';
  meta.textContent = row.projectKey;
  body.appendChild(meta);
  li.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'connection-card-actions';
  const label = document.createElement('label');
  label.className = 'checkbox-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = row.muted;
  cb.addEventListener('change', (): void => {
    row.muted = cb.checked;
    dirty = !allEqualOriginal();
  });
  const text = document.createElement('span');
  text.className = 'checkbox-label';
  text.textContent = '뮤트';
  label.appendChild(cb);
  label.appendChild(text);
  actions.appendChild(label);
  li.appendChild(actions);
  return li;
}

function allEqualOriginal(): boolean {
  for (const r of rows) {
    if ((originalMuted[r.projectKey] ?? false) !== r.muted) return false;
  }
  return true;
}
