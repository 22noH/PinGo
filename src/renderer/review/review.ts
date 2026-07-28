// review.ts — Pingo 리뷰 윈도우 엔트리포인트 (v2 ReviewItem 기반)
// MR/PR 공통 헤더, 상태 머신, IPC 구독, 버튼 핸들링, diff 모달
// window.electronAPI 타입은 renderer/global.d.ts 에서 선언
import type {
  ReviewItemSummary,
  ReviewItemWithChanges,
  ItemChange,
  ReviewState,
  ReviewChunkPayload,
  ReviewDonePayload,
  ReviewErrorPayload,
} from '../../shared/types';
import { initMarked, renderPartial } from './review-markdown';
import { StreamController, type StreamView } from './review-stream';
import { openDiffModal } from './review-diff-modal';
import {
  initTabs, addOrActivate, getActive, getById, isActive, updateActive,
  closeById, getTabCount, renderBar,
} from './review-tabs';
import type { ReviewTab } from './review-tabs';
import { initReviewActions } from './review-actions';
import { renderDiscussions } from './review-discussions';
import { postCommentAction } from './review-comment';
import { renderHeader, type HeaderRefs } from './review-header';
import { applyReviewState, type StateRefs } from './review-state';
type AnyItem = ReviewItemSummary | ReviewItemWithChanges;

const hasChanges = (it: AnyItem): it is ReviewItemWithChanges =>
  'changes' in it && Array.isArray((it as ReviewItemWithChanges).changes);

// ── DOM ──────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const mrIid       = $<HTMLElement>('mr-iid');
const mrTitle     = $<HTMLElement>('mr-title');
const mrBranch    = $<HTMLElement>('mr-branch');
const mrAuthor    = $<HTMLElement>('mr-author');
const mrLink      = $<HTMLAnchorElement>('mr-link');
const stateBadge  = $<HTMLElement>('review-state-badge');
const tabBar      = $<HTMLElement>('review-tabstrip');

const idleBox     = $<HTMLElement>('review-idle');
const markdownEl  = $<HTMLElement>('review-markdown');
const errorBox    = $<HTMLElement>('review-error');
const errorMsg    = $<HTMLElement>('review-error-message');
const scrollEl    = $<HTMLElement>('review-scroll');
const scrollBtn   = $<HTMLButtonElement>('btn-scroll-bottom');

const fileList    = $<HTMLUListElement>('file-list');
const fileCount   = $<HTMLElement>('file-count');
const discussionsSection = $<HTMLElement>('review-discussions');
const discussionsList    = $<HTMLUListElement>('thread-list');
const discussionsCount   = $<HTMLElement>('discussions-count');

const btnReview   = $<HTMLButtonElement>('btn-review');
const btnAbort    = $<HTMLButtonElement>('btn-abort');
const btnComment  = $<HTMLButtonElement>('btn-comment');
const btnRetry    = $<HTMLButtonElement>('btn-retry');
const btnEdit       = $<HTMLButtonElement>('btn-edit');
const btnSaveEdit   = $<HTMLButtonElement>('btn-save-edit');
const btnCancelEdit = $<HTMLButtonElement>('btn-cancel-edit');
const editArea    = $<HTMLTextAreaElement>('review-edit');

// ── 상태 ─────────────────────────────────────────────────────
let reviewState: ReviewState = 'idle';
// 탭별 파일 변경 데이터 — innerHTML restore 시 click 핸들러 살리기 위해 보존
const tabChanges = new Map<string, ItemChange[]>();

const streamView: StreamView = {
  markdown: markdownEl, cursorEl: markdownEl, scroll: scrollEl,
  fileList, fileCount, scrollBtn,
};
const stream = new StreamController(streamView, (change: ItemChange) => openDiffModal(change));

// ── 탭 초기화 ────────────────────────────────────────────────
initTabs(
  tabBar,
  (tab) => {
    if (!tab.id) { applyHeader(null); setReviewState('idle'); return; }
    restoreTab(tab);
  },
  // 탭을 떠날 때 현재 화면을 그 탭에 저장 (스트리밍 원문 포함)
  (leaving) => saveTab(leaving),
);

