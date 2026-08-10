// main/auto-review/verify.ts — 스레드 해결 검증
//
// 사람이 지적 스레드를 "해결" 하면 전체 재리뷰 대신, 그 지적이 진짜 고쳐졌는지만
// AI 로 판정해 해당 스레드에 답글로 남긴다. 전체 리뷰를 다시 달면 새 resolvable
// 스레드가 생겨 해결 → 리뷰 → 해결 → … 사람이 누를 때마다 무한 반복되기 때문.
import log from 'electron-log';
import type Store from 'electron-store';
import type { Discussion, ReviewItemSummary, StoreSchema } from '../../shared/types';
import type { GitProvider } from '../providers/git/git-provider';

export const VERIFY_HEADER = '🤖 **Pingo 해결 검증**';

export interface ThreadVerdict {
  threadId: string;
  /** true=해결 확인, false=미해결(스레드 다시 엶), null=판단 불가 → 사람 판단 존중(조용히 수용) */
  fixed: boolean | null;
  /** 스레드에 달 답글 본문 (판단 불가면 안 단다) */
  reply: string;
}

/** 검증 프롬프트 — 저장소가 클론된 cwd 에서 실행되는 전제 */
export function buildVerifyPrompt(d: Discussion, targetBranch: string): string {
  const notes = d.notes
    .map((n) => `- **${n.author.name}**: ${n.body.slice(0, 1000)}`)
    .join('\n');
  return `당신은 시니어 코드 리뷰어입니다. 아래 코드 리뷰 스레드가 방금 "해결됨" 으로 표시되었습니다.
현재 작업 디렉터리에 이 브랜치의 저장소가 클론되어 있습니다. 파일 열람과 git 조회로
스레드의 지적이 최신 코드에서 실제로 해결됐는지만 확인하세요.
(전체 변경: \`git diff origin/${targetBranch || 'HEAD~1'}...HEAD\`)
새로운 리뷰나 스레드와 무관한 지적은 하지 마세요.

**출력 형식** — 아래 두 줄만, 첫 글자부터 바로. 한국어로 쓰세요:
판정: 해결
사유: 한두 문장. 판정이 "판정: 미해결" 인 경우 무엇이 남았는지 \`파일경로:라인\` 으로.

## 검증 대상 스레드
${notes}`;
}

/** AI 출력에서 판정 추출 — "판정: 해결"/"판정: 미해결" 한 줄. 표기 없으면 null(판단 불가). */
export function parseVerdict(threadId: string, output: string): ThreadVerdict {
  const m = /^판정\s*[:：]\s*(미해결|해결)\s*$/m.exec(output);
  const fixed = m ? m[1] === '해결' : null;
  const body = output.trim().slice(0, 3000);
  return { threadId, fixed, reply: body ? `${VERIFY_HEADER}\n\n${body}` : '' };
}

/**
 * 판정 게시: 해결 확인/미해결은 스레드 답글로, 미해결이면 스레드를 다시 연다
 * (사람이 진짜 고치고 재해결하면 재검증된다). 수용된 스레드 id 는 캐시에 기록해
 * 같은 해결이 다시 검증을 부르지 않게 한다.
 */
export async function postVerdicts(
  provider: GitProvider,
  item: ReviewItemSummary,
  verdicts: ThreadVerdict[],
  store: Store<StoreSchema>,
): Promise<void> {
  const accepted: string[] = [];
  for (const v of verdicts) {
    try {
      if (v.fixed !== null && v.reply && provider.postReply) {
        await provider.postReply(item, {
          gitConfigId: item.gitConfigId,
          itemId: item.itemId,
          projectId: item.projectId,
          repoFullName: item.repoFullName,
          discussionId: v.threadId,
          body: v.reply,
        });
      }
      if (v.fixed === false) {
        await provider.resolveDiscussion?.(item, v.threadId, false);
        log.info(`auto-review: 검증 미해결 → 스레드 다시 엶 ${item.id} (${v.threadId})`);
        continue;
      }
      accepted.push(v.threadId);
      log.info(
        `auto-review: 검증 ${v.fixed === true ? '해결 확인' : '판단 불가 — 수용'} ${item.id} (${v.threadId})`,
      );
    } catch (err) {
      // 답글/재오픈 실패 — 이 해결은 수용 처리해 검증 재시도 루프를 막는다
      accepted.push(v.threadId);
      log.warn(`auto-review: 검증 게시 실패 ${item.id} (${v.threadId}): ${String(err).slice(0, 200)}`);
    }
  }
  if (accepted.length === 0) return;
  const cache = store.get('reviewCache') ?? {};
  const entry = cache[item.id];
  if (!entry) return;
  entry.resolvedThreadIds = [...(entry.resolvedThreadIds ?? []), ...accepted];
  store.set('reviewCache', cache);
}
