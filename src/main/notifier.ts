// main/notifier.ts — Windows 토스트 알림 (v2)
import { Notification } from 'electron';
import log from 'electron-log';
import type {
  DiscussionNote,
  NotificationAction,
  NotificationReason,
  ReviewItemSummary,
} from '../shared/types';

export type NotificationActionCallback = (
  action: NotificationAction,
  item: ReviewItemSummary,
) => void;

export interface NotificationOptions {
  reason: NotificationReason;
  /** reason === 'new_comments' 일 때 — body 구성에 사용 */
  newNotes?: DiscussionNote[];
}

function buildTitle(item: ReviewItemSummary, reason: NotificationReason): string {
  const prefix = `[${item.providerLabel}]`;
  const typeLabel = item.providerType === 'gitlab' ? 'MR' : 'PR';
  switch (reason) {
    case 'new_item':
      return `${prefix} 새 ${typeLabel}: #${item.itemId}`;
    case 'reviewer_assigned':
      return `${prefix} 리뷰 요청: ${typeLabel} #${item.itemId}`;
    case 'new_comments':
      return `${prefix} 새 댓글: ${typeLabel} #${item.itemId}`;
  }
}

function buildBody(
  item: ReviewItemSummary,
  reason: NotificationReason,
  newNotes?: DiscussionNote[],
): string {
  const header = item.title;
  switch (reason) {
    case 'new_item':
      return `${header}\n${item.author.name}${item.targetBranch ? ` → ${item.targetBranch}` : ''}`;
    case 'reviewer_assigned':
      return `${header}\n작성자: ${item.author.name}`;
    case 'new_comments': {
      const notes = newNotes ?? [];
      const count = notes.length;
      const mentioned = notes.some((n) => n.mentionsCurrentUser);
      const latest = notes[notes.length - 1];
      const authorLine = latest ? `${latest.author.name}: ` : '';
      const preview = latest ? truncate(latest.body, 80) : '';
      const mentionTag = mentioned ? '@ 멘션됨 · ' : '';
      return `${header}\n${mentionTag}새 댓글 ${count}개 — ${authorLine}${preview}`;
    }
  }
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Windows 토스트 알림 발송.
 * reason에 따라 title/body 구성. 버튼은 공통(열기 / AI 리뷰).
 */
export function sendMrNotification(
  item: ReviewItemSummary,
  options: NotificationOptions,
  onAction: NotificationActionCallback,
): void {
  if (!Notification.isSupported()) {
    log.warn('notifier: Notification not supported on this platform');
    return;
  }

  const notification = new Notification({
    title: buildTitle(item, options.reason),
    body: buildBody(item, options.reason, options.newNotes),
    silent: false,
    actions: [
      { type: 'button', text: '열기' },
      { type: 'button', text: 'AI 리뷰' },
    ],
  });

  notification.on('action', (_event, index: number) => {
    const action: NotificationAction = index === 1 ? 'review' : 'open';
    log.info(`notifier: action=${action} reason=${options.reason} item=${item.id}`);
    onAction(action, item);
  });

  notification.on('click', () => {
    log.info(`notifier: click (fallback=open) item=${item.id}`);
    onAction('open', item);
  });

  notification.on('failed', (_event, error) => {
    log.error(`notifier: show failed item=${item.id}: ${error}`);
  });

  notification.show();
  log.info(`notifier: shown reason=${options.reason} item=${item.id}`);
}
