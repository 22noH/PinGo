// main/review-runner.ts — AIProvider 기반 리뷰 실행 + 프롬프트 빌드
import * as path from 'path';
import type { Discussion, ItemChange, ReviewItemWithChanges } from '../shared/types';
import { MAX_CHANGES_IN_REVIEW, MAX_DIFF_CHARS } from '../shared/constants';
import type { AIProvider, AIStreamHandle } from './providers/ai/ai-provider';

const SYSTEM_PROMPT = `당신은 시니어 코드 리뷰어입니다. 아래 MR/PR 변경 사항을 분석하고
한국어로 간결하게 리뷰하세요. 형식: 마크다운.
리뷰 항목: 버그 위험, 성능, 보안, 가독성, 개선 제안.
기존 댓글 섹션이 있다면 각 댓글의 타당성(근거 있는 지적인지, 이미 해결됐는지, 보완이 필요한지)도 함께 평가하세요.`;

const MAX_NOTES_IN_REVIEW = 30;
const MAX_NOTE_BODY_CHARS = 400;

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

export function buildPrompt(item: ReviewItemWithChanges): string {
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

  const discussionsSection = buildDiscussionsSection(item.discussions ?? []);

  return `${header}${sections.join('\n')}${discussionsSection}`;
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
