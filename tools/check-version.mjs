// 画面のバージョンの変え忘れを確かめる（D-52・D-53）。
//   node tools/check-version.mjs
// assets/config.js の APP_VERSION と、index.html・survey.html・lottery.html が読み込む CSS・JS の ?v= が
// すべて同じ値かを確かめる。?v= がない・値が違うものがあれば一覧を出して終了コード 1。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'assets/config.js'), 'utf8');
const m = config.match(/APP_VERSION:\s*'([^']*)'/);
if (!m) {
  console.error('NG: assets/config.js に APP_VERSION が見つかりません');
  process.exit(1);
}
const version = m[1];
const problems = [];
let count = 0;
for (const page of ['index.html', 'survey.html', 'lottery.html']) {
  const html = readFileSync(join(root, page), 'utf8').replace(/<!--[\s\S]*?-->/g, ''); // コメントは見ない
  const refs = [...html.matchAll(/(?:href|src)="(assets\/[^"]+\.(?:css|js)(?:\?[^"]*)?)"/g)].map((x) => x[1]);
  if (refs.length === 0) problems.push(`${page}: CSS・JS の読み込みが見つかりません`);
  for (const ref of refs) {
    count++;
    const v = new URLSearchParams(ref.split('?')[1] || '').get('v');
    if (v !== version) problems.push(`${page}: ${ref}（?v=${v === null ? 'なし' : v}）`);
  }
}
if (problems.length) {
  console.error(`NG: APP_VERSION は ${version} ですが、次の ?v= が合っていません`);
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}
console.log(`OK: APP_VERSION ${version}、3つの HTML の CSS・JS ${count} か所の ?v= がすべて同じです`);
