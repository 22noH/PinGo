// main/auto-review/worktree.test.ts — 슬롯 재사용이 앱 재시작을 넘겨서도 유지되는지 (실제 git 사용).
//
// 슬롯 풀은 메모리라 앱을 다시 켜면 모든 슬롯이 fresh 로 보인다. 그때마다 디렉터리를 지우고
// 다시 클론하면 큰 저장소는 업데이트/재시작마다 수 분씩 잃는다. 디스크에 완성된 클론이
// 있으면 fresh 여도 fetch+checkout 만 해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { prepareSlot } from './worktree';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 커밋 하나 있는 bare 원격 저장소 */
function makeRemote(root: string): string {
  const work = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  git(['init', '-q', '-b', 'main', work], root);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], work);
  git(['init', '-q', '--bare', bare], root);
  git(['push', '-q', bare, 'main'], work);
  return bare;
}

test('완성된 클론이 디스크에 있으면 (앱 재시작 후에도) 다시 클론하지 않는다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const slot = path.join(root, 'slot-0');
    await prepareSlot(slot, remote, 'main');
    // 재클론되면 사라질 표식
    const sentinel = path.join(slot, '.git', 'pingo-sentinel');
    writeFileSync(sentinel, 'x');

    await prepareSlot(slot, remote, 'main'); // 재시작 후 첫 대여와 같은 상황
    assert.ok(existsSync(sentinel), '기존 클론을 지우고 다시 받았다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('클론이 완성되지 않은 디렉터리(표식 없음)는 처음부터 클론한다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const slot = path.join(root, 'slot-0');
    // 중단된 클론 흉내: git 저장소이긴 하지만 완성 표식이 없다
    git(['init', '-q', slot], root);
    const junk = path.join(slot, 'junk.txt');
    writeFileSync(junk, 'x');
    await prepareSlot(slot, remote, 'main');
    assert.ok(!existsSync(junk), '깨진 디렉터리는 지우고 새로 받아야 한다');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], slot).trim(), 'HEAD', 'detach 체크아웃');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 오래된 index.lock ─────────────────────────────────────
// 업데이트 재시작/크래시로 이전 프로세스의 git 이 남긴 잠금은 슬롯을 영영 막는다(20260915 로그:
// 두 슬롯 모두 "index.lock: File exists"). 아무 git 도 안 잡고 있는 오래된 잠금은 지우고 진행한다.
import { utimesSync } from 'node:fs';
import { STALE_LOCK_MS } from './worktree';

test('오래된 index.lock 이 남아 있어도 슬롯 준비가 된다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const slot = path.join(root, 'slot-0');
    await prepareSlot(slot, remote, 'main');
    const lock = path.join(slot, '.git', 'index.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000);
    utimesSync(lock, old, old);
    await prepareSlot(slot, remote, 'main');
    assert.ok(!existsSync(lock), '오래된 잠금은 제거돼야 한다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('방금 생긴 index.lock 은 건드리지 않는다 — 진짜 다른 git 이 도는 중일 수 있다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const slot = path.join(root, 'slot-0');
    await prepareSlot(slot, remote, 'main');
    const lock = path.join(slot, '.git', 'index.lock');
    writeFileSync(lock, '');
    await assert.rejects(() => prepareSlot(slot, remote, 'main'), /index\.lock/);
    assert.ok(existsSync(lock));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 재사용 슬롯의 remote-tracking ref 가 리모트와 어긋나는 경우 ───────────
// 슬롯은 여러 MR 에 걸쳐 재사용되므로 이전에 받아둔 origin/<branch> 가 남아 있다.
// (1) 누가 브랜치를 rebase 후 force-push 하면 non-fast-forward 라 fetch 가 거절된다.
// (2) 브랜치가 머지돼 삭제된 뒤 그 이름을 접두어로 하는 브랜치(fix → fix/login)가 생기면
//     남은 ref 파일이 디렉터리 생성을 막아 "cannot lock ref" 로 실패한다.
// 두 경우 모두 다른 컴퓨터에서 "fetch 가 종종 실패" 로 보고된 원인이다(20261008).
function commit(work: string, msg: string, extra: string[] = []): void {
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', ...extra, '-m', msg], work);
}

test('force-push 로 역사가 바뀐 브랜치도 받아온다 (non-fast-forward)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const work = path.join(root, 'work');
    git(['checkout', '-q', '-b', 'feat'], work);
    commit(work, 'feat-1');
    git(['push', '-q', remote, 'feat'], work);
    const slot = path.join(root, 'slot-0');
    await prepareSlot(slot, remote, 'feat', 'main'); // 슬롯에 origin/feat 가 남는다

    commit(work, 'feat-1 rebased', ['--amend']);
    git(['push', '-q', '-f', remote, 'feat'], work);
    const rewritten = git(['rev-parse', 'HEAD'], work).trim();

    await prepareSlot(slot, remote, 'feat', 'main');
    assert.equal(git(['rev-parse', 'HEAD'], slot).trim(), rewritten, '새 역사로 체크아웃돼야 한다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('삭제된 브랜치 이름이 새 브랜치의 접두어여도 받아온다 (fix → fix/login)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const work = path.join(root, 'work');
    git(['push', '-q', remote, 'main:refs/heads/fix'], work);
    const slot = path.join(root, 'slot-0');
    await prepareSlot(slot, remote, 'fix', 'main'); // 슬롯에 refs/remotes/origin/fix 파일이 남는다

    git(['push', '-q', remote, '--delete', 'fix'], work); // 머지 후 삭제
    git(['checkout', '-q', '-b', 'fix/login'], work);
    commit(work, 'login');
    git(['push', '-q', remote, 'fix/login'], work);
    const head = git(['rev-parse', 'HEAD'], work).trim();

    await prepareSlot(slot, remote, 'fix/login', 'main');
    assert.equal(git(['rev-parse', 'HEAD'], slot).trim(), head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('리모트에 없는 브랜치는 "삭제됨" 을 알 수 있는 오류로 실패한다', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pingo-wt-'));
  try {
    const remote = makeRemote(root);
    const slot = path.join(root, 'slot-0');
    await assert.rejects(() => prepareSlot(slot, remote, 'gone', 'main'), /브랜치가 원격에 없습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
