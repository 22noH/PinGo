// main/review-runner.ts — AIProvider 기반 리뷰 실행 + 프롬프트 빌드
import * as path from 'path';
import type { Discussion, ItemChange, ReviewItemWithChanges } from '../shared/types';
import { MAX_CHANGES_IN_REVIEW, MAX_DIFF_CHARS } from '../shared/constants';
import type { AIProvider, AIStreamHandle } from './providers/ai/ai-provider';

/** 저장소 클론 없이 diff 만으로 리뷰할 때의 소스 접근 지침 */
const SOURCE_DIFF_ONLY = '로컬 파일을 읽으려 하지 말고 아래 제공된 diff 만으로 리뷰하세요.';
/** 자동 리뷰가 브랜치를 클론해 cwd 로 넘긴 경우의 소스 접근 지침 */
const sourceWithRepo = (targetBranch: string): string =>
  `현재 작업 디렉터리에 이 브랜치의 저장소가 클론되어 있고, 파일 열람과 git 조회가 허용돼 있습니다.
- diff 만으로 판단이 어려운 지적은 파일을 직접 읽어 호출부·타입 정의·테스트까지 확인하고 쓰세요.
- 아래 "변경 파일" 은 분량 때문에 일부가 생략·절단됩니다. 전체 변경은 직접 확인하세요:
  \`git diff origin/${targetBranch || 'HEAD~1'}...HEAD\` (파일 목록만: \`--stat\`, 특정 파일: \`-- <경로>\`)
- 따라서 "확인하지 못한 파일" 은 원칙적으로 없어야 합니다. 정말 확인이 불가능했을 때만 그 사유와 함께 적으세요.`;

const systemPrompt = (hasRepo: boolean, targetBranch: string): string => `당신은 시니어 코드 리뷰어입니다. 아래 MR/PR 변경 사항을 분석하고
한국어로 간결하게 리뷰하세요. 형식: 마크다운.

**출력 규칙**: 첫 글자부터 바로 리뷰 본문(마크다운 헤딩)으로 시작하세요.
인사말, 작업 계획, "리뷰하겠습니다"/"확인해보겠습니다" 류의 메타 코멘트,
소스 접근 가능 여부에 대한 언급을 절대 출력하지 마세요.
${hasRepo ? sourceWithRepo(targetBranch) : SOURCE_DIFF_ONLY}

**우선순위**: 아래 "변경 파일" 섹션의 최신 diff 를 먼저 꼼꼼히 읽고 리뷰하세요.

**리뷰 양식**: 반드시 아래 섹션 구조와 헤딩을 그대로 사용하세요.
해당 없는 섹션은 "- 없음" 한 줄만 쓰고, 각 지적에는 \`파일경로:라인\` 을 명시하세요.

## 종합 평가
(2~3문장 요약 + 머지 가능 여부: ✅ 머지 가능 / ⚠️ 수정 권장 / ❌ 수정 필요)
판정은 세 표기 중 **하나만** 쓰세요. 선택지 나열을 그대로 복사하지 마세요.

## 🐛 버그 위험

## 🔒 보안

## ⚡ 성능

## 📖 가독성 · 개선 제안

## 이전 지적 사항 확인
(이전 AI 리뷰가 제공된 경우에만 — 각 지적별 ✅ 해결 / ❌ 미해결 / ⚠️ 확인 불가)

## 기존 댓글 검토
(기존 댓글이 제공된 경우에만)

## 확인하지 못한 파일
(프롬프트에서 생략된 파일이 있는 경우에만)

"기존 댓글" 섹션은 참고 정보일 뿐입니다. 댓글에만 답하지 말고 최신 코드 자체에서 발견한 새 이슈를
적극적으로 지적하세요. 단, 기존 댓글 중 최신 diff 로 이미 해결됐는지/여전히 유효한지 정도는
짧게 코멘트에 포함해도 좋습니다.`;

const MAX_NOTES_IN_REVIEW = 30;
const MAX_NOTE_BODY_CHARS = 400;
const MAX_PREV_REVIEW_CHARS = 8_000;

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.c': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.sql': 'sql',
};

function changeStatus(c: ItemChange): string {
  if (c.new_file) return 'new';
  if (c.deleted_file) return 'deleted';
  if (c.renamed_file) return 'renamed';
  return 'modified';
}

function diffChangedLines(diff: string): number {
  return diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;
}

function truncateNoteBody(body: string): string {
  if (body.length <= MAX_NOTE_BODY_CHARS) return body;
  return `${body.slice(0, MAX_NOTE_BODY_CHARS)}\n... (truncated)`;
}

