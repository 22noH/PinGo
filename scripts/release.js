#!/usr/bin/env node
// 릴리스 태그를 안전하게 생성/푸시한다.  사용법: npm run release [버전]
//
// 재발방지: 태그가 [skip ci] 커밋을 가리키면 GitHub 이 Release 워크플로까지
// 통째로 스킵한다 (v0.4.4 릴리스가 안 나온 원인). 수동 버전 범프 커밋은
// [skip ci] 를 달기 때문에, 그 커밋에 태그를 걸면 릴리스가 안 돈다.
//
// → 애초에 수동 범프가 필요 없다. release.yml 이 릴리스 성공 후 master 버전을
//   태그에 맞춰 올려준다. 여기선 태그만 걸고, 그 태그가 [skip ci] 커밋을
//   가리키면 skip 없는 빈 커밋을 하나 얹어 회피한다.
const { execSync } = require('node:child_process');

const isSkipCi = (msg) => /\[skip ci\]|\[ci skip\]/i.test(msg);

// 셀프 체크: 태그가 스킵되는 유일한 조건(= 위 정규식)만 검증하면 충분
if (process.argv[2] === '--selftest') {
  const assert = require('node:assert');
  assert.equal(isSkipCi('chore: bump version to 0.4.4 [skip ci]'), true);
  assert.equal(isSkipCi('fix: 뭔가 [CI SKIP]'), true);
  assert.equal(isSkipCi('feat: 일반 커밋'), false);
  console.log('selftest ok');
  process.exit(0);
}

const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const pkg = require('../package.json');

const version = process.argv[2] || pkg.version;
const tag = `v${version}`;

if (run('git tag -l').split('\n').includes(tag)) {
  console.error(`태그 ${tag} 이(가) 이미 있습니다. 새 버전을 인자로 주세요 (예: npm run release 0.4.5).`);
  process.exit(1);
}

// HEAD 가 [skip ci] 커밋이면 → skip 없는 빈 커밋을 얹어 태그가 그 위를 가리키게 함
// ponytail: 워킹트리가 지저분해도 빈 커밋은 그걸 안 담음. 릴리스 직전 clean 이 정상.
if (isSkipCi(run('git log -1 --pretty=%B'))) {
  console.log('HEAD 가 [skip ci] 커밋 → skip 없는 릴리스 커밋을 추가합니다.');
  run(`git commit --allow-empty -m "chore: release ${tag}"`);
}

run(`git tag ${tag}`);
run('git push origin HEAD');
run(`git push origin ${tag}`);
console.log(`푸시 완료: ${tag} → Release 워크플로가 빌드 + master 버전 범프까지 처리합니다.`);
