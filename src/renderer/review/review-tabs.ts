// review-tabs.ts — 크롬 스타일 탭 상태 관리 + 렌더링 + 드래그 분리
import type { ReviewItemSummary, ReviewItemWithChanges, ReviewState } from '../../shared/types';

type AnyItem = ReviewItemSummary | ReviewItemWithChanges;

export interface ReviewTab {
  id: string;
  item: AnyItem;
  state: ReviewState;
  savedHtml: string;
  fileHtml: string;
  fileCount: string;
  errorMsg: string;
}

type TabChangeCallback = (tab: ReviewTab) => void;
type DetachCallback = (tab: ReviewTab) => void;

let tabs: ReviewTab[] = [];
let activeId: string | null = null;
let onActivate: TabChangeCallback = () => undefined;
let onDetach: DetachCallback = () => undefined;
let tabBarEl: HTMLElement | null = null;

export function initTabs(
  barEl: HTMLElement,
  cb: TabChangeCallback,
  detachCb: DetachCallback,
): void {
  tabBarEl = barEl;
  onActivate = cb;
  onDetach = detachCb;
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

  // 마지막 탭을 닫으면 윈도우 종료
  if (tabs.length === 0) {
    window.close();
    return;
  }

  if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activateById(next.id);
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
    const prefix = tab.item?.providerType === 'github' ? 'PR' : 'MR';
    labelSpan.textContent = `${prefix} #${tab.item?.itemId ?? '—'}`;

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

    attachDragDetach(btn, tab);
  }
}

/** 탭 버튼에 드래그-분리 제스처 등록 */
function attachDragDetach(btn: HTMLButtonElement, tab: ReviewTab): void {
  btn.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;  // 좌클릭만
    const startY = e.clientY;
    let ghost: HTMLElement | null = null;
    let dragging = false;

    // OS 윈도우 드래그가 mousemove를 가로채지 않도록 일시 비활성화
    const strip = tabBarEl?.parentElement;
    strip?.classList.add('dragging-tab');

    const onMove = (ev: MouseEvent): void => {
      const dy = ev.clientY - startY;
      if (!dragging && dy > 35) {
        dragging = true;
        ghost = createGhost(btn, ev.clientX, ev.clientY);
        document.body.appendChild(ghost);
        document.body.style.cursor = 'grabbing';
      }
      if (dragging && ghost) {
        ghost.style.left = `${ev.clientX - 40}px`;
        ghost.style.top = `${ev.clientY - 16}px`;
      }
    };

    const onUp = (ev: MouseEvent): void => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      ghost?.remove();
      strip?.classList.remove('dragging-tab');
      const dy = ev.clientY - startY;
      if (dy > 35 && tabs.length > 1) {
        onDetach(tab);
        closeById(tab.id);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function createGhost(src: HTMLButtonElement, x: number, y: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'review-tab-ghost';
  el.textContent = src.querySelector('.review-tab-label')?.textContent ?? '';
  el.style.left = `${x - 40}px`;
  el.style.top = `${y - 16}px`;
  return el;
}

export function getTabCount(): number { return tabs.length; }
