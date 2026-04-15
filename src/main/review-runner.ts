// main/review-runner.ts — Claude CLI 스트리밍 실행 (stream-json)
import { spawn } from 'child_process';
import * as path from 'path';
import log from 'electron-log';
import type { MergeRequestWithChanges, MRChange } from '../shared/types';
import { CLAUDE_INSTALL_URL, MAX_CHANGES_IN_REVIEW, MAX_DIFF_CHARS } from '../shared/constants';

const SYSTEM_PROMPT = `당신은 시니어 코드 리뷰어입니다. 아래 GitLab MR의 변경 사항을 분석하고
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

interface StreamJsonEvent {
  type: 'text' | 'tool_use' | 'message_stop' | 'error' | string;
  text?: string;
  error?: { message?: string };
}

function changeStatus(c: MRChange): string {
  if (c.new_file) return 'new';
  if (c.deleted_file) return 'deleted';
  if (c.renamed_file) return 'renamed';
  return 'modified';
}

function diffChangedLines(diff: string): number {
  return diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;
}

export function buildPrompt(mr: MergeRequestWithChanges): string {
  const allChanges = mr.changes;
  const selected = [...allChanges]
    .sort((a, b) => diffChangedLines(b.diff) - diffChangedLines(a.diff))
    .slice(0, MAX_CHANGES_IN_REVIEW);

  const header = [
    SYSTEM_PROMPT,
    '',
    '## MR 정보',
    `- 제목: ${mr.title}`,
    `- 브랜치: ${mr.source_branch} → ${mr.target_branch}`,
    `- 설명: ${mr.description || '없음'}`,
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

export interface RunHandle {
  abort(): void;
}

/**
 * `claude -p --output-format stream-json --verbose` 실행.
 * - 프롬프트는 stdin 주입 (OS 인수 길이 한계 우회)
 * - stdout 각 라인이 JSON → StreamJsonEvent 파싱
 * - ENOENT(claude 미설치) 시 명확한 메시지로 매핑
 */
export function runClaudeReview(
  prompt: string,
  onChunk: (s: string) => void,
  onDone: () => void,
  onError: (e: Error) => void,
): RunHandle {
  log.info('review-runner: spawning claude (stream-json)');

  const proc = spawn(
    'claude',
    ['-p', '--output-format', 'stream-json', '--verbose'],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    },
  );

  let aborted = false;
  let errored = false;
  let lineBuffer = '';

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(trimmed) as StreamJsonEvent;
    } catch {
      log.debug(`review-runner: non-JSON line skipped: ${trimmed.slice(0, 200)}`);
      return;
    }
    if (event.type === 'text' && typeof event.text === 'string') {
      onChunk(event.text);
    } else if (event.type === 'error') {
      errored = true;
      const msg = event.error?.message ?? 'Claude CLI 오류';
      onError(new Error(msg));
    }
    // message_stop / tool_use 는 별도 처리 불필요 (close에서 onDone)
  };

  proc.stdout.on('data', (data: Buffer) => {
    lineBuffer += data.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });

  proc.stderr.on('data', (data: Buffer) => {
    log.warn(`claude[stderr]: ${data.toString('utf-8').trim()}`);
  });

  proc.on('error', (err: NodeJS.ErrnoException) => {
    errored = true;
    if (err.code === 'ENOENT') {
      onError(new Error(`Claude CLI가 설치되지 않았습니다. ${CLAUDE_INSTALL_URL} 에서 설치하세요.`));
    } else {
      log.error(`review-runner: spawn error: ${err.message}`);
      onError(err);
    }
  });

  proc.on('close', (code: number | null) => {
    if (lineBuffer.length > 0) {
      handleLine(lineBuffer);
      lineBuffer = '';
    }
    if (aborted) {
      log.info('review-runner: aborted by user');
      return;
    }
    if (errored) return;
    if (code === 0) {
      log.info('review-runner: done');
      onDone();
    } else {
      log.error(`review-runner: exit code=${code ?? 'null'}`);
      onError(new Error(`claude exited with code ${code ?? 'null'}`));
    }
  });

  // 프롬프트 stdin 주입
  try {
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  } catch (err) {
    const e = err instanceof Error ? err : new Error('stdin write failed');
    errored = true;
    onError(e);
    proc.kill('SIGTERM');
  }

  return {
    abort: (): void => {
      if (proc.exitCode !== null) return;
      aborted = true;
      proc.kill('SIGTERM');
      log.info('review-runner: SIGTERM sent');
    },
  };
}
