// main/store-migrate.ts — v1 → v2 AppSettings 마이그레이션
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AIConfig,
  AppSettings,
  GitLabConfig,
  StoreSchema,
  V1AppSettings,
} from '../shared/types';
import { DEFAULT_POLL_INTERVAL_MS } from '../shared/constants';

const DEFAULT_AI: AIConfig = { type: 'claude-cli' };

export const DEFAULT_V2_SETTINGS: AppSettings = {
  gitConnections: [],
  ai: DEFAULT_AI,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  notificationEnabled: true,
};

/**
 * v1 AppSettings 감지용 타입 가드.
 * v1의 식별 필드(`gitlabUrl/token/userId`) 존재 + v2의 `gitConnections` 부재로 구분.
 */
export function isV1Settings(raw: unknown): raw is V1AppSettings {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'gitlabUrl' in raw &&
    'token' in raw &&
    'userId' in raw &&
    !('gitConnections' in raw)
  );
}

/**
 * v1 → v2 마이그레이션.
 *
 * 정책 (architect REVISION 5 §6.1.1):
 *   - seenMrIds (number[]) 는 복합키 체계(`::` delimiter)와 호환 불가 → `[]` 로 초기화
 *   - recentMrs 는 필수 필드(`gitConfigId/providerType/providerLabel`) 없음 → `[]` 로 초기화
 *   - 재알림 위험은 main.ts 부트스트랩에서 silent pre-seed 로 완화
 */
export function migrateStoreV1ToV2(store: Store<StoreSchema>): void {
  const rawSettings = store.get('settings') as unknown;

  if (!isV1Settings(rawSettings)) {
    // 이미 v2 또는 비어있는 상태 — defaults 채움 (electron-store 기본값이 없는 구버전 대비)
    if (rawSettings === undefined) {
      store.set('settings', DEFAULT_V2_SETTINGS);
    }
    return;
  }

  log.info('[migrate] v1 AppSettings detected → converting to v2');
  const v1 = rawSettings;

  const newConnection: GitLabConfig | null =
    v1.gitlabUrl && v1.token && v1.userId
      ? {
          type: 'gitlab',
          id: randomUUID(),
          url: v1.gitlabUrl,
          token: v1.token,
          userId: v1.userId,
        }
      : null;

  const v2Settings: AppSettings = {
    gitConnections: newConnection ? [newConnection] : [],
    ai: DEFAULT_AI,
    pollIntervalMs: v1.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    notificationEnabled: v1.notificationEnabled ?? true,
  };

  store.set('settings', v2Settings);
  store.set('seenItemIds', []);   // 복합 키 체계로 재시작
  store.set('recentItems', []);
  store.delete('seenMrIds' as keyof StoreSchema);
  store.delete('recentMrs' as keyof StoreSchema);

  log.info(
    `[migrate] completed — gitConnections=${v2Settings.gitConnections.length}`,
  );
}
