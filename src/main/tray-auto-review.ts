// main/tray-auto-review.ts — 트레이 "🧠 자동 리뷰" 서브메뉴 (순수 로직: Electron 타입만 참조)
//
// 자동 리뷰는 백그라운드라 "N건 진행 중" 한 줄로는 뭘 하는지 모른다.
// 항목별 단계·경과 시간, 대기열 순번, 최근 결과(성공/실패+사유)를 보여준다.
import type { MenuItemConstructorOptions } from 'electron';
import type { ReviewItemSummary } from '../shared/types';
import type { AutoReviewKind, AutoReviewStatus } from './auto-review/status';

const MAX_RECENT_IN_MENU = 8;
const MAX_TITLE = 40;

export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${hr}시간 ${rem}분` : `${hr}시간`;
}

const kindLabel = (kind: AutoReviewKind): string => (kind === 'verify' ? '해결 검증' : '전체 리뷰');

function itemLabel(item: ReviewItemSummary): string {
  const title = item.title.length > MAX_TITLE ? `${item.title.slice(0, MAX_TITLE)}…` : item.title;
  return `#${item.itemId} ${title}`;
}

/**
 * 서브메뉴 항목을 만든다. 보여줄 게 없으면 null.
 * @param now  경과 시간 계산 기준 (테스트에서 고정)
 * @param onOpen 항목 클릭 → MR/PR 열기
 */
export function buildAutoReviewMenu(
  status: AutoReviewStatus,
  now: number,
  onOpen: (item: ReviewItemSummary) => void,
): MenuItemConstructorOptions | null {
  const { active, queued, recent } = status;
  if (active.length === 0 && queued.length === 0 && recent.length === 0) return null;

  const sub: MenuItemConstructorOptions[] = [];
  if (active.length > 0) {
    sub.push({ label: '진행 중', enabled: false });
    for (const a of active) {
      sub.push({
        label: `  ${itemLabel(a.item)} — ${kindLabel(a.kind)}: ${a.phase} (${formatElapsed(now - a.startedAt)})`,
        click: (): void => onOpen(a.item),
      });
    }
  }
  if (queued.length > 0) {
    if (sub.length > 0) sub.push({ type: 'separator' });
    sub.push({ label: `대기열 (${queued.length})`, enabled: false });
    queued.forEach((q, i) => {
      sub.push({
        label: `  ${i + 1}. ${itemLabel(q.item)} — ${kindLabel(q.kind)}`,
        click: (): void => onOpen(q.item),
      });
    });
  }
  if (recent.length > 0) {
    if (sub.length > 0) sub.push({ type: 'separator' });
    sub.push({ label: `최근 결과 (${recent.length})`, enabled: false });
    for (const r of recent.slice(0, MAX_RECENT_IN_MENU)) {
      sub.push({
        label: `  ${r.ok ? '✅' : '❌'} ${itemLabel(r.item)} — ${r.summary.slice(0, 60)} (${formatElapsed(now - r.at)} 전)`,
        click: (): void => onOpen(r.item),
      });
    }
  }

  const head: string[] = [];
  if (active.length > 0) head.push(`${active.length}건 진행 중`);
  if (queued.length > 0) head.push(`대기 ${queued.length}`);
  if (head.length === 0) head.push(`최근 결과 ${recent.length}건`);
  return { label: `🧠 자동 리뷰 ${head.join(', ')}`, submenu: sub };
}
