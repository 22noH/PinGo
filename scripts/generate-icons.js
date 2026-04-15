/* eslint-disable */
// scripts/generate-icons.js
// SVG → PNG 변환 (16x16, 32x32@2x)
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

(async () => {
  try {
    for (const name of ICONS) {
      await convert(name);
    }
    process.stdout.write('all icons generated\n');
  } catch (err) {
    process.stderr.write(`icon generation failed: ${err && err.message}\n`);
    process.exit(1);
  }
})();
