// main/review-runner.ts — AIProvider 기반 리뷰 실행 + 프롬프트 빌드
import * as path from 'path';
import type { Discussion, ItemChange, ReviewItemWithChanges } from '../shared/types';
import { MAX_CHANGES_IN_REVIEW, MAX_DIFF_CHARS } from '../shared/constants';
import type { AIProvider, AIStreamHandle } from './providers/ai/ai-provider';

const SYSTEM_PROMPT = `당신은 시니어 코드 리뷰어입니다. 아래 MR/PR 변경 사항을 분석하고
한국어로 간결하게 리뷰하세요. 형식: 마크다운.

**출력 규칙**: 첫 글자부터 바로 리뷰 본문(마크다운 헤딩)으로 시작하세요.
인사말, 작업 계획, "리뷰하겠습니다"/"확인해보겠습니다" 류의 메타 코멘트,
소스 접근 가능 여부에 대한 언급을 절대 출력하지 마세요.
로컬 파일을 읽으려 하지 말고 아래 제공된 diff 만으로 리뷰하세요.

**우선순위**: 아래 "변경 파일" 섹션의 최신 diff 를 먼저 꼼꼼히 읽고 리뷰하세요.

**리뷰 양식**: 반드시 아래 섹션 구조와 헤딩을 그대로 사용하세요.
해당 없는 섹션은 "- 없음" 한 줄만 쓰고, 각 지적에는 \`파일경로:라인\` 을 명시하세요.

## 종합 평가
(2~3문장 요약 + 머지 가능 여부: ✅ 머지 가능 / ⚠️ 수정 권장 / ❌ 수정 필요)

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

export function buildPrompt(item: ReviewItemWithChanges, prevReview?: string): string {
  const allChanges = item.changes;
  const selected = [...allChanges]
    .sort((a, b) => diffChangedLines(b.diff) - diffChangedLines(a.diff))
    .slice(0, MAX_CHANGES_IN_REVIEW);

  const providerName = item.providerType === 'gitlab' ? 'GitLab MR' : 'GitHub PR';

  const header = [
    SYSTEM_PROMPT,
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
        '아래 파일들은 diff가 포함되지 않았습니다. 리뷰 결과에 "확인하지 못한 파일"로 명시하세요.',
        ...omitted.map((c) => `- ${c.new_path} [${changeStatus(c)}]`),
        '',
      ].join('\n')
    : '';

  const prevReviewSection = buildPrevReviewSection(prevReview);
  const discussionsSection = buildDiscussionsSection(item.discussions ?? []);

  return `${header}${sections.join('\n')}${omittedSection}${prevReviewSection}${discussionsSection}`;
}

export interface RunHandle extends AIStreamHandle {}

/** AIProvider로 리뷰 스트리밍 실행 */
export function runReview(
  provider: AIProvider,
  prompt: string,
  onChunk: (s: string) => void,
  onDone: () => void,
  onError: (e: Error) => void,
): RunHandle {
  return provider.streamReview(prompt, onChunk, onDone, onError);
}
