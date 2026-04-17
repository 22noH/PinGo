// main/ipc-review.ts — 리뷰 관련 IPC 로직 (REVIEW_START 핸들러)
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import type Store from 'electron-store';
import type {
  AppSettings,
  ReviewChunkPayload,
  ReviewErrorPayload,
  ReviewItemSummary,
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

function findProvider(
  settings: AppSettings,
  item: ReviewItemSummary,
): ReturnType<typeof createGitProvider> | null {
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return null;
  return createGitProvider(cfg);
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

  const gitProvider = findProvider(settings, item);
  if (!gitProvider) {
    const err: ReviewErrorPayload = {
      message: `연결을 찾을 수 없습니다 (gitConfigId=${item.gitConfigId})`,
    };
    sendToReview(win, REVIEW_ERROR, err);
    return null;
  }

  let current: RunHandle | null = null;
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

    const aiProvider = createAIProvider(settings.ai);
    const prompt = buildPrompt(full);
    current = runReview(
      aiProvider,
      prompt,
      (chunk: string): void => {
        const p: ReviewChunkPayload = { chunk };
        sendToReview(win, REVIEW_CHUNK, p);
      },
      (): void => {
        ctx.recordInteraction(item.id, 'reviewed');
        sendToReview(win, REVIEW_DONE);
      },
      (err: Error): void => {
        const p: ReviewErrorPayload = { message: err.message };
        sendToReview(win, REVIEW_ERROR, p);
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`ipc-review: review start failed: ${msg}`);
    sendToReview(win, REVIEW_ERROR, { message: msg } satisfies ReviewErrorPayload);
  }
  return current;
}
