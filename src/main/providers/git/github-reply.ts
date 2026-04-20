// providers/git/github-reply.ts — GitHub postReply (§20.13.I5)
// review_thread vs issue_comment 분기 + quote fallback.
import type { AxiosInstance } from 'axios';
import log from 'electron-log';
import type {
  CommentPostResult,
  CommentReplyPayload,
  ReviewItemSummary,
} from '../../../shared/types';

function buildQuotedBody(payload: CommentReplyPayload): string {
  // backtick wrap 으로 GitHub mention 재발화 차단 (§20.13.I5 Phase 4 B2)
  const author = payload.quoteAuthor ? `\`@${payload.quoteAuthor}\`` : '';
  const snippetLines = (payload.quoteSnippet ?? '').split(/\r?\n/).slice(0, 3);
  const quote = snippetLines
    .filter((l) => l.length > 0)
    .map((l) => `> ${l}`)
    .join('\n');
  const header = [author, quote].filter(Boolean).join('\n');
  return header ? `${header}\n\n${payload.body}` : payload.body;
}

async function postIssueCommentFallback(
  client: AxiosInstance,
  repoPath: string,
  item: ReviewItemSummary,
  payload: CommentReplyPayload,
): Promise<CommentPostResult> {
  const body = buildQuotedBody(payload);
  try {
    const res = await client.post<{ id: number }>(
      `/repos/${repoPath}/issues/${item.itemId}/comments`,
      { body },
    );
    return { success: true, commentId: String(res.data.id) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`github: issue comment fallback failed: ${msg.slice(0, 200)}`);
    return { success: false, error: 'reply_failed' };
  }
}

/**
 * GitHub postReply (§20.13.I5):
 *  - threadContext === 'review_thread': replies API 만 사용, 실패는 에러.
 *  - threadContext === 'issue_comment': quote 로 새 issue comment 작성.
 *  - undefined: replies API 시도 → 실패 시 issue quote fallback.
 *
 * GitHub 일반 issue comment 에는 "reply 전용 API" 가 없으므로 quote 기반 새 comment 로 대체.
 */
export async function postReply(
  client: AxiosInstance,
  item: ReviewItemSummary,
  payload: CommentReplyPayload,
): Promise<CommentPostResult> {
  const repoPath = item.repoFullName ?? '';
  if (!repoPath) return { success: false, error: 'GitHub 답글에는 repoFullName 필요' };

  if (payload.threadContext === 'issue_comment') {
    return postIssueCommentFallback(client, repoPath, item, payload);
  }

  const commentIdNum = Number(payload.discussionId);
  if (Number.isFinite(commentIdNum) && commentIdNum > 0) {
    try {
      const res = await client.post<{ id: number }>(
        `/repos/${repoPath}/pulls/${item.itemId}/comments/${commentIdNum}/replies`,
        { body: payload.body },
      );
      return { success: true, commentId: String(res.data.id) };
    } catch (err) {
      if (payload.threadContext === 'review_thread') {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`github: review_thread reply failed: ${msg.slice(0, 200)}`);
        return { success: false, error: 'reply_failed' };
      }
      log.warn(
        `github: reply endpoint failed, falling back to issue comment: ${String(err).slice(0, 200)}`,
      );
    }
  }
  return postIssueCommentFallback(client, repoPath, item, payload);
}
