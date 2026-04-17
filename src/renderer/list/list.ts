// list.ts — 리뷰 목록 윈도우
import type {
  ItemInteraction,
  ListLoadResult,
  ReviewItemSummary,
} from '../../shared/types';

type Filter = 'all' | 'mine' | 'unseen';

let currentItems: ReviewItemSummary[] = [];
let currentInteractions: Record<string, ItemInteraction> = {};
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
  render();
}

filterBtns.all.addEventListener('click', () => setFilter('all'));
filterBtns.mine.addEventListener('click', () => setFilter('mine'));
filterBtns.unseen.addEventListener('click', () => setFilter('unseen'));

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

function render(): void {
  countAll.textContent = String(currentItems.length);
  countMine.textContent = String(currentItems.filter((it) => it.viewerIsReviewer).length);
  countUnseen.textContent = String(currentItems.filter(isUnseen).length);

  const filtered = applyFilter(currentItems);
  mrList.innerHTML = '';
  listEmpty.hidden = filtered.length > 0;
  mrList.hidden = filtered.length === 0;

  for (const item of filtered) {
    mrList.appendChild(renderItem(item));
  }

  listStatus.textContent = `${filtered.length}개 표시 (전체 ${currentItems.length})`;
}

function renderItem(item: ReviewItemSummary): HTMLLIElement {
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
    const branches = document.createElement('span');
    branches.textContent = `${item.sourceBranch} → ${item.targetBranch}`;
    meta.appendChild(branches);
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
  btnReview.addEventListener('click', () => {
    window.electronAPI.openReviewForItem(item.id);
  });
  const btnBrowser = document.createElement('button');
  btnBrowser.className = 'mr-action';
  btnBrowser.type = 'button';
  btnBrowser.textContent = '🌐 브라우저';
  btnBrowser.addEventListener('click', () => {
    window.electronAPI.openMrInBrowser(item.webUrl);
  });
  actions.appendChild(btnReview);
  actions.appendChild(btnBrowser);
  li.appendChild(actions);

  return li;
}

async function bootstrap(): Promise<void> {
  try {
    const { items, interactions } = await window.electronAPI.loadList();
    currentItems = items;
    currentInteractions = interactions;
    render();
  } catch (err) {
    listStatus.textContent = `로드 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
}

window.electronAPI.onListUpdated((payload: ListLoadResult): void => {
  currentItems = payload.items;
  currentInteractions = payload.interactions;
  btnRefresh.classList.remove('is-spinning');
  btnRefresh.disabled = false;
  render();
});

btnRefresh.addEventListener('click', () => {
  btnRefresh.classList.add('is-spinning');
  btnRefresh.disabled = true;
  listStatus.textContent = '새로고침 중…';
  window.electronAPI.refreshList();
  // 폴링 결과가 안 올 경우 대비 — 5초 후 강제로 해제
  setTimeout(() => {
    btnRefresh.classList.remove('is-spinning');
    btnRefresh.disabled = false;
  }, 5000);
});

void bootstrap();
