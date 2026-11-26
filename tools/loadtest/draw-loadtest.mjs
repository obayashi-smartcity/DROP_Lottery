#!/usr/bin/env node
// 抽選GAS の draw を同時に N 件送り、結果を集計する負荷試験スクリプト（Node 18 以上。外部パッケージ不要）
//
// 使い方（詳しくは README.md）:
//   node tools/loadtest/draw-loadtest.mjs --url <抽選GASの…/exec の URL> --count 10 --points 5 --yes
//
// 注意:
//   - 実行すると、指定した GAS の DB に抽選データ（Users・Winners・Logs）が残り、景品の在庫も消費される。
//     本番のデプロイには絶対に使わない。終わったら resetAllData で消す。
//   - URL には既定値を持たせていない（間違って実行しないため）。--yes を付けない限り送信しない。

import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function usage(msg) {
  if (msg) console.error(`エラー: ${msg}\n`);
  console.error(`使い方:
  node tools/loadtest/draw-loadtest.mjs --url <URL> [--count 10] [--points 5] [--code <イベントコード>] [--timeout 60000] --yes

  --url      抽選GAS の URL（…/exec）。必須。既定値なし
  --count    同時に送る件数（1〜100、既定 10）
  --points   スタンプ数（既定 5）。ボタン（tierId）は info の Tiers から自動で決める
  --code     イベントコード（Config の EVENT_CODE が空なら不要）
  --timeout  1件あたりのタイムアウト（ミリ秒、既定 60000）
  --yes      実際に送信する（付けなければ内容を表示して終わる）`);
  process.exit(1);
}

async function post(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* JSON でない */ }
    if (!json || typeof json !== 'object') return { ms, kind: 'BAD_RESPONSE', detail: `HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}` };
    if (!json.ok) return { ms, kind: (json.error && json.error.code) || 'ERROR', detail: json.error && json.error.message };
    return { ms, kind: 'OK', json };
  } catch (e) {
    return { ms: Date.now() - started, kind: 'NETWORK', detail: String(e && e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function stats(list) {
  if (!list.length) return '-';
  const s = list.slice().sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  return `最小 ${s[0]}ms / 中央値 ${median}ms / 最大 ${s[s.length - 1]}ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) usage('--url は必須です（既定値はありません）');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(url)) usage('--url は https://script.google.com/macros/s/…/exec の形式で指定してください');
  const count = Number(args.count || 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) usage('--count は 1〜100 の整数で指定してください');
  const points = Number(args.points || 5);
  if (!Number.isInteger(points) || points < 0) usage('--points は 0 以上の整数で指定してください');
  const eventCode = typeof args.code === 'string' ? args.code : '';
  const timeoutMs = Number(args.timeout || 60000);

  console.log(`送信先: ${url}`);
  console.log(`件数: ${count} / スタンプ数: ${points}${eventCode ? ` / イベントコード: ${eventCode}` : ''}`);
  if (!args.yes) {
    console.log('\n--yes が付いていないので送信しません。');
    console.log('実行すると DB に抽選データが残り、景品の在庫も消費されます。終わったら resetAllData で消してください。');
    return;
  }

  // ボタン（tierId）を info から決める
  const info = await post(url, { action: 'info', eventCode }, timeoutMs);
  if (info.kind !== 'OK') { console.error(`info に失敗しました: ${info.kind} ${info.detail || ''}`); process.exit(1); }
  const tier = (info.json.tiers || []).find((t) => points >= t.min && (t.max === null || t.max === undefined || points <= t.max));
  if (!tier) { console.error(`スタンプ数 ${points} に合うボタンがありません`); process.exit(1); }
  if (!info.json.open) console.warn('注意: 受付時間外（open=false）です。CLOSED が返ります');
  console.log(`ボタン: ${tier.id}（${tier.label}）\n${count} 件を同時に送信します…`);

  const started = Date.now();
  const results = await Promise.all(Array.from({ length: count }, () => {
    const userId = randomUUID(); // 毎回ランダムな UUID（既存の参加者と重ならない）
    return post(url, {
      action: 'draw', userId, points, tierId: tier.id, eventCode, deviceId: randomUUID(), fp: '',
    }, timeoutMs).then((r) => Object.assign(r, { userId }));
  }));
  const elapsed = Date.now() - started;

  const byKind = {};
  results.forEach((r) => { (byKind[r.kind] = byKind[r.kind] || []).push(r); });
  const ok = byKind.OK || [];
  const busy = byKind.BUSY || [];
  const others = results.filter((r) => r.kind !== 'OK' && r.kind !== 'BUSY');

  console.log(`\n==== 結果（全体 ${elapsed}ms）====`);
  console.log(`成功:     ${ok.length} 件  ${stats(ok.map((r) => r.ms))}`);
  console.log(`BUSY:     ${busy.length} 件  ${stats(busy.map((r) => r.ms))}`);
  console.log(`その他:   ${others.length} 件  ${stats(others.map((r) => r.ms))}`);
  Object.keys(byKind).filter((k) => k !== 'OK' && k !== 'BUSY').forEach((k) => {
    console.log(`  - ${k}: ${byKind[k].length} 件（例: ${byKind[k][0].detail || ''}）`);
  });
  console.log(`全件:     ${stats(results.map((r) => r.ms))}`);
  if (ok.length) {
    const win = ok.filter((r) => r.json.result === 'win').length;
    const consolation = ok.filter((r) => r.json.result !== 'win' && r.json.consolation).length;
    console.log(`内訳:     当選 ${win} / はずれ景品 ${consolation} / 景品なし ${ok.length - win - consolation}`);
  }
  console.log('\nロックの待ち時間・保持時間は、DB の Logs シートの draw 行（詳細欄の wait=…ms hold=…ms）と BUSY 行で確認してください。');
  console.log('終わったら resetAllData でテストデータを消してください（README.md 参照）。');
}

main().catch((e) => { console.error(e); process.exit(1); });
