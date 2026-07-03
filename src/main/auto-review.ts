// main/auto-review.ts — 새 MR/PR 감지 시 백그라운드 AI 리뷰 실행 → reviewCache 저장
// 리뷰 창을 열면 기존 캐시 복원 경로(REVIEW_CACHE_LOAD)로 결과가 자동 표시된다.
import log from 'electron-log';
import type Store from 'electron-store';
import type { GitConfig, ReviewItemSummary, StoreSchema } from '../shared/types';
import { createAIProvider } from './providers/ai/ai-provider';
import { createGitProvider } from './providers/git/git-provider';
import { buildPrompt, runReview } from './review-runner';

const inFlight = new Set<string>();

/** 내 담당(내가 작성자 or 리뷰어)인 경우만 자동리뷰 — GitLab은 scope=all 이라 팀 전체 MR이 잡히므로 필수 */
function isMyItem(cfg: GitConfig, item: ReviewItemSummary): boolean {
  if (item.viewerIsReviewer) return true;
  if (cfg.type === 'gitlab') return item.author.id === cfg.userId;
  return item.author.username.toLowerCase() === cfg.username.toLowerCase();
}

export function maybeAutoReview(store: Store<StoreSchema>, item: ReviewItemSummary): void {
  const settings = store.get('settings');
  if (settings.autoReviewEnabled !== true) return;
  if (inFlight.has(item.id)) return;
  if ((store.get('reviewCache') ?? {})[item.id]) return; // 이미 리뷰됨 — 재실행 안 함
  const cfg = settings.gitConnections.find((c) => c.id === item.gitConfigId);
  if (!cfg) return;
  if (!isMyItem(cfg, item)) return;

  inFlight.add(item.id);
  log.info(`auto-review: start ${item.id} (${item.title.slice(0, 60)})`);
  void (async (): Promise<void> => {
    try {
      const provider = createGitProvider(cfg);
      const [full, discussions] = await Promise.all([
        provider.fetchChanges(item),
        provider.fetchDiscussions(item).catch((): [] => []),
      ]);
      full.discussions = discussions;
      const prompt = buildPrompt(full);

      let markdown = '';
      await new Promise<void>((resolve, reject) => {
        runReview(
          createAIProvider(settings.ai),
          prompt,
          (chunk: string): void => { markdown += chunk; },
          resolve,
          reject,
        );
      });
      if (!markdown.trim()) throw new Error('빈 리뷰 결과');

      const cache = store.get('reviewCache') ?? {};
      cache[item.id] = {
        markdown: markdown.length > 200_000 ? markdown.slice(-200_000) : markdown,
        updatedAt: new Date().toISOString(),
      };
      store.set('reviewCache', cache);
      log.info(`auto-review: done ${item.id} (${markdown.length} chars)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`auto-review: failed ${item.id}: ${msg.slice(0, 200)}`);
    } finally {
      inFlight.delete(item.id);
    }
  })();
}
