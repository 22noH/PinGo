// list.ts — 리뷰 목록 윈도우 (MR/PR + Jira 탭)
import type {
  GitConfig,
  ItemInteraction,
  JiraIssueSummary,
  ListLoadResult,
  ReviewItemSummary,
} from '../../shared/types';
import { openBranchModal } from './branch-modal';

type Filter = 'all' | 'mine' | 'unseen';
type TabKey = 'mr' | 'jira';

let currentItems: ReviewItemSummary[] = [];
let currentInteractions: Record<string, ItemInteraction> = {};
let currentJira: JiraIssueSummary[] = [];
let gitConnections: GitConfig[] = [];
let activeFilter: Filter = 'all';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const mrList = $<HTMLUListElement>('mr-list');
const listEmpty = $<HTMLElement>('list-empty');
const listStatus = $<HTMLElement>('list-status');
const btnRefresh = $<HTMLButtonElement>('btn-refresh');
const countAll = $<HTMLElement>('count-all');
const countMine = $<HTMLElement>('count-mine');
const countUnseen = $<HTMLElement>('count-unseen');
const jiraList = $<HTMLUListElement>('jira-list');
const jiraEmpty = $<HTMLElement>('jira-empty');
const jiraCount = $<HTMLElement>('jira-count');
const tabMrCount = $<HTMLElement>('tab-mr-count');
const tabJiraCount = $<HTMLElement>('tab-jira-count');
const tabMr = $<HTMLButtonElement>('tab-mr');
const tabJira = $<HTMLButtonElement>('tab-jira');
const panelMr = $<HTMLElement>('panel-mr');
const panelJira = $<HTMLElement>('panel-jira');

const filterBtns = {
  all: $<HTMLButtonElement>('filter-all'),
  mine: $<HTMLButtonElement>('filter-mine'),
  unseen: $<HTMLButtonElement>('filter-unseen'),
};

function setFilter(f: Filter): void {
  activeFilter = f;
  for (const [key, btn] of Object.entries(filterBtns)) {
    btn.classList.toggle('is-active', key === f);
  }
  renderMrList();
}

function setTab(t: TabKey): void {
  tabMr.classList.toggle('is-active', t === 'mr');
  tabJira.classList.toggle('is-active', t === 'jira');
  tabMr.setAttribute('aria-selected', String(t === 'mr'));
  tabJira.setAttribute('aria-selected', String(t === 'jira'));
  panelMr.classList.toggle('is-active', t === 'mr');
  panelJira.classList.toggle('is-active', t === 'jira');
  panelMr.hidden = t !== 'mr';
  panelJira.hidden = t !== 'jira';
}

filterBtns.all.addEventListener('click', () => setFilter('all'));
filterBtns.mine.addEventListener('click', () => setFilter('mine'));
filterBtns.unseen.addEventListener('click', () => setFilter('unseen'));
tabMr.addEventListener('click', () => setTab('mr'));
tabJira.addEventListener('click', () => setTab('jira'));

function isUnseen(item: ReviewItemSummary): boolean {
  return !currentInteractions[item.id]?.openedAt;
}

function applyFilter(items: ReviewItemSummary[]): ReviewItemSummary[] {
  switch (activeFilter) {
    case 'mine': return items.filter((it) => it.viewerIsReviewer);
    case 'unseen': return items.filter(isUnseen);
    default: return items;
  }
}

function renderMrList(): void {
  countAll.textContent = String(currentItems.length);
  countMine.textContent = String(currentItems.filter((it) => it.viewerIsReviewer).length);
  countUnseen.textContent = String(currentItems.filter(isUnseen).length);

  const filtered = applyFilter(currentItems);
  mrList.innerHTML = '';
  listEmpty.hidden = filtered.length > 0;
  mrList.hidden = filtered.length === 0;
  for (const item of filtered) mrList.appendChild(renderMrItem(item));
  tabMrCount.textContent = String(currentItems.length);
}

function renderMrItem(item: ReviewItemSummary): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'mr-item';
  if (item.viewerIsReviewer) li.classList.add('is-reviewer');
  const unseen = isUnseen(item);
  if (unseen) li.classList.add('is-unseen');

  const dot = document.createElement('div');
  dot.className = 'mr-dot ' + (unseen ? 'is-unseen' : 'is-seen');
  li.appendChild(dot);

  const info = document.createElement('div');
  info.className = 'mr-info';
  const title = document.createElement('p');
  title.className = 'mr-title';
  title.textContent = `[${item.providerLabel}] #${item.itemId}  ${item.title}`;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'mr-meta';
  const author = document.createElement('span');
  author.textContent = `@${item.author.username}`;
  meta.appendChild(author);
  if (item.sourceBranch && item.targetBranch) {
    const br = document.createElement('span');
    br.textContent = `${item.sourceBranch} → ${item.targetBranch}`;
    meta.appendChild(br);
  }
  if (item.viewerIsReviewer) {
    const b = document.createElement('span');
    b.className = 'mr-badge is-reviewer';
    b.textContent = '👤 내가 리뷰어';
    meta.appendChild(b);
  }
  const itx = currentInteractions[item.id];
  if (itx?.reviewedAt) {
    const b = document.createElement('span');
    b.className = 'mr-badge is-reviewed';
    b.textContent = '✓ AI 리뷰';
    meta.appendChild(b);
  }
  if (itx?.commentedAt) {
    const b = document.createElement('span');
    b.className = 'mr-badge is-commented';
    b.textContent = '💬 댓글 등록';
    meta.appendChild(b);
  }
  info.appendChild(meta);
  li.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'mr-actions';
  const btnReview = document.createElement('button');
  btnReview.className = 'mr-action primary';
  btnReview.type = 'button';
  btnReview.textContent = '🧠 AI 리뷰';
  btnReview.addEventListener('click', () => window.electronAPI.openReviewForItem(item.id));
  const btnBrowser = document.createElement('button');
  btnBrowser.className = 'mr-action';
  btnBrowser.type = 'button';
  btnBrowser.textContent = '🌐 브라우저';
  btnBrowser.addEventListener('click', () => window.electronAPI.openMrInBrowser(item.webUrl));
  actions.appendChild(btnReview);
  actions.appendChild(btnBrowser);
  li.appendChild(actions);
  return li;
}

