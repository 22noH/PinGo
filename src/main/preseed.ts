// main/preseed.ts — silent pre-seed (대량 재알림 방지)
import log from 'electron-log';
import type Store from 'electron-store';
import type { StoreSchema } from '../shared/types';
import { MAX_SEEN_ITEM_IDS } from '../shared/constants';
import type { GitProvider } from './providers/git/git-provider';
import type { PollerSeenState } from './poller';

/**
 * 현재 open 상태인 항목들을 seen 상태에 선-등록 (알림/렌더러 이벤트 없이).
 * seenItems, reviewerAssigned 두 축을 모두 채운다. lastSeenNoteAt 은 poller가 자체적으로
 * 첫 조회 시 seed 하므로 여기서는 건드리지 않음.
 *
 * 사용 시점:
 *   1) v1→v2 migrate 직후 — seenItemIds가 [] 이므로 첫 폴링에서 모든 open MR이 "새로운"으로 감지됨
 *   2) 신규 Git 연결 추가 직후 — 해당 연결의 기존 항목이 전부 신규로 잡히지 않도록
 */
export async function silentPreSeed(
  store: Store<StoreSchema>,
  seen: PollerSeenState,
  providers: GitProvider[],
): Promise<void> {
  if (providers.length === 0) return;
  log.info(`preseed: starting (providers=${providers.length})`);
  const results = await Promise.allSettled(
    providers.map((p) => p.fetchOpenItems()),
  );

  let added = 0;
  let reviewerAdded = 0;
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const provider = providers[i];
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (!seen.items.has(item.id)) {
        seen.items.add(item.id);
        added += 1;
      }
      if (provider.isCurrentUserReviewer(item) && !seen.reviewerAssigned.has(item.id)) {
        seen.reviewerAssigned.add(item.id);
        reviewerAdded += 1;
      }
    }
  }
  store.set('seenItemIds', Array.from(seen.items).slice(-MAX_SEEN_ITEM_IDS));
  store.set('seenReviewerItemIds', Array.from(seen.reviewerAssigned).slice(-MAX_SEEN_ITEM_IDS));
  log.info(`preseed: done — items=${added}, reviewer=${reviewerAdded}`);
}
