/* eslint-disable */
// scripts/generate-icons.js
// SVG → PNG 변환 (tray: 16px/32px, window icon: 256px)
// 실행: npm run generate-icons

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const ICONS = ['icon-active', 'icon-muted', 'icon-new-mr', 'icon-error'];
const SIZES = [
  { size: 16, suffix: '' },
  { size: 32, suffix: '@2x' },
];

async function convert(name) {
  const svgPath = path.join(ASSETS_DIR, `${name}.svg`);
  if (!fs.existsSync(svgPath)) {
    throw new Error(`SVG not found: ${svgPath}`);
  }
  const svgBuffer = fs.readFileSync(svgPath);

  for (const { size, suffix } of SIZES) {
    const outPath = path.join(ASSETS_DIR, `${name}${suffix}.png`);
    await sharp(svgBuffer, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath);
    process.stdout.write(`generated ${outPath}\n`);
  }
}

async function generateAppIcon() {
  // 윈도우 타이틀바/작업표시줄용 고해상도 아이콘 (icon-active 기반, 256px)
  const svgPath = path.join(ASSETS_DIR, 'icon-active.svg');
  const svgBuffer = fs.readFileSync(svgPath);
  const outPath = path.join(ASSETS_DIR, 'app-icon.png');
  await sharp(svgBuffer, { density: 3072 })
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  process.stdout.write(`generated ${outPath}\n`);
}

(async () => {
  try {
    for (const name of ICONS) {
      await convert(name);
    }
    await generateAppIcon();
    process.stdout.write('all icons generated\n');
  } catch (err) {
    process.stderr.write(`icon generation failed: ${err && err.message}\n`);
    process.exit(1);
  }
})();
