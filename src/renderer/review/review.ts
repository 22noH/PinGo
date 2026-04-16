// review.ts — Pingo 리뷰 윈도우 엔트리포인트 (v2 ReviewItem 기반)
// MR/PR 공통 헤더, 상태 머신, IPC 구독, 버튼 핸들링, diff 모달
// window.electronAPI 타입은 renderer/global.d.ts 에서 선언
import type {
  ReviewItemSummary,
  ReviewItemWithChanges,
  ItemChange,
  ReviewState,
  ReviewChunkPayload,
  ReviewErrorPayload,
  CommentPostResult,
} from '../../shared/types';
import { PROVIDER_SHORT_LABEL, PROVIDER_DISPLAY_NAME } from '../../shared/constants';
import { initMarked } from './review-markdown';
import { StreamController, type StreamView } from './review-stream';
import { openDiffModal } from './review-diff-modal';

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

const idleBox     = $<HTMLElement>('review-idle');
const markdownEl  = $<HTMLElement>('review-markdown');
const errorBox    = $<HTMLElement>('review-error');
const errorMsg    = $<HTMLElement>('review-error-message');
const scrollEl    = $<HTMLElement>('review-scroll');
const scrollBtn   = $<HTMLButtonElement>('btn-scroll-bottom');

const fileList    = $<HTMLUListElement>('file-list');
const fileCount   = $<HTMLElement>('file-count');

const btnReview   = $<HTMLButtonElement>('btn-review');
const btnAbort    = $<HTMLButtonElement>('btn-abort');
const btnComment  = $<HTMLButtonElement>('btn-comment');
const btnRetry    = $<HTMLButtonElement>('btn-retry');

// ── 상태 ─────────────────────────────────────────────────────
let currentItem: AnyItem | null = null;
let reviewState: ReviewState = 'idle';

const streamView: StreamView = {
  markdown: markdownEl, cursorEl: markdownEl, scroll: scrollEl,
  fileList, fileCount, scrollBtn,
};
const stream = new StreamController(streamView, (change: ItemChange) => openDiffModal(change));

// ── 헤더 렌더링 ─────────────────────────────────────────────
function renderHeader(item: AnyItem): void {
  currentItem = item;

  // provider 배지 + 아이디 표시 (MR #N / PR #N)
  mrIid.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `provider-badge is-${item.providerType}`;
  badge.textContent = PROVIDER_SHORT_LABEL[item.providerType] || item.providerLabel || '';
  badge.style.marginRight = '6px';
  mrIid.appendChild(badge);
  const label = document.createElement('span');
  label.textContent = `${item.providerType === 'github' ? 'PR' : 'MR'} #${item.itemId}`;
  mrIid.appendChild(label);

  mrTitle.textContent  = item.title;
  mrBranch.textContent = `${item.sourceBranch} → ${item.targetBranch}`;
  mrAuthor.textContent = `@${item.author.username}`;
  mrLink.href          = item.webUrl;
  mrLink.textContent   = `${PROVIDER_DISPLAY_NAME[item.providerType]}에서 열기`;
  document.title = `${item.providerType === 'github' ? 'PR' : 'MR'} #${item.itemId} — ${item.title}`;
}

mrLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentItem) window.electronAPI.openMrInBrowser(currentItem.webUrl);
});

// ── 상태 머신 ───────────────────────────────────────────────
function setReviewState(next: ReviewState): void {
  reviewState = next;
  stateBadge.className = 'badge ' + stateClass(next);
  stateBadge.textContent = stateLabel(next);

  const streaming = next === 'loading' || next === 'streaming';
  btnReview.hidden = streaming;
  btnAbort.hidden  = !streaming;
  btnRetry.hidden  = !(next === 'error' || next === 'done');
  btnComment.disabled = next !== 'done';

  if (next === 'idle') {
    idleBox.hidden = false;
    markdownEl.hidden = true;
    errorBox.hidden = true;
  } else if (next === 'loading') {
    idleBox.hidden = true;
    errorBox.hidden = true;
    markdownEl.hidden = false;
    markdownEl.innerHTML =
      '<div class="row text-secondary"><span class="spinner"></span><span>변경 파일을 불러오는 중…</span></div>';
  } else if (next === 'streaming') {
    errorBox.hidden = true;
    idleBox.hidden = true;
  } else if (next === 'done') {
    idleBox.hidden = true;
    errorBox.hidden = true;
    btnRetry.textContent = '다시 리뷰';
  } else if (next === 'error') {
    btnRetry.textContent = '다시 시도';
  }
}