function buildDiscussionsSection(discussions: Discussion[]): string {
  const notes = discussions
    .flatMap((d) => d.notes)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (notes.length === 0) return '';

  const capped = notes.slice(-MAX_NOTES_IN_REVIEW);
  const omittedInfo =
    notes.length > capped.length
      ? `\n> 오래된 댓글 ${notes.length - capped.length}개 생략 — 최신 ${capped.length}개만 표시\n`
      : '';

  const lines = capped.map((n) => {
    const flag = n.mentionsCurrentUser ? ' **(나를 멘션)**' : '';
    const header = `**${n.author.name}** · ${n.createdAt}${flag}`;
    return `- ${header}\n  > ${truncateNoteBody(n.body).replace(/\n/g, '\n  > ')}`;
  });

  return [
    '',
    `## 기존 댓글 (${notes.length}개)`,
    '각 댓글에 대해 타당성 검토를 함께 수행하세요 — (1) 지적이 정확한지, (2) 이번 diff로 해결됐는지, (3) 추가 조치가 필요한지.',
    omittedInfo,
    lines.join('\n'),
    '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

function buildPrevReviewSection(prevReview: string | undefined): string {
  const trimmed = (prevReview ?? '').trim();
  if (!trimmed) return '';
  const body =
    trimmed.length > MAX_PREV_REVIEW_CHARS
      ? `${trimmed.slice(0, MAX_PREV_REVIEW_CHARS)}\n... (truncated)`
      : trimmed;
  return [
    '',
    '## 이전 AI 리뷰',
    '아래는 이 MR/PR에 대해 이전에 작성한 리뷰입니다. 이후 코드가 수정되었을 수 있습니다.',
    '이번 리뷰 결과에 "이전 지적 사항 확인" 섹션을 만들어, 이전 지적 각각에 대해',
    '최신 diff 기준으로 해결됐는지(✅ 해결 / ❌ 미해결 / ⚠️ 확인 불가)를 명시하세요.',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * @param hasRepo 저장소가 클론되어 AI 의 cwd 로 전달되는 경우 true — 파일 직접 열람을 허용하는 지침으로 바뀐다.
 */
export function buildPrompt(
  item: ReviewItemWithChanges,
  prevReview?: string,
  hasRepo = false,
): string {
  const allChanges = item.changes;
  const selected = [...allChanges]
    .sort((a, b) => diffChangedLines(b.diff) - diffChangedLines(a.diff))
    .slice(0, MAX_CHANGES_IN_REVIEW);

  const providerName = item.providerType === 'gitlab' ? 'GitLab MR' : 'GitHub PR';

  const header = [
    systemPrompt(hasRepo, item.targetBranch),
    '',
    `## ${providerName} #${item.itemId}`,
    `- 제목: ${item.title}`,
    `- 브랜치: ${item.sourceBranch || '?'} → ${item.targetBranch || '?'}`,
    `- 설명: ${item.description || '없음'}`,
    '',
    `## 변경 파일 (${selected.length}개 / 전체 ${allChanges.length}개)`,
    '',
  ].join('\n');

  const sections = selected.map((c) => {
    if (!c.diff) {
      return [
        `### ${c.new_path}  [${changeStatus(c)}]`,
        '> diff 없음 — 파일이 너무 커서 서버가 diff를 제공하지 않았거나 내용 변경이 없는 파일입니다.',
        '',
      ].join('\n');
    }
    const lang = EXT_TO_LANG[path.extname(c.new_path).toLowerCase()] ?? 'diff';
    const truncated = c.diff.length > MAX_DIFF_CHARS;
    const body = truncated ? `${c.diff.slice(0, MAX_DIFF_CHARS)}\n... (truncated)` : c.diff;
    return [
      `### ${c.new_path}  [${changeStatus(c)}]`,
      `\`\`\`${lang}`,
      body,
      '```',
      '',
    ].join('\n');
  });

  const omitted = allChanges.filter((c) => !selected.includes(c));
  const omittedSection = omitted.length
    ? [
        '',
        `## 프롬프트에서 생략된 파일 (${omitted.length}개)`,
        hasRepo
          ? '아래 파일들은 분량 때문에 diff 를 넣지 않았습니다. 저장소가 클론되어 있으니 git diff 로 직접 확인하고 리뷰에 포함하세요.'
          : '아래 파일들은 diff가 포함되지 않았습니다. 리뷰 결과에 "확인하지 못한 파일"로 명시하세요.',
        ...omitted.map((c) => `- ${c.new_path} [${changeStatus(c)}]`),
        '',
      ].join('\n')
    : '';

  const prevReviewSection = buildPrevReviewSection(prevReview);
  const discussionsSection = buildDiscussionsSection(item.discussions ?? []);

  return `${header}${sections.join('\n')}${omittedSection}${prevReviewSection}${discussionsSection}`;
}

export interface RunHandle extends AIStreamHandle {}

/** AIProvider로 리뷰 스트리밍 실행. cwd 를 주면 CLI provider 가 그 디렉터리에서 실행된다. */
export function runReview(
  provider: AIProvider,
  prompt: string,
  onChunk: (s: string) => void,
  onDone: () => void,
  onError: (e: Error) => void,
  cwd?: string,
): RunHandle {
  return provider.streamReview(prompt, onChunk, onDone, onError, cwd);
}
