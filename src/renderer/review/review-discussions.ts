// review-discussions.ts — 토론 스레드 + 인라인 답글(Reply) UI
// review.ts 에서 discussions 도착 시 호출. COMMENT_REPLY IPC 사용.
// strict mode — no `any`, no console.log, XSS 방어 (textContent 만)
import type {
  CommentReplyPayload,
  CommentReplyResult,
  Discussion,
  DiscussionNote,
  ReviewItemSummary,
} from '../../shared/types';

export interface DiscussionsViewContext {
  /** 현재 리뷰 대상 아이템 (reply payload 조립에 사용) */
  item: ReviewItemSummary;
}

/** discussions 를 thread-list 컨테이너에 렌더한다. 기존 내용은 교체됨. */
export function renderDiscussions(
  container: HTMLUListElement,
  countEl: HTMLElement | null,
  section: HTMLElement,
  discussions: Discussion[],
  ctx: DiscussionsViewContext,
): void {
  container.innerHTML = '';
  section.hidden = discussions.length === 0;
  if (countEl) countEl.textContent = String(discussions.length);
  if (discussions.length === 0) return;
  for (const d of discussions) container.appendChild(renderThread(d, ctx));
}

function renderThread(thread: Discussion, ctx: DiscussionsViewContext): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'thread-item';
  li.dataset.threadId = thread.id;

  for (const note of thread.notes) li.appendChild(renderNote(note));

  // Reply toggle / composer
  const actions = document.createElement('div');
  actions.style.padding = 'var(--space-2) var(--space-4) var(--space-3)';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'reply-toggle';
  toggle.textContent = '↩︎ 답글';
  actions.appendChild(toggle);
  li.appendChild(actions);

  const composer = buildComposer(thread.id, ctx, thread.notes[0]);
  composer.hidden = true;
  li.appendChild(composer);

  toggle.addEventListener('click', (): void => {
    const showing = !composer.hidden;
    composer.hidden = showing;
    toggle.textContent = showing ? '↩︎ 답글' : '✕ 닫기';
    if (!showing) {
      const ta = composer.querySelector('textarea');
      if (ta instanceof HTMLTextAreaElement) ta.focus();
    }
  });

  return li;
}

function renderNote(note: DiscussionNote): HTMLElement {
  const row = document.createElement('div');
  row.className = 'thread-note';

  const avatar = document.createElement('div');
  avatar.className = 'thread-note-avatar';
  if (note.author.avatar_url) {
    avatar.style.backgroundImage = `url(${cssUrl(note.author.avatar_url)})`;
    avatar.style.backgroundSize = 'cover';
    avatar.style.backgroundPosition = 'center';
  }
  row.appendChild(avatar);

  const body = document.createElement('div');
  body.className = 'thread-note-body';

  const head = document.createElement('div');
  head.className = 'thread-note-head';
  const name = document.createElement('span');
  name.className = 'thread-note-author';
  name.textContent = note.author.name || note.author.username;
  const time = document.createElement('span');
  time.className = 'thread-note-time';
  time.textContent = formatTime(note.createdAt);
  head.appendChild(name);
  head.appendChild(time);
  if (note.mentionsCurrentUser) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-info';
    badge.textContent = '@멘션';
    head.appendChild(badge);
  }
  body.appendChild(head);

  const text = document.createElement('div');
  text.className = 'thread-note-text';
  text.textContent = note.body;
  body.appendChild(text);

  row.appendChild(body);
  return row;
}

function buildComposer(
  discussionId: string,
  ctx: DiscussionsViewContext,
  originalNote: DiscussionNote | undefined,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'reply-composer';

  const ta = document.createElement('textarea');
  ta.className = 'textarea';
  ta.placeholder = '답글 내용…';
  ta.spellcheck = true;
  wrap.appendChild(ta);

  const feedback = document.createElement('span');
  feedback.className = 'action-feedback is-info';
  feedback.hidden = true;
  wrap.appendChild(feedback);

  const actions = document.createElement('div');
  actions.className = 'reply-composer-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost btn-sm';
  cancel.textContent = '취소';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary btn-sm';
  submit.textContent = '답글 등록';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  wrap.appendChild(actions);

  cancel.addEventListener('click', (): void => {
    ta.value = '';
    feedback.hidden = true;
    wrap.hidden = true;
    // 상위 toggle 버튼 라벨 원복
    const parent = wrap.parentElement;
    const togglers = parent?.querySelectorAll<HTMLButtonElement>('.reply-toggle');
    if (togglers && togglers.length > 0) togglers[0].textContent = '↩︎ 답글';
  });

  submit.addEventListener('click', (): void => { void send(); });

  async function send(): Promise<void> {
    const body = ta.value.trim();
    if (!body) {
      showFeedback('error', '답글 내용을 입력하세요.');
      return;
    }
    submit.disabled = true;
    showFeedback('info', '등록 중…');
    const payload: CommentReplyPayload = {
      gitConfigId: ctx.item.gitConfigId,
      itemId: ctx.item.itemId,
      projectId: ctx.item.projectId,
      repoFullName: ctx.item.repoFullName,
      body,
      discussionId,
      threadContext: ctx.item.providerType === 'gitlab' ? 'review_thread' : undefined,
      quoteAuthor: originalNote?.author.name || originalNote?.author.username || undefined,
      quoteSnippet: originalNote?.body || undefined,
    };
    try {
      const r: CommentReplyResult = await window.electronAPI.postCommentReply(payload);
      if (r.success) {
        showFeedback('success', '답글이 등록되었습니다.');
        ta.value = '';
      } else {
        showFeedback('error', `실패: ${r.error ?? '알 수 없음'}`);
      }
    } catch (err) {
      showFeedback('error', `IPC 오류: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      submit.disabled = false;
    }
  }

  function showFeedback(kind: 'success' | 'error' | 'info', text: string): void {
    feedback.className = `action-feedback is-${kind}`;
    feedback.textContent = text;
    feedback.hidden = false;
  }

  return wrap;
}

// ── 헬퍼 ─────────────────────────────────────────────────────
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return d.toISOString().slice(0, 10);
}

/** CSS url(...) 안에 들어갈 문자열을 안전하게 인코딩 — `"` 백슬래시 이스케이프 */
function cssUrl(raw: string): string {
  const escaped = raw.replace(/["\\]/g, (c) => `\\${c}`);
  return `"${escaped}"`;
}