/** 현재 화면 상태를 지정한 탭에 저장. 탭 전환/새 아이템 수신 직전에 호출. */
function saveTab(tab: ReviewTab): void {
  tab.state = reviewState;
  tab.savedHtml = markdownEl.innerHTML;
  tab.fileHtml = fileList.innerHTML;
  tab.fileCount = fileCount.textContent ?? '0';
  tab.errorMsg = errorMsg.textContent ?? '';
  tab.buffer = stream.getFullText();
}

function saveCurrentTab(): void {
  const tab = getActive();
  if (tab) saveTab(tab);
}

function restoreTab(tab: ReviewTab): void {
  applyHeader(tab.item);
  setReviewState(tab.state);
  // 스트림 버퍼도 탭 것으로 교체 — 안 하면 이전 탭 원문에 이어붙어 섞인다
  stream.setFullText(tab.buffer);
  markdownEl.innerHTML = tab.savedHtml;
  // innerHTML 복원은 click 핸들러가 날아가므로 ItemChange[]가 있으면 재렌더
  const changes = tabChanges.get(tab.id);
  if (changes && changes.length > 0) {
    stream.setFileList(changes);
  } else {
    fileList.innerHTML = tab.fileHtml || '<li class="file-empty text-muted">리뷰가 시작되면 여기에 파일이 표시됩니다.</li>';
  }
  fileCount.textContent = tab.fileCount;
  if (tab.errorMsg) errorMsg.textContent = tab.errorMsg;
  if (tab.state === 'done' || tab.state === 'error') {
    markdownEl.hidden = tab.state !== 'done' || !tab.savedHtml;
  }
}

// ── 헤더 렌더링 ─────────────────────────────────────────────
const headerRefs: HeaderRefs = { mrIid, mrTitle, mrBranch, mrAuthor, mrLink };
const applyHeader = (item: AnyItem | null): void => renderHeader(headerRefs, item);

mrLink.addEventListener('click', (e) => {
  e.preventDefault();
  const tab = getActive();
  if (tab?.item) window.electronAPI.openMrInBrowser(tab.item.webUrl);
});

// ── 상태 머신 ───────────────────────────────────────────────
const stateRefs: StateRefs = {
  stateBadge, idleBox, markdownEl, errorBox,
  btnReview, btnAbort, btnRetry, btnEdit, btnSaveEdit, btnCancelEdit, btnComment, editArea,
};
function setReviewState(next: ReviewState): void {
  reviewState = next;
  applyReviewState(stateRefs, next);
}

