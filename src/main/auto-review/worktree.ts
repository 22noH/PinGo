// main/auto-review/worktree.ts — 자동 리뷰용 격리 작업 트리(clone) 생성/정리
//
// 대상 브랜치를 임시 격리 디렉터리에 shallow single-branch 클론한다 = 격리된 작업 트리.
//
// ponytail: 리뷰마다 독립 클론으로 격리. 큰 저장소(oneguide, 2026-07 측정)에서 MR 1건당 ~300초.
//   clone 옵션으로는 더 못 줄인다 — 같은 저장소/브랜치 실측:
//     --depth 1 (현재) 301s / --filter=blob:none 343s / 둘 다 374s.
//   partial clone 은 checkout 때 blob 을 되받아와 오히려 느리다(merge-resolver 가 blob:none 을
//   쓰는 이유는 속도가 아니라 shallow 가 merge-base 를 깨뜨려서 — 리뷰에는 해당 없음).
//   더 빠르게 하려면 옵션이 아니라 구조를 바꿔야 한다: 프로젝트별 영구 캐시 클론(최초 1회 clone,
//   이후 fetch + checkout) 또는 변경 파일 주변만 sparse checkout. 클론 비용이 실제로 문제가
//   될 때 도입.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

/** 경로에 쓸 수 없는 문자 제거 — 브랜치명에 `/` 가 흔하다 */
function safeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').slice(0, 60);
}

/**
 * 대상 브랜치를 격리된 디렉터리에 클론한다.
 * @param cloneUrl 인증(토큰) 주입된 https clone URL — 토큰 주입은 호출측 책임.
 * @param branch   클론할 브랜치명 (source_branch).
 * @param workDir  설정된 작업 폴더. 주면 `<workDir>/pingo-review/<라벨>` 에 클론해
 *                 사용자가 진행 상황을 눈으로 볼 수 있다. 없으면 OS 임시 폴더.
 * @param label    작업 폴더 사용 시 하위 폴더 이름 (예: `MR-273-feat-x`).
 */
export async function createReviewWorktree(
  cloneUrl: string,
  branch: string,
  workDir?: string,
  label?: string,
): Promise<ReviewWorktree> {
  if (!cloneUrl) throw new Error('cloneUrl 이 비어 있습니다');
  if (!branch) throw new Error('branch 가 비어 있습니다');
  let dir: string;
  if (workDir) {
    dir = path.join(workDir, 'pingo-review', safeName(label ?? branch));
    // 이전 실행이 남긴 폴더가 있으면 지우고 새로 — 중간에 죽은 클론이 남아 있을 수 있다
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(path.dirname(dir), { recursive: true });
  } else {
    dir = await mkdtemp(path.join(tmpdir(), 'pingo-review-'));
  }
  try {
    await git(['clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, dir]);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return {
    dir,
    // 작업 폴더를 지정한 경우엔 지우지 않는다 — 사용자가 "지금 뭘 리뷰 중인지" 를
    // 눈으로 확인하려고 지정한 폴더다. 다음 리뷰 때 같은 자리를 지우고 다시 클론한다.
    cleanup: workDir
      ? (): Promise<void> => Promise.resolve()
      : (): Promise<void> => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}
