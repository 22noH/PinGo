// review.ts — Pingo 리뷰 윈도우 엔트리포인트
// MR 헤더 렌더링, 상태 머신, IPC 구독, 버튼 핸들링, diff 모달
// window.electronAPI 타입은 renderer/global.d.ts에서 선언
import type {
  MergeRequestSummary,
  MergeRequestWithChanges,
  MRChange,
  ReviewState,
  ReviewChunkPayload,
  ReviewErrorPayload,
  CommentPostResult,
} from '../../shared/types';
import { initMarked } from './review-markdown';
import { StreamController, type StreamView } from './review-stream';
import { openDiffModal } from './review-diff-modal';

type AnyMr = MergeRequestSummary | MergeRequestWithChanges;

const hasChanges = (mr: AnyMr): mr is MergeRequestWithChanges =>
  'changes' in mr && Array.isArray((mr as MergeRequestWithChanges).changes);

// ── DOM 참조 ─────────────────────────────────────────────────
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
let currentMr: AnyMr | null = null;
let reviewState: ReviewState = 'idle';

const streamView: StreamView = {
  markdown: markdownEl, cursorEl: markdownEl, scroll: scrollEl,
  fileList, fileCount, scrollBtn,
};
const stream = new StreamController(streamView, (change: MRChange) => openDiffModal(change));

// ── MR 헤더 렌더링 ───────────────────────────────────────────
function renderMrHeader(mr: AnyMr): void {
  currentMr = mr;
  mrIid.textContent    = `MR #${mr.iid}`;
  mrTitle.textContent  = mr.title;
  mrBranch.textContent = `${mr.source_branch} → ${mr.target_branch}`;
  mrAuthor.textContent = `@${mr.author.username}`;
  mrLink.href          = mr.web_url;
  document.title = `MR #${mr.iid} — ${mr.title}`;
}

mrLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (currentMr) window.electronAPI.openMrInBrowser(currentMr.web_url);
});

// ── 상태 머신 ────────────────────────────────────────────────
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
    markdownEl.innerHTML = '<div class="row text-secondary"><span class="spinner"></span><span>변경 파일을 불러오는 중…</span></div>';
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
// onMrNew는 2회 발생 — (1) 윈도우 오픈 시 Summary, (2) 리뷰 시작 후 WithChanges
window.electronAPI.onMrNew((mr: AnyMr): void => {
  renderMrHeader(mr);
  if (hasChanges(mr)) {
    stream.setFileList(mr.changes);
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

// ── 버튼 핸들러 ──────────────────────────────────────────────
function startReview(): void {
  if (!currentMr) return;
  stream.reset();
  stream.renderWaitingForChanges();
  setReviewState('loading');
  // summary 형태로 전달 — main이 changes fetch 후 onMrNew(WithChanges) 재전송
  const summary: MergeRequestSummary = hasChanges(currentMr)
    ? stripChanges(currentMr)
    : currentMr;
  window.electronAPI.startReview({ mr: summary });
}

function stripChanges(mr: MergeRequestWithChanges): MergeRequestSummary {
  const { changes: _changes, ...rest } = mr;
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
  if (!currentMr) return;
  const body = stream.getFullText().trim();
  if (!body) return;
  const original = btnComment.innerHTML;
  btnComment.disabled = true;
  btnComment.innerHTML = '<span class="spinner"></span><span>등록 중…</span>';
  try {
    const result: CommentPostResult = await window.electronAPI.postComment({
      projectId: currentMr.project_id,
      iid: currentMr.iid,
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

// ── 키보드 단축키 ────────────────────────────────────────────
document.addEventListener('keydown', (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && (reviewState === 'streaming' || reviewState === 'loading')) {
    if (!document.querySelector('.modal-backdrop')) btnAbort.click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !btnReview.disabled && !btnReview.hidden) {
    startReview();
  }
});

// ── 부팅 ─────────────────────────────────────────────────────
function bootstrap(): void {
  if (!initMarked()) setTimeout(bootstrap, 50);
}
stream.renderInitialEmpty();
bootstrap();