function renderJiraList(): void {
  jiraList.innerHTML = '';
  jiraEmpty.hidden = currentJira.length > 0;
  for (const issue of currentJira) jiraList.appendChild(renderJiraItem(issue));
  jiraCount.textContent = String(currentJira.length);
  tabJiraCount.textContent = String(currentJira.length);
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('progress')) return 'is-progress';
  if (s.includes('done') || s === 'closed' || s === 'resolved') return 'is-done';
  if (s.includes('block')) return 'is-blocked';
  if (s.includes('review')) return 'is-review';
  return 'is-todo';
}

function renderJiraItem(issue: JiraIssueSummary): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'jira-item';

  const body = document.createElement('div');
  body.className = 'jira-item-body';

  const top = document.createElement('div');
  top.className = 'jira-item-top';
  const key = document.createElement('span');
  key.className = 'jira-key';
  key.textContent = issue.issueKey;
  const titleSpan = document.createElement('span');
  titleSpan.className = 'jira-item-title truncate';
  titleSpan.textContent = issue.summary;
  top.appendChild(key);
  top.appendChild(titleSpan);
  body.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'jira-item-meta';
  const statusEl = document.createElement('span');
  statusEl.className = `jira-status ${statusClass(issue.status)}`;
  statusEl.textContent = issue.status;
  meta.appendChild(statusEl);
  if (issue.priority) {
    const sep = document.createElement('span'); sep.className = 'dot-sep'; meta.appendChild(sep);
    const p = document.createElement('span'); p.textContent = issue.priority; meta.appendChild(p);
  }
  if (issue.assignee) {
    const sep = document.createElement('span'); sep.className = 'dot-sep'; meta.appendChild(sep);
    const a = document.createElement('span'); a.textContent = `@${issue.assignee.displayName}`; meta.appendChild(a);
  }
  body.appendChild(meta);
  li.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'jira-item-actions';
  const branchBtn = document.createElement('button');
  branchBtn.type = 'button';
  branchBtn.className = 'btn btn-jira btn-sm';
  branchBtn.textContent = '브랜치 생성';
  branchBtn.addEventListener('click', (): void => {
    openBranchModal({ issue, gitConnections });
  });
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-ghost btn-sm';
  openBtn.textContent = '열기';
  openBtn.addEventListener('click', (): void => window.electronAPI.openMrInBrowser(issue.webUrl));
  actions.appendChild(branchBtn);
  actions.appendChild(openBtn);
  li.appendChild(actions);
  return li;
}

async function bootstrap(): Promise<void> {
  let loadedOk = false;
  try {
    const { items, interactions } = await window.electronAPI.loadList();
    currentItems = items;
    currentInteractions = interactions;
    renderMrList();
    loadedOk = true;
  } catch (err) {
    listStatus.textContent = `로드 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    const { gitConnections: gits } = await window.electronAPI.loadGitConnections();
    gitConnections = gits;
  } catch { /* noop */ }
  renderJiraList();
  if (loadedOk) listStatus.textContent = '';
}

function formatNowTime(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function updateStatusToLastSynced(): void {
  listStatus.textContent = `마지막 확인: ${formatNowTime()}`;
}

window.electronAPI.onListUpdated((payload: ListLoadResult): void => {
  currentItems = payload.items;
  currentInteractions = payload.interactions;
  btnRefresh.classList.remove('is-spinning');
  btnRefresh.disabled = false;
  renderMrList();
  updateStatusToLastSynced();
});

window.electronAPI.onListJiraUpdated((payload): void => {
  currentJira = Array.isArray(payload.issues) ? payload.issues : [];
  renderJiraList();
  updateStatusToLastSynced();
});

window.electronAPI.onJiraIssueNew((issue: JiraIssueSummary): void => {
  const idx = currentJira.findIndex(i => i.id === issue.id);
  if (idx >= 0) currentJira[idx] = issue;
  else currentJira.unshift(issue);
  currentJira = currentJira.slice(0, 20);
  renderJiraList();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.add('is-spinning');
  btnRefresh.disabled = true;
  listStatus.textContent = '새로고침 중…';
  window.electronAPI.refreshList();
  setTimeout(() => {
    btnRefresh.classList.remove('is-spinning');
    btnRefresh.disabled = false;
    if (listStatus.textContent === '새로고침 중…') {
      updateStatusToLastSynced();
    }
  }, 5000);
});

void bootstrap();
