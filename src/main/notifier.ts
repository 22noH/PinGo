// main/notifier.ts — Windows 토스트 알림 (v2)
import { Notification } from 'electron';
import log from 'electron-log';
import type { NotificationAction, ReviewItemSummary } from '../shared/types';

export type NotificationActionCallback = (
  action: NotificationAction,
  item: ReviewItemSummary,
) => void;

/**
 * Windows 토스트 알림 발송.
 * macOS/Windows: buttons 배열로 액션 표시, click 이벤트는 body 클릭 fallback.
 * 버튼 클릭 index → NotificationAction 매핑.
 */
export function sendMrNotification(
  item: ReviewItemSummary,
  onAction: NotificationActionCallback,
): void {
  if (!Notification.isSupported()) {
    log.warn('notifier: Notification not supported on this platform');
    return;
  }

  const prefix = `[${item.providerLabel}]`;
  const title = `${prefix} 새 ${item.providerType === 'gitlab' ? 'MR' : 'PR'}: #${item.itemId}`;
  const body = `${item.title}\n${item.author.name}${item.targetBranch ? ` → ${item.targetBranch}` : ''}`;

  const notification = new Notification({
    title,
    body,
    silent: false,
    actions: [
      { type: 'button', text: '열기' },
      { type: 'button', text: 'AI 리뷰' },
    ],
  });

  notification.on('action', (_event, index: number) => {
    const action: NotificationAction = index === 1 ? 'review' : 'open';
    log.info(`notifier: action=${action} item=${item.id}`);
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
  log.info(`notifier: shown item=${item.id}`);
}
