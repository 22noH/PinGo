// review-state.ts — ReviewState 머신 + badge 라벨/클래스 (review.ts 보조)
// strict mode — no `any`, no console.log
import type { ReviewState } from '../../shared/types';

export interface StateRefs {
  stateBadge: HTMLElement;
  idleBox: HTMLElement;
  markdownEl: HTMLElement;
  errorBox: HTMLElement;
  btnReview: HTMLButtonElement;
  btnAbort: HTMLButtonElement;
  btnRetry: HTMLButtonElement;
  btnEdit: HTMLButtonElement;
  btnSaveEdit: HTMLButtonElement;
  btnCancelEdit: HTMLButtonElement;
  btnComment: HTMLButtonElement;
  editArea: HTMLTextAreaElement;
}

const STATE_LABEL: Record<ReviewState, string> = {
  idle: '대기', loading: '준비', streaming: '진행 중', done: '완료', error: '오류',
};
const STATE_CLASS: Record<ReviewState, string> = {
  idle: 'badge-muted',
  loading: 'badge-info',
  streaming: 'badge-info',
  done: 'badge-add',
  error: 'badge-del',
};

export function applyReviewState(refs: StateRefs, next: ReviewState): void {
  refs.stateBadge.className = 'badge ' + STATE_CLASS[next];
  refs.stateBadge.textContent = STATE_LABEL[next];

  const streaming = next === 'loading' || next === 'streaming';
  refs.btnReview.hidden = streaming;
  refs.btnAbort.hidden  = !streaming;
  refs.btnRetry.hidden  = !(next === 'error' || next === 'done');
  refs.btnEdit.hidden   = next !== 'done';
  refs.btnComment.disabled = next !== 'done';
  if (next !== 'done') {
    refs.btnSaveEdit.hidden = true;
    refs.btnCancelEdit.hidden = true;
    refs.editArea.hidden = true;
  }

  if (next === 'idle') {
    refs.idleBox.hidden = false;
    refs.markdownEl.hidden = true;
    refs.errorBox.hidden = true;
  } else if (next === 'loading') {
    refs.idleBox.hidden = true;
    refs.errorBox.hidden = true;
    refs.markdownEl.hidden = false;
    refs.markdownEl.innerHTML =
      '<div class="row text-secondary"><span class="spinner"></span><span>변경 파일을 불러오는 중…</span></div>';
  } else if (next === 'streaming') {
    refs.errorBox.hidden = true;
    refs.idleBox.hidden = true;
  } else if (next === 'done') {
    refs.idleBox.hidden = true;
    refs.errorBox.hidden = true;
    refs.btnRetry.textContent = '다시 리뷰';
  } else if (next === 'error') {
    refs.btnRetry.textContent = '다시 시도';
  }
}
