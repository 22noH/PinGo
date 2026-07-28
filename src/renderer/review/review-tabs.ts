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
  /** 이 탭의 AI 리뷰 원문 — 비활성 탭에서도 스트리밍이 계속 쌓인다 */
  buffer: string;
}

type TabChangeCallback = (tab: ReviewTab) => void;
let tabs: ReviewTab[] = [];
let activeId: string | null = null;
let onActivate: TabChangeCallback = () => undefined;
let onDeactivate: TabChangeCallback = () => undefined;
let tabBarEl: HTMLElement | null = null;

export function initTabs(
  barEl: HTMLElement,
  cb: TabChangeCallback,
  onLeave: TabChangeCallback,
): void {
  tabBarEl = barEl;
  onActivate = cb;
  // 탭을 떠나기 직전에 화면 상태를 그 탭에 저장 — 없으면 진행 중이던 리뷰의
  // 상태가 통째로 날아가 돌아왔을 때 로딩 스피너에 멈춰 있다
  onDeactivate = onLeave;
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
    savedHtml: '', fileHtml: '', fileCount: '0', errorMsg: '', buffer: '',
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
  if (activeId !== null && activeId !== id) {
    const leaving = tabs.find((t) => t.id === activeId);
    if (leaving) onDeactivate(leaving);
  }
  activeId = id;
  renderBar();
  onActivate(tab);
}

/** id 로 탭 조회 — IPC 이벤트를 활성 탭이 아니라 해당 탭으로 보내기 위함 */
export function getById(id: string): ReviewTab | null {
  return tabs.find((t) => t.id === id) ?? null;
}

export function isActive(id: string): boolean {
  return activeId === id;
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
    // 비활성 탭에서도 리뷰가 도니 상태를 라벨에 표시 — 글리프라 별도 CSS 불필요
    labelSpan.textContent = `${prefix} #${tab.item?.itemId ?? '—'}${stateGlyph(tab.state)}`;

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

function stateGlyph(state: ReviewState): string {
  switch (state) {
    case 'loading':
    case 'streaming': return ' …';
    case 'done': return ' ✓';
    case 'error': return ' !';
    default: return '';
  }
}
