// main/preseed.ts — silent pre-seed (대량 재알림 방지)
import log from 'electron-log';
import type Store from 'electron-store';
import type { StoreSchema } from '../shared/types';
import { MAX_SEEN_ITEM_IDS } from '../shared/constants';
import type { GitProvider } from './providers/git/git-provider';

/**
 * 현재 open 상태인 항목들을 seenItemIds 에 선-등록 (알림/렌더러 이벤트 없이).
 *
 * 사용 시점:
 *   1) v1→v2 migrate 직후 — seenItemIds가 [] 이므로 첫 폴링에서 모든 open MR이 "새로운"으로 감지됨
 *   2) 신규 Git 연결 추가 직후 — 해당 연결의 기존 항목이 전부 신규로 잡히지 않도록
 *
 * architect REVISION 5 §6.1.1 정책.
 */
export async function silentPreSeed(
  store: Store<StoreSchema>,
  seenIds: Set<string>,
  providers: GitProvider[],
): Promise<void> {
  if (providers.length === 0) return;
  log.info(`preseed: starting (providers=${providers.length})`);
  const results = await Promise.allSettled(
    providers.map((p) => p.fetchOpenItems()),
  );
  let added = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        added += 1;
      }
    }
  }
  store.set('seenItemIds', Array.from(seenIds).slice(-MAX_SEEN_ITEM_IDS));
  log.info(`preseed: done — ${added} items seeded`);
}
