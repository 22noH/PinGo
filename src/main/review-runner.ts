// main/review-runner.ts — AIProvider 기반 리뷰 실행 + 프롬프트 빌드
import * as path from 'path';
import type { ItemChange, ReviewItemWithChanges } from '../shared/types';
import { MAX_CHANGES_IN_REVIEW, MAX_DIFF_CHARS } from '../shared/constants';
import type { AIProvider, AIStreamHandle } from './providers/ai/ai-provider';

const SYSTEM_PROMPT = `당신은 시니어 코드 리뷰어입니다. 아래 MR/PR 변경 사항을 분석하고
한국어로 간결하게 리뷰하세요. 형식: 마크다운.
리뷰 항목: 버그 위험, 성능, 보안, 가독성, 개선 제안.`;

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

  return `${header}${sections.join('\n')}`;
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
