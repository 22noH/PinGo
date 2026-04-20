// review-comment.ts — GitLab/GitHub 댓글 등록 로직 (review.ts 보조)
// strict mode — no `any`, no console.log
import type { CommentPostResult, ReviewItemSummary, ReviewState } from '../../shared/types';

export interface PostCommentArgs {
  item: ReviewItemSummary;
  body: string;
  btn: HTMLButtonElement;
  errorBox: HTMLElement;
  errorMsg: HTMLElement;
  /** 완료 후 btn.disabled 상태를 결정하기 위한 현재 reviewState getter */
  getReviewState: () => ReviewState;
}

export async function postCommentAction(a: PostCommentArgs): Promise<void> {
  if (!a.body) return;
  const original = a.btn.innerHTML;
  a.btn.disabled = true;
  a.btn.innerHTML = '<span class="spinner"></span><span>등록 중…</span>';
  try {
    const result: CommentPostResult = await window.electronAPI.postComment({
      gitConfigId: a.item.gitConfigId,
      projectId: a.item.projectId,
      repoFullName: a.item.repoFullName,
      itemId: a.item.itemId,
      body: a.body,
    });
    if (result.success) {
      a.btn.innerHTML = '<span>등록 완료</span>';
      window.setTimeout((): void => {
        a.btn.innerHTML = original;
        a.btn.disabled = a.getReviewState() !== 'done';
      }, 1600);
    } else {
      a.errorMsg.textContent = `댓글 등록 실패: ${result.error ?? '알 수 없는 오류'}`;
      a.errorBox.hidden = false;
      a.btn.innerHTML = original;
      a.btn.disabled = false;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    a.errorMsg.textContent = `IPC 오류: ${msg}`;
    a.errorBox.hidden = false;
    a.btn.innerHTML = original;
    a.btn.disabled = false;
  }
}
