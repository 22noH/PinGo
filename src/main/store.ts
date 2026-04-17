// main/store.ts — electron-store 초기화 (v2, loose schema)
import Store from 'electron-store';
import type { StoreSchema } from '../shared/types';
import { MIN_POLL_INTERVAL_MS } from '../shared/constants';
import { DEFAULT_V2_SETTINGS, migrateStoreV1ToV2 } from './store-migrate';

/**
 * electron-store는 JSON Schema validation이 엄격합니다. v2의 union 타입
 * (`GitConfig` / `AIConfig`)을 JSON Schema로 표현하면 장황하고 에러 메시지가
 * 나쁘므로 loose schema만 유지 — 디스크 파손/외부 편집에 대한 최소 방어선.
 * union 내부 구조는 TS 타입 + 런타임 guard(store-migrate.ts)로 보증.
 *
 * TODO (v3): token은 현재 평문 저장. OS keychain 연동(keytar) 검토.
 */
export function createStore(): Store<StoreSchema> {
  const store = new Store<StoreSchema>({
    name: 'pingo-config',
    defaults: {
      settings: DEFAULT_V2_SETTINGS,
      seenItemIds: [],
      seenReviewerItemIds: [],
      lastSeenNoteAt: {},
      interactions: {},
      recentItems: [],
    },
    schema: {
      settings: { type: 'object' },
      seenItemIds: {
        type: 'array',
        items: { type: 'string' },
      },
      seenReviewerItemIds: {
        type: 'array',
        items: { type: 'string' },
      },
      lastSeenNoteAt: {
        type: 'object',
      },
      interactions: {
        type: 'object',
      },
      recentItems: {
        type: 'array',
        maxItems: 50,
        items: { type: 'object' },
      },
    },
  });
  migrateStoreV1ToV2(store);
  // pollIntervalMs 방어 — loose schema에서는 validation 없음 → 런타임 clamp
  const s = store.get('settings');
  if (s.pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    store.set('settings', { ...s, pollIntervalMs: MIN_POLL_INTERVAL_MS });
  }
  return store;
}
