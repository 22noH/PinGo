// main/notifier.ts — Windows 토스트 알림
import { Notification } from 'electron';
import log from 'electron-log';
import type { MergeRequest, NotificationAction } from '../shared/types';

export type NotificationActionCallback = (
  action: NotificationAction,
  mr: MergeRequest,
) => void;

/**
 * Windows 토스트 알림 발송.
 * macOS/Windows: buttons 배열로 액션 표시, click 이벤트는 body 클릭 fallback.
 * 버튼 클릭 index → NotificationAction 매핑.
 */
export function sendMrNotification(
  mr: MergeRequest,
  onAction: NotificationActionCallback,
): void {
  if (!Notification.isSupported()) {
    log.warn('notifier: Notification not supported on this platform');
    return;
  }

  const title = `새 MR: #${mr.iid}`;
  const body = `${mr.title}\n${mr.author.name} → ${mr.target_branch}`;

  const notification = new Notification({
    title,
    body,
    silent: false,
    actions: [
      { type: 'button', text: 'MR 열기' },
      { type: 'button', text: 'AI 리뷰' },
    ],
  });

  notification.on('action', (_event, index: number) => {
    const action: NotificationAction = index === 1 ? 'review' : 'open';
    log.info(`notifier: action=${action} mr=#${mr.iid}`);
    onAction(action, mr);
  });

  // Windows 는 actions 미지원 환경에서 body 클릭으로 대체
  notification.on('click', () => {
    log.info(`notifier: click (fallback=open) mr=#${mr.iid}`);
    onAction('open', mr);
  });

  notification.on('failed', (_event, error) => {
    log.error(`notifier: show failed mr=#${mr.iid}: ${error}`);
  });

  notification.show();
  log.info(`notifier: shown mr=#${mr.iid}`);
}
