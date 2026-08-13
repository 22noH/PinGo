// main/ipc-review.ts — 리뷰 관련 IPC 로직 (REVIEW_START 핸들러)
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  ReviewChunkPayload,
  ReviewDonePayload,
  ReviewErrorPayload,
  ReviewStartPayload,
  StoreSchema,
} from '../shared/types';
import {
  ITEM_NEW,
  REVIEW_CHUNK,
  REVIEW_DONE,
  REVIEW_ERROR,
} from '../shared/constants';
import { createAIProvider } from './providers/ai/ai-provider';
import { createGitProvider } from './providers/git/git-provider';
import { prepareWorkspace } from './auto-review';
import { buildPrompt, runReview, RunHandle } from './review-runner';

export interface ReviewRunnerContext {
  store: Store<StoreSchema>;
  getReviewWindow: () => BrowserWindow | null;
  recordInteraction: (itemId: string, kind: 'opened' | 'reviewed' | 'commented') => void;
}

function sendToReview(
  win: BrowserWindow | null,
  channel: string,
  payload?: unknown,
): void {
  if (!win || win.isDestroyed()) return;
  if (payload === undefined) {
    win.webContents.send(channel);
  } else {
    win.webContents.send(channel, payload);
  }
}

export async function runReviewStart(
  ctx: ReviewRunnerContext,
  payload: ReviewStartPayload,
  previous: RunHandle | null,
): Promise<RunHandle | null> {
  const { item } = payload;
  const win = ctx.getReviewWindow();
  const settings = ctx.store.get('settings');

  if (previous) {
    log.warn('ipc-review: aborting previous run');
    previous.abort();
  }

  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) {
    const err: ReviewErrorPayload = {
      itemId: item.id,
      message: `연결을 찾을 수 없습니다 (gitConfigId=${item.gitConfigId})`,
    };
    sendToReview(win, REVIEW_ERROR, err);
    return null;
  }
  const gitProvider = createGitProvider(cfg);

  let current: RunHandle | null = null;
  let workspace: { dir: string; release: () => void } | null = null;
  const release = (): void => workspace?.release();
  try {
    const [full, discussions] = await Promise.all([
      gitProvider.fetchChanges(item),
      gitProvider.fetchDiscussions(item).catch((err: unknown): [] => {
        log.warn(`ipc-review: fetchDiscussions failed (ignored): ${String(err)}`);
        return [];
      }),
    ]);
    full.discussions = discussions;
    sendToReview(win, ITEM_NEW, full);

    // 자동 리뷰와 동일하게 최신 브랜치를 클론 슬롯에 fetch+checkout — AI 가 파일을 직접 본다.
    // 준비 실패 시 이전처럼 diff 만으로 진행(prepareWorkspace 가 null 반환).
    workspace = await prepareWorkspace({ item, cfg, store: ctx.store });

    const aiProvider = createAIProvider(settings.ai);
    // 이전 AI 리뷰(로컬 캐시)를 프롬프트에 포함 — 재리뷰 시 지적 사항의 해결 여부를 확인하게 함
    const prevReview = (ctx.store.get('reviewCache') ?? {})[item.id]?.markdown;
    const prompt = buildPrompt(full, prevReview, workspace !== null);
    const inner = runReview(
      aiProvider,
      prompt,
      (chunk: string): void => {
        const p: ReviewChunkPayload = { itemId: item.id, chunk };
        sendToReview(win, REVIEW_CHUNK, p);
      },
      (): void => {
        release();
        ctx.recordInteraction(item.id, 'reviewed');
        sendToReview(win, REVIEW_DONE, { itemId: item.id } satisfies ReviewDonePayload);
      },
      (err: Error): void => {
        release();
        const p: ReviewErrorPayload = { itemId: item.id, message: err.message };
        sendToReview(win, REVIEW_ERROR, p);
      },
      workspace?.dir,
    );
    // abort 로 끊겨도 슬롯은 반납돼야 한다 (이중 반납은 slot-pool 이 무시)
    current = { abort: (): void => { inner.abort(); release(); } };
  } catch (err) {
    release();
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ipc-review: review start failed: ${msg}`);
    sendToReview(win, REVIEW_ERROR, { itemId: item.id, message: msg } satisfies ReviewErrorPayload);
  }
  return current;
}
