// main/auto-review/worktree.ts — 자동 리뷰용 작업 트리 준비 (슬롯 clone / 재사용)
//
// 프로젝트별 슬롯(slot-pool.ts 가 배정)에 클론해두고, 리뷰마다 브랜치만 갈아끼운다.
//
// 왜 이 구조인가 — oneguide 저장소(48,084 파일) 실측:
//   MR 마다 새 클론      : 376~408초
//   git worktree add     : 425초  (objects 는 공유해도 파일을 다시 다 펼침 → 이득 없음)
//   슬롯 재사용(fetch+checkout): 8~17초, 같은 브랜치 재리뷰는 6.5초   ← 채택
//   clone 옵션 만으로는 못 줄인다: --depth 1 301s / blob:none 343s / 둘 다 374s.
//   비용의 거의 전부가 "48,084개 파일을 디스크에 펼치기" 라, 안 펼치는 게 유일한 답이다.
//
// ponytail: 슬롯 하나당 7.7GB(작업 트리 + pack 1.34GB). 개수는 설정으로 제한한다.
//   디스크가 더 문제가 되면 변경 파일 주변만 sparse checkout 하는 쪽으로 간다.
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * git 실행. core.longpaths=true 필수 —
 * Windows 는 기본 260자 제한이라 Boost 헤더 같은 깊은 경로에서 checkout 이 통째로 실패한다
 * ("Filename too long"). 임시 폴더(짧은 경로)에서는 우연히 통과하던 것이,
 * 사용자가 지정한 폴더로 옮기는 순간 터진다.
 */
function git(args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.longpaths=true', ...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      // 진행률 출력(Updating files: ...)이 stderr 앞부분을 가득 채우므로 뒤에서 자른다.
      // 앞에서 자르면 진짜 원인이 안 보인다.
      else reject(new Error(`git ${args[0]} 실패 (code ${code}): ${tailError(stderr)}`));
    });
  });
}

/** 진행률 노이즈를 걷어내고 실제 에러 줄 위주로 남긴다 */
function tailError(stderr: string): string {
  const meaningful = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Updating files|Receiving objects|Resolving deltas|remote:|Cloning into)/.test(l));
  return (meaningful.length > 0 ? meaningful.join(' | ') : stderr.trim()).slice(-400);
}

/**
 * 리뷰용 작업 트리를 준비한다.
 *
 * 슬롯이 비어 있으면(fresh) 클론하고, 이미 클론된 슬롯이면 fetch + checkout 만 한다.
 * 큰 저장소 실측(oneguide): 최초 클론 408초 vs 재사용 8~17초 — 재사용이 이 설계의 전부다.
 *
 * @param dir      슬롯 디렉터리 (slot-pool 이 배정)
 * @param fresh    이 슬롯이 아직 클론되지 않았는지
 * @param cloneUrl 인증(토큰) 주입된 https clone URL — 토큰 주입은 호출측 책임
 * @param branch   리뷰할 브랜치 (source_branch)
 * @param targetBranch diff 기준점 — origin/<target> 으로 받아둔다
 */
export async function prepareSlot(
  dir: string,
  fresh: boolean,
  cloneUrl: string,
  branch: string,
  targetBranch?: string,
): Promise<void> {
  if (!cloneUrl) throw new Error('cloneUrl 이 비어 있습니다');
  if (!branch) throw new Error('branch 가 비어 있습니다');

  // 클론된 적 없거나 중간에 깨진 슬롯이면 처음부터
  if (fresh || !(await isGitRepo(dir))) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(path.dirname(dir), { recursive: true });
    // --depth 1 이 아니라 partial clone(blob:none) — 얕은 클론은 merge-base 가 없어
    // `git diff origin/<target>...HEAD` 가 성립하지 않는다.
    // --single-branch 도 쓰지 않는다: 이 슬롯은 이후 다른 브랜치로 갈아끼워 재사용한다.
    await git(['clone', '--filter=blob:none', '--no-checkout', cloneUrl, dir]);
    // AI 가 이 안에서 실행하는 git 에도 적용되도록 저장소 config 에 남긴다
    await git(['config', 'core.longpaths', 'true'], dir).catch(() => undefined);
  }

  await git(['fetch', '--filter=blob:none', 'origin', `${branch}:refs/remotes/origin/${branch}`], dir);
  if (targetBranch && targetBranch !== branch) {
    // diff 기준점. 실패해도 리뷰는 진행 — 그 경우 AI 는 프롬프트의 diff 만 쓴다.
    await git(
      ['fetch', '--filter=blob:none', 'origin', `${targetBranch}:refs/remotes/origin/${targetBranch}`],
      dir,
    ).catch(() => undefined);
  }
  // detach 로 체크아웃 — 로컬 브랜치를 만들면 다음 재사용 때 이름이 충돌한다.
  // -f: 이전 리뷰가 남긴 변경(AI 가 건드렸을 수도)을 버리고 깨끗한 상태로 맞춘다.
  await git(['checkout', '--detach', '-f', `origin/${branch}`], dir);
  // 추적되지 않는 잔여 파일 제거 — 이전 브랜치의 산출물이 리뷰에 섞이지 않게
  await git(['clean', '-ffdx'], dir).catch(() => undefined);
}

/** 이미 유효한 git 저장소인지 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], dir);
    return true;
  } catch {
    return false;
  }
}
