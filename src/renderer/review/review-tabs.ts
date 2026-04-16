// review-tabs.ts — 크롬 스타일 탭 상태 관리 + 렌더링
import type { ReviewItemSummary, ReviewItemWithChanges, ReviewState } from '../../shared/types';

type AnyItem = ReviewItemSummary | ReviewItemWithChanges;

export interface ReviewTab {
  id: string;           // item.id
  item: AnyItem;
  state: ReviewState;
  savedHtml: string;    // 완료/오류 시 review-markdown innerHTML 저장
  fileHtml: string;     // file-list innerHTML 저장
  fileCount: string;    // file-count 텍스트 저장
  errorMsg: string;
}

type TabChangeCallback = (tab: ReviewTab) => void;

let tabs: ReviewTab[] = [];
let activeId: string | null = null;
let onActivate: TabChangeCallback = () => undefined;
let tabBarEl: HTMLElement | null = null;

export function initTabs(barEl: HTMLElement, cb: TabChangeCallback): void {
  tabBarEl = barEl;
  onActivate = cb;
}

export function addOrActivate(item: AnyItem): ReviewTab {
  const existing = tabs.find((t) => t.id === item.id);
  if (existing) {
    existing.item = item;
    activateById(existing.id);
    return existing;
  }
  const tab: ReviewTab = {
    id: item.id, item, state: 'idle',
    savedHtml: '', fileHtml: '', fileCount: '0', errorMsg: '',
  };
  tabs.push(tab);
  activateById(tab.id);
  return tab;
}

export function getActive(): ReviewTab | null {
  return tabs.find((t) => t.id === activeId) ?? null;
}

export function updateActive(patch: Partial<Omit<ReviewTab, 'id' | 'item'>>): void {
  const tab = getActive();
  if (!tab) return;
  Object.assign(tab, patch);
}

export function activateById(id: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  renderBar();
  onActivate(tab);
}

export function closeById(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) {
      activateById(next.id);
    } else {
      activeId = null;
      renderBar();
      onActivate({ id: '', item: null as unknown as AnyItem, state: 'idle', savedHtml: '', fileHtml: '', fileCount: '0', errorMsg: '' });
    }
  } else {
    renderBar();
  }
}

export function renderBar(): void {
  if (!tabBarEl) return;
  tabBarEl.innerHTML = '';
  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.className = 'review-tab' + (tab.id === activeId ? ' is-active' : '');
    btn.dataset.tabId = tab.id;
    btn.setAttribute('type', 'button');

    const labelSpan = document.createElement('span');
    labelSpan.className = 'review-tab-label';
    const providerType = tab.item?.providerType ?? 'gitlab';
    const prefix = providerType === 'github' ? 'PR' : 'MR';
    const itemId = tab.item?.itemId ?? '—';
    labelSpan.textContent = `${prefix} #${itemId}`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'review-tab-close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', '탭 닫기');
    closeBtn.innerHTML = '×';

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeById(tab.id);
    });

    btn.addEventListener('click', () => activateById(tab.id));
    btn.appendChild(labelSpan);
    btn.appendChild(closeBtn);
    tabBarEl.appendChild(btn);
  }
}

export function getTabCount(): number { return tabs.length; }
