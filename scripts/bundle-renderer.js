// scripts/bundle-renderer.js
// esbuild로 renderer TypeScript → 단일 번들 JS (브라우저 ESM)
// + preload TypeScript → standalone CommonJS (sandbox 호환)
const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.join(__dirname, '..');

(async () => {
  // 프리로드: Node CJS 번들 (electron은 external로 유지)
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/preload.ts')],
    bundle: true,
    outfile: path.join(ROOT, 'dist/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    sourcemap: true,
  });
  process.stdout.write('bundled: dist/preload.js\n');

  // 렌더러: 브라우저 ESM 번들
  const rendererEntries = [
    {
      in: path.join(ROOT, 'src/renderer/settings/settings.ts'),
      out: path.join(ROOT, 'dist/renderer/settings/settings.js'),
    },
    {
      in: path.join(ROOT, 'src/renderer/review/review.ts'),
      out: path.join(ROOT, 'dist/renderer/review/review.js'),
    },
  ];

  for (const { in: entryPoint, out: outfile } of rendererEntries) {
    await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      outfile,
      platform: 'browser',
      format: 'esm',
      target: 'chrome108',
      sourcemap: true,
    });
    process.stdout.write(`bundled: ${outfile}\n`);
  }

  process.stdout.write('bundle-renderer: 완료\n');
})().catch(err => {
  process.stderr.write(`bundle-renderer 실패: ${err.message}\n`);
  process.exit(1);
});