function stateLabel(s: ReviewState): string {
  return { idle: '대기', loading: '준비', streaming: '진행 중', done: '완료', error: '오류' }[s];
}
function stateClass(s: ReviewState): string {
  return {
    idle: 'badge-muted', loading: 'badge-info', streaming: 'badge-info',
    done: 'badge-add', error: 'badge-del',
  }[s];
}

// ── IPC 구독 ─────────────────────────────────────────────────
// ITEM_NEW(=onItemNew)는 2회 발생:
//   (1) 리뷰 윈도우 오픈 시 — ReviewItemSummary (헤더 초기화)
//   (2) REVIEW_START 처리 후 fetchChanges 완료 — ReviewItemWithChanges (파일 목록 갱신)
window.electronAPI.onItemNew((it: AnyItem): void => {
  renderHeader(it);
  if (hasChanges(it)) {
    stream.setFileList(it.changes);
  } else if (reviewState === 'idle') {
    btnReview.disabled = false;
  }
});

window.electronAPI.onReviewChunk(({ chunk }: ReviewChunkPayload): void => {
  if (reviewState === 'loading') {
    stream.reset();
    setReviewState('streaming');
  }
  stream.append(chunk);
});

window.electronAPI.onReviewDone((): void => {
  stream.finalize();
  setReviewState('done');
});

window.electronAPI.onReviewError(({ message }: ReviewErrorPayload): void => {
  stream.finalize();
  errorMsg.textContent = message;
  errorBox.hidden = false;
  markdownEl.hidden = true;
  setReviewState('error');
});

// ── 버튼 핸들러 ─────────────────────────────────────────────
function startReview(): void {
  if (!currentItem) return;
  stream.reset();
  stream.renderWaitingForChanges();
  setReviewState('loading');
  const summary: ReviewItemSummary = hasChanges(currentItem)
    ? stripChanges(currentItem)
    : currentItem;
  window.electronAPI.startReview({ item: summary });
}

function stripChanges(it: ReviewItemWithChanges): ReviewItemSummary {
  const { changes: _changes, ...rest } = it;
  void _changes;
  return rest;
}

btnReview.addEventListener('click', startReview);
btnRetry.addEventListener('click', startReview);

btnAbort.addEventListener('click', () => {
  window.electronAPI.abortReview();
  setReviewState('idle');
});

btnComment.addEventListener('click', () => { void postComment(); });

async function postComment(): Promise<void> {
  if (!currentItem) return;
  const body = stream.getFullText().trim();
  if (!body) return;
  const original = btnComment.innerHTML;
  btnComment.disabled = true;
  btnComment.innerHTML = '<span class="spinner"></span><span>등록 중…</span>';
  try {
    const result: CommentPostResult = await window.electronAPI.postComment({
      gitConfigId: currentItem.gitConfigId,
      projectId: currentItem.projectId,
      repoFullName: currentItem.repoFullName,
      itemId: currentItem.itemId,
      body,
    });
    if (result.success) {
      btnComment.innerHTML = '<span>등록 완료</span>';
      setTimeout(() => {
        btnComment.innerHTML = original;
        btnComment.disabled = false;
      }, 1600);
    } else {
      errorMsg.textContent = `댓글 등록 실패: ${result.error ?? '알 수 없는 오류'}`;
      errorBox.hidden = false;
      btnComment.innerHTML = original;
      btnComment.disabled = false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMsg.textContent = `IPC 오류: ${msg}`;
    errorBox.hidden = false;
    btnComment.innerHTML = original;
    btnComment.disabled = false;
  }
}

// ── 키보드 단축키 ───────────────────────────────────────────
document.addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && (reviewState === 'streaming' || reviewState === 'loading')) {
    if (!document.querySelector('.modal-backdrop')) btnAbort.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !btnReview.disabled && !btnReview.hidden) {
    startReview();
  }
});

// ── 부팅 ────────────────────────────────────────────────────
function bootstrap(): void {
  if (!initMarked()) setTimeout(bootstrap, 50);
}
stream.renderInitialEmpty();
bootstrap();
