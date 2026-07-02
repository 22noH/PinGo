// main/merge-resolver.ts — AI 충돌 해결 머지
// 임시 클론 → target 머지 → 충돌 파일을 AI 로 해결 → 사용자 승인(별도 push 호출) 후 push.
// 자동 push 는 절대 하지 않는다 — push 는 pushAiMerge() 로만.
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import type {
  MergeAIPushResult,
  MergeAIStartResult,
  MergeResolvedFile,
  ReviewItemSummary,
} from '../shared/types';
import type { AIProvider } from './providers/ai/ai-provider';

const MAX_CONFLICT_FILES = 20;
const MAX_CONFLICT_FILE_CHARS = 200_000;

interface MergeSession {
  dir: string;
  sourceBranch: string;
  token: string;
}

// ponytail: 동시 1건만 — 리뷰 창에서 사람이 승인하는 흐름이라 병렬 세션이 필요해지면 그때 Map 으로
let session: MergeSession | null = null;
let busy = false;

/** 에러 메시지/출력에서 토큰 마스킹 */
function mask(s: string, secret: string): string {
  return secret ? s.split(secret).join('***') : s;
}

function runGit(args: string[], cwd: string | undefined, secret: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf-8'); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString('utf-8'); });
    proc.on('error', (e: NodeJS.ErrnoException) => {
      reject(new Error(
        e.code === 'ENOENT'
          ? 'git 이 설치되어 있지 않거나 PATH 에 없습니다'
          : mask(e.message, secret),
      ));
    });
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve(out);
      else reject(new Error(mask(err.trim() || `git ${args[0] ?? ''} 실패 (exit ${code ?? 'null'})`, secret)));
    });
  });
}

/** commit 을 만드는 git 호출용 — 로컬 identity 미설정 환경 대비 */
const GIT_IDENTITY = ['-c', 'user.name=pingo', '-c', 'user.email=pingo@local'];

/** AI 스트리밍 응답을 문자열로 수집 */
function runAIToText(ai: AIProvider, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    ai.streamReview(
      prompt,
      (chunk: string): void => { out += chunk; },
      (): void => resolve(out),
      (e: Error): void => reject(e),
    );
  });
}

/** AI 가 마크다운 코드펜스로 감싸서 답한 경우 벗겨냄 */
function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1] : t;
}

function buildResolvePrompt(filePath: string, content: string): string {
  return [
    'git merge 충돌을 해결하세요. 아래는 충돌 마커(<<<<<<< / ======= / >>>>>>>)가 포함된 파일 전체입니다.',
    '- 양쪽(HEAD 와 병합 대상) 변경의 의도를 모두 반영하여 충돌을 해결하세요.',
    '- 출력은 "해결된 최종 파일 전체 내용"만. 설명/마크다운 코드펜스/추가 주석 금지.',
    '',
    `파일 경로: ${filePath}`,
    '',
    content,
  ].join('\n');
}

async function resolveConflictFile(
  ai: AIProvider,
  dir: string,
  file: string,
  secret: string,
): Promise<void> {
  const abs = path.join(dir, file);
  const content = await fs.readFile(abs, 'utf-8');
  // NUL 바이트 존재 = 바이너리 파일로 간주
  if (content.includes(String.fromCharCode(0))) {
    throw new Error(`바이너리 파일 충돌은 자동 해결할 수 없습니다: ${file}`);
  }
  if (content.length > MAX_CONFLICT_FILE_CHARS) {
    throw new Error(`충돌 파일이 너무 큽니다 (${content.length}자): ${file}`);
  }
  const resolved = stripCodeFence(await runAIToText(ai, buildResolvePrompt(file, content)));
  if (!resolved.trim()) {
    throw new Error(`AI 가 빈 결과를 반환했습니다: ${file}`);
  }
  if (resolved.includes('<<<<<<<') || resolved.includes('>>>>>>>')) {
    throw new Error(`AI 결과에 충돌 마커가 남아 있습니다: ${file}`);
  }
  await fs.writeFile(abs, resolved, 'utf-8');
  await runGit(['add', '--', file], dir, secret);
}

