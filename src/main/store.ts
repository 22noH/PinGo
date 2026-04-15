// main/store.ts — electron-store 초기화
import Store from 'electron-store';
import type { AppSettings, StoreSchema } from '../shared/types';
import { DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS } from '../shared/constants';

export const DEFAULT_SETTINGS: AppSettings = {
  gitlabUrl: '',
  token: '',
  userId: 0,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  notificationEnabled: true,
};

export function createStore(): Store<StoreSchema> {
  // TODO (v2): token은 현재 평문 저장. v2에서 OS keychain 연동 (keytar)으로 대체.
  return new Store<StoreSchema>({
    name: 'pingo-config',
    defaults: {
      settings: DEFAULT_SETTINGS,
      seenMrIds: [],
      recentMrs: [],
    },
    schema: {
      settings: {
        type: 'object',
        properties: {
          gitlabUrl: { type: 'string' },
          token: { type: 'string' },
          userId: { type: 'number' },
          pollIntervalMs: { type: 'number', minimum: MIN_POLL_INTERVAL_MS },
          notificationEnabled: { type: 'boolean' },
        },
        required: [
          'gitlabUrl',
          'token',
          'userId',
          'pollIntervalMs',
          'notificationEnabled',
        ],
      },
      seenMrIds: {
        type: 'array',
        items: { type: 'number' },
      },
      recentMrs: {
        type: 'array',
        maxItems: 5,
        items: { type: 'object' },
      },
    },
  });
}