// ── IPC 구독 ─────────────────────────────────────────────────
window.electronAPI.onItemNew((it: AnyItem): void => {
  if (hasChanges(it)) {
    // 리뷰 파이프라인이 보낸 변경 파일 — 해당 탭에만 반영하고 활성 탭은 건드리지 않는다.
    // (여기서 탭을 강제 활성화하면 다른 탭을 보던 사용자의 화면을 빼앗는다)
    const target = getById(it.id);
    if (!target) return;
    tabChanges.set(target.id, it.changes);
    target.item = it;
    if (!isActive(target.id)) {
      // 비활성 탭: DOM 대신 탭 상태만 갱신 — 활성화 시 restoreTab 이 그린다
      target.fileCount = String(it.changes.length);
      if (target.state === 'loading') {
        target.savedHtml =
          '<div class="row text-secondary"><span class="spinner"></span>' +
          `<span>파일 ${it.changes.length}개 분석 완료. AI 응답 대기 중…</span></div>`;
      }
      renderBar();
      return;
    }
    stream.setFileList(it.changes);
    updateActive({ fileHtml: fileList.innerHTML, fileCount: fileCount.textContent ?? '0' });
    // discussions 가 있으면 답글 UI 렌더 (없으면 섹션 숨김)
    renderDiscussions(
      discussionsList,
      discussionsCount,
      discussionsSection,
      it.discussions ?? [],
      { item: it },
    );
    // 파일 목록 도착 완료 → AI 응답 대기 구간 안내 (첫 chunk까지 공백 방지)
    if (reviewState === 'loading') {
      markdownEl.innerHTML =
        '<div class="row text-secondary"><span class="spinner"></span>' +
        `<span>파일 ${it.changes.length}개 분석 완료. AI 응답 대기 중…</span></div>`;
    }
    if (reviewState === 'idle' || reviewState === 'done') void restoreCachedReview(it);
    return;
  }

  // summary — 트레이/토스트/대시보드에서 MR 열기. 이 경로만 탭을 활성화한다.
  saveCurrentTab();
  const tab = addOrActivate(it);
  {
    // summary만 들어온 경우 = 트레이/토스트/대시보드에서 MR 열기. 이전 세션의 error/done 상태가
    // 남아있으면 리셋(진행 중인 스트리밍은 보존).
    if (tab.state === 'error' || tab.state === 'done') {
      updateActive({ state: 'idle', savedHtml: '', errorMsg: '' });
      markdownEl.innerHTML = '';
      errorMsg.textContent = '';
      setReviewState('idle');
    }
    if (tab.state === 'idle') {
      btnReview.disabled = false;
    }
    // summary 단계에서는 discussions 섹션 숨김 (다음 WithChanges 가 올 때 렌더)
    discussionsSection.hidden = true;
  }
  // 어느 경로(summary | full) 든 idle/done 상태면 캐시 복원 시도.
  // loading/streaming 중에 새 ITEM_NEW가 와도 진행 중인 리뷰는 건드리지 않음.
  if (reviewState === 'idle' || reviewState === 'done') {
    void restoreCachedReview(it);
  }
});

window.electronAPI.onReviewChunk(({ itemId, chunk }: ReviewChunkPayload): void => {
  const tab = getById(itemId);
  if (!tab) return; // 탭이 이미 닫힘 — 버릴 청크
  if (!isActive(itemId)) {
    // 비활성 탭: DOM 을 건드리지 않고 그 탭 버퍼에만 쌓는다
    tab.buffer += chunk;
    if (tab.state !== 'streaming') {
      tab.state = 'streaming';
      renderBar();
    }
    return;
  }
  if (reviewState === 'loading') {
    stream.reset();
    setReviewState('streaming');
  }
  stream.append(chunk);
});

window.electronAPI.onReviewDone(({ itemId }: ReviewDonePayload): void => {
  const tab = getById(itemId);
  if (!tab) return;
  const text = isActive(itemId) ? stream.getFullText() : tab.buffer;
  if (isActive(itemId)) {
    stream.finalize();
    setReviewState('done');
    updateActive({ state: 'done', savedHtml: markdownEl.innerHTML });
  } else {
    tab.state = 'done';
    tab.savedHtml = renderPartial(tab.buffer);
    renderBar();
  }
  // 완료된 리뷰를 영구 캐시에 저장 — 창을 닫았다가 다시 열어도 복원 가능.
  if (text.trim().length > 0) window.electronAPI.saveReviewCache(itemId, text);
});

window.electronAPI.onReviewError(({ itemId, message }: ReviewErrorPayload): void => {
  const tab = getById(itemId);
  if (!tab) return;
  if (!isActive(itemId)) {
    tab.state = 'error';
    tab.errorMsg = message;
    renderBar();
    return;
  }
  stream.finalize();
  errorMsg.textContent = message;
  errorBox.hidden = false;
  markdownEl.hidden = true;
  setReviewState('error');
  updateActive({ state: 'error', errorMsg: message });
});

// ── 버튼 핸들러 ─────────────────────────────────────────────
function startReview(): void {
  const tab = getActive();
  if (!tab?.item) return;
  stream.reset();
  stream.renderWaitingForChanges();
  setReviewState('loading');
  // 탭에도 기록 — 다른 탭으로 갔다 돌아와도 로딩 중이었음이 유지된다
  tab.state = 'loading';
  tab.buffer = '';
  renderBar();
  const summary: ReviewItemSummary = hasChanges(tab.item)
    ? stripChanges(tab.item)
    : tab.item;
  window.electronAPI.startReview({ item: summary });
}

