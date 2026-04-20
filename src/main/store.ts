// main/store.ts — electron-store 초기화 (v2 + v3 확장, loose schema)
import Store from 'electron-store';
import type { StoreSchema } from '../shared/types';
import { MIN_POLL_INTERVAL_MS } from '../shared/constants';
import {
  DEFAULT_V2_SETTINGS,
  migrateStoreV1ToV2,
  migrateStoreV2ToV3,
} from './store-migrate';

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
      // v3 확장 — optional 이지만 defaults로 항상 존재하도록 초기화
      seenJiraIssueIds: [],
      recentJiraIssues: [],
      seenPipelineIds: [],
      seenApprovalItemIds: [],
      // jiraWebhookToken: migrateStoreV2ToV3 에서 crypto.randomBytes(32).toString('hex') 로 주입.
      jiraWebhookToken: '',
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
      // v3 loose schema
      seenJiraIssueIds: {
        type: 'array',
        items: { type: 'string' },
      },
      recentJiraIssues: {
        type: 'array',
        maxItems: 50,
        items: { type: 'object' },
      },
      seenPipelineIds: {
        type: 'array',
        items: { type: 'string' },
      },
      seenApprovalItemIds: {
        type: 'array',
        items: { type: 'string' },
      },
      jiraWebhookToken: { type: 'string' },
    },
  });
  migrateStoreV1ToV2(store);
  migrateStoreV2ToV3(store);
  // pollIntervalMs 방어 — loose schema에서는 validation 없음 → 런타임 clamp
  const s = store.get('settings');
  if (s.pollIntervalMs < MIN_POLL_INTERVAL_MS) {
    store.set('settings', { ...s, pollIntervalMs: MIN_POLL_INTERVAL_MS });
  }
  return store;
}
