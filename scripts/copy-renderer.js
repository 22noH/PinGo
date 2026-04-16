// scripts/copy-renderer.js
// HTML/CSS 파일을 src/renderer/ → dist/renderer/ 로 복사 (tsc는 .ts만 컴파일)
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const DEST = path.join(__dirname, '..', 'dist', 'renderer');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (/\.(html|css)$/.test(entry.name)) {
      fs.copyFileSync(s, d);
    }
  }
}

copyDir(SRC, DEST);
console.log('copy-renderer: HTML/CSS → dist/renderer 완료');