function stripChanges(it: ReviewItemWithChanges): ReviewItemSummary {
  const { changes: _changes, ...rest } = it;
  void _changes;
  return rest;
}

/**
 * 저장소에 캐시된 AI 리뷰가 있으면 불러와 화면에 복원.
 * 탭이 이미 다른 이슈로 바뀐 경우 복원하지 않도록 id 체크.
 */
async function restoreCachedReview(it: AnyItem): Promise<void> {
  try {
    const cached = await window.electronAPI.loadReviewCache(it.id);
    if (!cached || !cached.markdown.trim()) return;
    // 비동기 완료 시점에 활성 탭이 다른 이슈면 복원 스킵
    const active = getActive();
    if (!active?.item || active.item.id !== it.id) return;
    // 스트리밍/로딩 중이면 (사용자가 방금 리뷰 시작) 덮어쓰지 않음
    if (reviewState === 'loading' || reviewState === 'streaming') return;
    stream.setFullText(cached.markdown);
    setReviewState('done');
    updateActive({ state: 'done', savedHtml: markdownEl.innerHTML });
  } catch { /* 캐시 실패는 무시 — 사용자가 다시 리뷰 실행 가능 */ }
}

btnReview.addEventListener('click', startReview);
btnRetry.addEventListener('click', startReview);

btnAbort.addEventListener('click', () => {
  const tab = getActive();
  if (!tab) return;
  window.electronAPI.abortReview(tab.id);
  setReviewState('idle');
  updateActive({ state: 'idle' });
  renderBar();
});

btnComment.addEventListener('click', () => { void postComment(); });

// ── 편집 모드 ───────────────────────────────────────────────
function enterEditMode(): void {
  editArea.value = stream.getFullText();
  editArea.hidden = false;
  markdownEl.hidden = true;
  btnEdit.hidden = true;
  btnSaveEdit.hidden = false;
  btnCancelEdit.hidden = false;
  btnComment.disabled = true;
  btnRetry.hidden = true;
  editArea.focus();
}

function exitEditMode(): void {
  editArea.hidden = true;
  markdownEl.hidden = false;
  btnEdit.hidden = false;
  btnSaveEdit.hidden = true;
  btnCancelEdit.hidden = true;
  btnComment.disabled = false;
  btnRetry.hidden = false;
}

btnEdit.addEventListener('click', enterEditMode);
btnCancelEdit.addEventListener('click', exitEditMode);
btnSaveEdit.addEventListener('click', () => {
  const edited = editArea.value;
  stream.setFullText(edited);
  updateActive({ savedHtml: markdownEl.innerHTML });
  exitEditMode();
});

async function postComment(): Promise<void> {
  const tab = getActive();
  if (!tab?.item) return;
  await postCommentAction({
    item: tab.item,
    body: stream.getFullText().trim(),
    btn: btnComment,
    errorBox,
    errorMsg,
    getReviewState: () => reviewState,
  });
}

// ── 키보드 단축키 ───────────────────────────────────────────
document.addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && (reviewState === 'streaming' || reviewState === 'loading')) {
    if (!document.querySelector('.modal-backdrop')) btnAbort.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !btnReview.disabled && !btnReview.hidden) {
    startReview();
  }
  // Ctrl+W — 현재 탭 닫기 (탭이 2개 이상일 때)
  if ((e.ctrlKey || e.metaKey) && e.key === 'w' && getTabCount() > 1) {
    e.preventDefault();
    const tab = getActive();
    if (tab?.id) closeById(tab.id);
  }
});

// ── 부팅 ────────────────────────────────────────────────────
function bootstrap(): void {
  if (!initMarked()) setTimeout(bootstrap, 50);
}
stream.renderInitialEmpty();
initReviewActions(() => getActive()?.item ?? null);
bootstrap();