export async function startAiMerge(
  item: ReviewItemSummary,
  cloneUrlWithAuth: string,
  token: string,
  ai: AIProvider,
  onProgress: (line: string) => void,
): Promise<MergeAIStartResult> {
  if (busy) return { success: false, error: '이미 진행 중인 AI 머지가 있습니다' };
  if (!item.sourceBranch || !item.targetBranch) {
    return { success: false, error: '브랜치 정보가 없습니다' };
  }
  busy = true;
  session = null;
  const dir = path.join(app.getPath('temp'), 'pingo-merge', `${item.projectId}-${item.itemId}`);

  try {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dir), { recursive: true });

    onProgress(`저장소 클론 중… (${item.sourceBranch})`);
    await runGit(
      ['clone', '--depth', '50', '--branch', item.sourceBranch, cloneUrlWithAuth, dir],
      undefined, token,
    );
    onProgress(`target 브랜치 가져오는 중… (${item.targetBranch})`);
    await runGit(['fetch', '--depth', '50', 'origin', item.targetBranch], dir, token);

    onProgress('머지 시도 중…');
    let conflicted: string[] = [];
    try {
      await runGit(
        [...GIT_IDENTITY, 'merge', '--no-edit', `origin/${item.targetBranch}`],
        dir, token,
      );
    } catch {
      conflicted = (await runGit(['diff', '--name-only', '--diff-filter=U'], dir, token))
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (conflicted.length === 0) {
        await runGit(['merge', '--abort'], dir, token).catch(() => undefined);
        throw new Error('머지가 실패했지만 충돌 파일을 찾지 못했습니다');
      }
      if (conflicted.length > MAX_CONFLICT_FILES) {
        await runGit(['merge', '--abort'], dir, token).catch(() => undefined);
        throw new Error(`충돌 파일이 너무 많습니다 (${conflicted.length}개 > ${MAX_CONFLICT_FILES}개)`);
      }
    }

    if (conflicted.length === 0) {
      // 충돌 없이 머지됨 — push 할 커밋이 있는지 확인
      const ahead = (await runGit(
        ['rev-list', '--count', `origin/${item.sourceBranch}..HEAD`], dir, token,
      )).trim();
      if (ahead === '0') {
        await fs.rm(dir, { recursive: true, force: true });
        onProgress('이미 최신 상태입니다 — push 할 것이 없습니다.');
        return { success: true, hadConflicts: false, upToDate: true, resolvedFiles: [] };
      }
      session = { dir, sourceBranch: item.sourceBranch, token };
      onProgress('충돌 없이 머지되었습니다.');
      return { success: true, hadConflicts: false, resolvedFiles: [] };
    }

    onProgress(`충돌 ${conflicted.length}개 파일 발견 — AI 해결 시작`);
    for (const file of conflicted) {
      onProgress(`AI 해결 중: ${file}`);
      await resolveConflictFile(ai, dir, file, token);
    }

    onProgress('머지 커밋 생성 중…');
    await runGit([...GIT_IDENTITY, 'commit', '--no-edit'], dir, token);

    const resolvedFiles: MergeResolvedFile[] = [];
    for (const file of conflicted) {
      const diff = await runGit(['diff', 'HEAD^', 'HEAD', '--', file], dir, token);
      resolvedFiles.push({ path: file, diff });
    }

    session = { dir, sourceBranch: item.sourceBranch, token };
    onProgress(`완료 — 충돌 ${conflicted.length}개 해결됨. diff 확인 후 push 하세요.`);
    return { success: true, hadConflicts: true, resolvedFiles };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`merge-resolver: failed item=#${item.itemId}: ${mask(msg, token).slice(0, 300)}`);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { success: false, error: mask(msg, token) };
  } finally {
    busy = false;
  }
}

export async function pushAiMerge(): Promise<MergeAIPushResult> {
  if (!session) {
    return { success: false, error: 'push 할 머지 세션이 없습니다 — AI 머지를 먼저 실행하세요' };
  }
  const { dir, sourceBranch, token } = session;
  try {
    await runGit(['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], dir, token);
    log.info(`merge-resolver: pushed to ${sourceBranch}`);
    session = null;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: mask(msg, token) };
  }
}
