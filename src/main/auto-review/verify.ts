// main/auto-review/verify.ts — 스레드 해결 검증
//
// 사람이 지적 스레드를 "해결" 하면 전체 재리뷰 대신, 그 지적이 진짜 고쳐졌는지만
// AI 로 판정해 해당 스레드에 답글로 남긴다. 전체 리뷰를 다시 달면 새 resolvable
// 스레드가 생겨 해결 → 리뷰 → 해결 → … 사람이 누를 때마다 무한 반복되기 때문.
import log from 'electron-log';
import type Store from 'electron-store';
import type { Discussion, ReviewItemSummary, StoreSchema } from '../../shared/types';
import type { GitProvider } from '../providers/git/git-provider';
import type { ReviewPrompt } from '../review-runner';

export const VERIFY_HEADER = '🤖 **Pingo 해결 검증**';

export interface ThreadVerdict {
  threadId: string;
  /** true=해결 확인, false=미해결(스레드 다시 엶), null=판단 불가 → 사람 판단 존중(수용) */
  fixed: boolean | null;
  /** 스레드에 달 답글 본문 — 판단 불가여도 그 사실을 남긴다 */
  reply: string;
}

/**
 * 검증 프롬프트 — 저장소가 클론된 cwd 에서 실행되는 전제.
 * 역할·출력 규칙은 system 으로(CLI 의 자체 시스템 프롬프트에 덧붙어 우선 적용),
 * 스레드 내용은 user 로 나눈다.
 */
export function buildVerifyPrompt(d: Discussion, targetBranch: string): ReviewPrompt {
  const notes = d.notes
    .map((n) => `- **${n.author.name}**: ${n.body.slice(0, 1000)}`)
    .join('\n');
  const system = `당신은 시니어 코드 리뷰어입니다. 코드 리뷰 스레드가 방금 "해결됨" 으로 표시되었습니다.
현재 작업 디렉터리에 이 브랜치의 저장소가 클론되어 있습니다. 파일 열람과 git 조회로
스레드의 지적이 최신 코드에서 실제로 해결됐는지만 확인하세요.
(전체 변경: \`git diff origin/${targetBranch || 'HEAD~1'}...HEAD\`)
새로운 리뷰나 스레드와 무관한 지적은 하지 마세요.

**출력 규칙** — 최종 답변은 반드시 **한국어**로, 아래 두 줄만, 첫 글자부터 바로.
파일을 살펴보는 동안의 진행 서술("확인해보겠습니다", "I'll look at…")은 출력하지 마세요.
판정: 해결
사유: 한두 문장. 판정이 "판정: 미해결" 인 경우 무엇이 남았는지 \`파일경로:라인\` 으로.`;
  const user = `## 검증 대상 스레드\n${notes}`;
  return { system, user };
}

/**
 * AI 출력에서 판정 추출. 모델이 양식을 정확히 안 지킨다 — `**판정: 해결**`, `판정： 해결됨`,
 * `## 판정: 미해결` 처럼 온다. 마크다운 장식을 벗기고 "판정" 뒤의 해결/미해결만 본다.
 * 여러 줄이면 마지막 것(사고 과정 뒤 최종 판정). 없으면 null(판단 불가) — 이때도 답글은
 * 남긴다. 조용히 수용하면 사용자에겐 "검증이 안 됐다" 로 보인다.
 */
export function parseVerdict(threadId: string, output: string): ThreadVerdict {
  let fixed: boolean | null = null;
  for (const line of output.split(/\r?\n/)) {
    const bare = line.replace(/[*_`#>\-\s]+/g, ' ').trim();
    // 뒤에 "되지 않음"/"안 됨"/"하지 못함" 이 붙은 부정 표기는 해결로 오판하지 않는다
    const m = /판정\s*[:：]?\s*(미해결|해결)(?!\s*(되지|안\s|하지|이\s*아))/.exec(bare);
    if (m) fixed = m[1] === '해결';
  }
  const body = output.trim().slice(0, 3000);
  if (fixed !== null) return { threadId, fixed, reply: `${VERIFY_HEADER}\n\n${body}` };
  const note = '⚠️ 판단 불가 — AI 출력에서 판정(해결/미해결)을 읽지 못해 사람의 해결 판단을 수용합니다.';
  const reply = body ? `${VERIFY_HEADER}\n\n${note}\n\n---\n${body}` : `${VERIFY_HEADER}\n\n${note}`;
  return { threadId, fixed, reply };
}

/** 검증 자체를 못 한 경우(저장소 준비 실패 등) — 이유를 답글로 남기고 사람 판단을 수용한다 */
export function unverifiableVerdict(threadId: string, reason: string): ThreadVerdict {
  return {
    threadId,
    fixed: null,
    reply: `${VERIFY_HEADER}\n\n⚠️ 검증 불가 — ${reason}. 코드를 확인하지 못해 사람의 해결 판단을 수용합니다.`,
  };
}

/** 이력 표시용 한 줄 요약 — "검증: 해결 확인 2 · 미해결 1" */
export function summarizeVerdicts(verdicts: ThreadVerdict[]): string {
  const n = (f: boolean | null): number => verdicts.filter((v) => v.fixed === f).length;
  const parts = [
    n(true) > 0 ? `해결 확인 ${n(true)}` : '',
    n(false) > 0 ? `미해결 ${n(false)}` : '',
    n(null) > 0 ? `판단 불가 ${n(null)}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `검증: ${parts.join(' · ')}` : '검증: 대상 없음';
}

/**
 * 판정 게시: 해결 확인/미해결/판단 불가 모두 스레드 답글로, 미해결이면 스레드를 다시 연다
 * (사람이 진짜 고치고 재해결하면 재검증된다). 수용된 스레드 id 는 캐시에 기록해
 * 같은 해결이 다시 검증을 부르지 않게 한다.
 * @returns 이력 요약 한 줄
 */
export async function postVerdicts(
  provider: GitProvider,
  item: ReviewItemSummary,
  verdicts: ThreadVerdict[],
  store: Store<StoreSchema>,
): Promise<string> {
  const accepted: string[] = [];
  for (const v of verdicts) {
    try {
      if (v.reply && provider.postReply) {
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
  if (accepted.length > 0) {
    const cache = store.get('reviewCache') ?? {};
    const entry = cache[item.id];
    if (entry) {
      entry.resolvedThreadIds = [...(entry.resolvedThreadIds ?? []), ...accepted];
      store.set('reviewCache', cache);
    }
  }
  return summarizeVerdicts(verdicts);
}
