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
let tabs: ReviewTab[] = [];
let activeId: string | null = null;
let onActivate: TabChangeCallback = () => undefined;
let tabBarEl: HTMLElement | null = null;

export function initTabs(
  barEl: HTMLElement,
  cb: TabChangeCallback,
): void {
  tabBarEl = barEl;
  onActivate = cb;
  // Main 프로세스가 커서가 창 밖으로 나갔음을 알릴 때 해당 탭 분리
  window.electronAPI.onTabDragDetach((tabId: string) => {
    closeById(tabId); // 마지막 탭이면 window.close() 까지 처리됨
  });
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

/** 탭 드래그 감지: 8px 이상 움직이면 ghost 표시, 릴리즈 시 main에 드롭 위치 판단 위임 */
function attachDragDetach(btn: HTMLButtonElement, tab: ReviewTab): void {
  btn.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    // 닫기 버튼 클릭은 드래그로 처리하지 않음
    if ((e.target as Element).closest('.review-tab-close')) return;
    btn.setPointerCapture(e.pointerId);

    const startX = e.clientX, startY = e.clientY;
    let ghost: HTMLElement | null = null;
    let dragStarted = false;
    const strip = tabBarEl?.parentElement;

    const onMove = (ev: PointerEvent): void => {
      if (!dragStarted && (Math.abs(ev.clientX - startX) > 8 || Math.abs(ev.clientY - startY) > 8)) {
        dragStarted = true;
        ghost = createGhost(btn, ev.clientX, ev.clientY);
        document.body.appendChild(ghost);
        document.body.style.cursor = 'grabbing';
        strip?.classList.add('dragging-tab');
        window.electronAPI.tabDragStart(tab.id, tab.item);
      }
      if (dragStarted && ghost) {
        ghost.style.left = `${ev.clientX - 40}px`;
        ghost.style.top = `${ev.clientY - 16}px`;
      }
    };

    const cleanup = (ev: PointerEvent): void => {
      btn.removeEventListener('pointermove', onMove);
      btn.removeEventListener('pointerup', cleanup);
      btn.removeEventListener('pointercancel', cleanup);
      btn.releasePointerCapture(ev.pointerId);
      ghost?.remove(); ghost = null;
      document.body.style.cursor = '';
      strip?.classList.remove('dragging-tab');
      if (dragStarted) {
        dragStarted = false;
        if (ev.type === 'pointerup') {
          // 릴리즈: main 프로세스가 드롭 위치 보고 분리/병합/취소 결정
          window.electronAPI.tabDragDrop(tab.id, tab.item);
        } else {
          // 취소 (pointercancel)
          window.electronAPI.tabDragEnd();
        }
      }
    };

    btn.addEventListener('pointermove', onMove);
    btn.addEventListener('pointerup', cleanup);
    btn.addEventListener('pointercancel', cleanup);
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
