// main/poller-events.ts — v3 이벤트 검출 (pipeline / approval / issues)
// poller.ts 본문에서 호출되며 300줄 제한을 지키기 위해 분리.
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AppSettings,
  ApprovalStatus,
  ItemEvent,
  PipelineInfo,
  ReviewItemSummary,
  StoreSchema,
} from '../shared/types';
import {
  MAX_SEEN_APPROVAL_ITEM_IDS,
  MAX_SEEN_PIPELINE_IDS,
} from '../shared/constants';
import type { GitProvider } from './providers/git/git-provider';

/** FIFO cap 유지 — O(n) 단방향 */
function capTail(list: string[], max: number): string[] {
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}

function pipelineCompositeId(gitConfigId: string, projectId: number, pipelineId: number): string {
  return `${gitConfigId}::${projectId}::${pipelineId}`;
}

/**
 * 파이프라인 완료 이벤트 감지.
 * provider.fetchRecentPipelines() 응답을 seenPipelineIds 와 비교 → 신규만 이벤트 방출.
 * 대응 item 은 lastOpenItems 에서 ref=sourceBranch 기준 매칭 (없으면 스킵).
 */
export async function detectPipelineEvents(
  providers: GitProvider[],
  openItems: ReviewItemSummary[],
  store: Store<StoreSchema>,
  signal?: AbortSignal,
): Promise<ItemEvent[]> {
  const events: ItemEvent[] = [];
  const seen = new Set(store.get('seenPipelineIds') ?? []);

  for (const provider of providers) {
    if (!provider.fetchRecentPipelines) continue;
    try {
      const pipelines = await provider.fetchRecentPipelines(signal);
      for (const pl of pipelines) {
        const match = openItems.find(
          (it) => it.gitConfigId === provider.config.id && it.sourceBranch === pl.ref,
        );
        if (!match) continue;
        const cid = pipelineCompositeId(match.gitConfigId, match.projectId, pl.id);
        if (seen.has(cid)) continue;
        seen.add(cid);
        events.push({ kind: 'pipeline_finished', item: match, pipelineInfo: pl });
      }
    } catch (err) {
      log.warn(`poller-events: pipelines fetch failed (${provider.config.type}): ${String(err).slice(0, 200)}`);
    }
  }

  if (events.length > 0) {
    const next = capTail(Array.from(seen), MAX_SEEN_PIPELINE_IDS);
    store.set('seenPipelineIds', next);
  }
  return events;
}

interface ApprovalSnapshot {
  itemId: string;
  status: ApprovalStatus;
}

function snapshotToKind(
  prev: ApprovalStatus | undefined,
  next: ApprovalStatus,
): 'mr_approved' | 'changes_requested' | null {
  const wasApproved = prev?.approved ?? false;
  const wasChangesReq = prev?.changesRequested ?? false;
  if (next.approved && !wasApproved) return 'mr_approved';
  if (next.changesRequested && !wasChangesReq) return 'changes_requested';
  return null;
}

/**
 * 승인/변경요청 이벤트 감지.
 * 현재 tick 의 ApprovalStatus 를 seenApprovalItemIds 로 중복 제거.
 * 내부 상태(approvedBy 집합)는 저장하지 않고 id 집합만 유지 — architect 요구사항 준수.
 */
export async function detectApprovalEvents(
  providers: GitProvider[],
  openItems: ReviewItemSummary[],
  store: Store<StoreSchema>,
  signal?: AbortSignal,
): Promise<ItemEvent[]> {
  const events: ItemEvent[] = [];
  const seen = new Set(store.get('seenApprovalItemIds') ?? []);
  const providerById = new Map(providers.map((p) => [p.config.id, p]));
  const snapshots: ApprovalSnapshot[] = [];

  for (const item of openItems) {
    const provider = providerById.get(item.gitConfigId);
    if (!provider?.fetchApprovalStatus) continue;
    try {
      const status = await provider.fetchApprovalStatus(item, signal);
      snapshots.push({ itemId: item.id, status });
    } catch (err) {
      log.warn(`poller-events: approval fetch failed (${item.id}): ${String(err).slice(0, 200)}`);
    }
  }

  for (const snap of snapshots) {
    const item = openItems.find((i) => i.id === snap.itemId);
    if (!item) continue;
    const kind = snapshotToKind(undefined, snap.status);
    if (!kind) continue;
    if (seen.has(snap.itemId)) continue;
    seen.add(snap.itemId);
    events.push({ kind, item, approvalStatus: snap.status });
  }

  if (events.length > 0) {
    const next = capTail(Array.from(seen), MAX_SEEN_APPROVAL_ITEM_IDS);
    store.set('seenApprovalItemIds', next);
  }
  return events;
}

/**
 * pipeline + approval 이벤트 검출 통합 — poller.ts 에서 호출.
 * AppSettings 의 pipelineNotificationsEnabled / approvalNotificationsEnabled 플래그를
 * 검사하여 false 인 경우 해당 종류 fetch 자체를 skip (§Phase 4 M1).
 * 미정의(undefined) 는 default true 로 간주 — v2 저장소 하위호환.
 */
export async function detectV3ItemEvents(
  providers: GitProvider[],
  openItems: ReviewItemSummary[],
  store: Store<StoreSchema>,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<ItemEvent[]> {
  const pipelineOn = settings.pipelineNotificationsEnabled !== false;
  const approvalOn = settings.approvalNotificationsEnabled !== false;
  const [pl, ap] = await Promise.all([
    pipelineOn ? detectPipelineEvents(providers, openItems, store, signal) : Promise.resolve([]),
    approvalOn ? detectApprovalEvents(providers, openItems, store, signal) : Promise.resolve([]),
  ]);
  return [...pl, ...ap];
}

export { type PipelineInfo, type ApprovalStatus };
