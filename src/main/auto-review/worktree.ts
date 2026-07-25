// main/auto-review/worktree.ts — 자동 리뷰용 격리 작업 트리(clone) 생성/정리
//
// 대상 브랜치를 임시 격리 디렉터리에 shallow single-branch 클론한다 = 격리된 작업 트리.
// ponytail: 리뷰마다 독립 클론으로 격리. 공유 bare mirror + `git worktree add` 는
//   클론 비용이 문제가 될 때 도입.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface ReviewWorktree {
  /** 클론된 작업 트리 경로 */
  dir: string;
  /** 사용 후 정리 (실패해도 throw 하지 않음) */
  cleanup: () => Promise<void>;
}

function git(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} 실패 (code ${code}): ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/**
 * 대상 브랜치를 격리된 임시 디렉터리에 클론한다.
 * @param cloneUrl 인증(토큰) 주입된 https clone URL — 토큰 주입은 호출측 책임.
 * @param branch   클론할 브랜치명 (source_branch).
 */
export async function createReviewWorktree(cloneUrl: string, branch: string): Promise<ReviewWorktree> {
  if (!cloneUrl) throw new Error('cloneUrl 이 비어 있습니다');
  if (!branch) throw new Error('branch 가 비어 있습니다');
  const dir = await mkdtemp(path.join(tmpdir(), 'pingo-review-'));
  try {
    await git(['clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, dir]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}
