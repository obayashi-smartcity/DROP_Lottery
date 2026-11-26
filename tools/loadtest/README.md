# 負荷試験（draw の同時実行）

抽選GAS の `draw` を同時に N 件送り、成功・BUSY・その他のエラーの件数と応答時間を集計します。
ロックの待ち時間・保持時間は、DB の Logs シートで確認します。

## 実行する前に（必ず読む）

- **本番のデプロイには絶対に使わない。** 実行すると、送った件数ぶんの抽選データ（Users・Winners・Logs）が DB に残り、**景品の在庫も消費されます**。
- テスト用の環境（GAS プロジェクトとスプレッドシートを丸ごとコピーしたもの、または本番前で消してよいデータだけの DB）で行う。
- 終わったら **`resetAllData` で消す**（下の「後片付け」）。
- GAS の URL には既定値がありません。`--url` を必ず指定し、`--yes` を付けたときだけ送信します。

## 必要なもの

- Node.js 18 以上（`fetch` を使う。外部パッケージは不要）
- 抽選GAS のウェブアプリの URL（`https://script.google.com/macros/s/…/exec`）
- Config の `ACCEPTING` が TRUE で、受付時間内であること（時間外だと全件 `CLOSED`）

## 使い方

```sh
# 内容の確認だけ（送信しない）
node tools/loadtest/draw-loadtest.mjs --url https://script.google.com/macros/s/XXXX/exec --count 10

# 実行（10・20・30 件の順に試す）
node tools/loadtest/draw-loadtest.mjs --url https://script.google.com/macros/s/XXXX/exec --count 10 --points 5 --yes
node tools/loadtest/draw-loadtest.mjs --url https://script.google.com/macros/s/XXXX/exec --count 20 --points 5 --yes
node tools/loadtest/draw-loadtest.mjs --url https://script.google.com/macros/s/XXXX/exec --count 30 --points 5 --yes
```

| 引数 | 内容 |
| --- | --- |
| `--url` | 抽選GAS の URL。必須（既定値なし） |
| `--count` | 同時に送る件数（1〜100、既定 10） |
| `--points` | スタンプ数（既定 5）。ボタン（tierId）は `info` の Tiers から自動で決める |
| `--code` | イベントコード（Config の `EVENT_CODE` が空なら不要） |
| `--timeout` | 1件あたりのタイムアウト（ミリ秒、既定 60000） |
| `--yes` | 実際に送信する |

- ユーザーIDは毎回ランダムな UUID です（既存の参加者と重なりません）。
- 画面の自動再試行（`callWithRetry`）は使わず、1件1回だけ送ります。BUSY がそのまま数に出ます。

## 出力の見方

```
成功:     10 件  最小 2100ms / 中央値 6500ms / 最大 11800ms
BUSY:     0 件  -
その他:   0 件  -
全件:     最小 2100ms / 中央値 6500ms / 最大 11800ms
内訳:     当選 3 / はずれ景品 7 / 景品なし 0
```

| 結果 | 意味 |
| --- | --- |
| 成功 | 抽選できた |
| BUSY | ロックを 10 秒（`LOCK_WAIT_MS`）待っても取れなかった。Logs に `BUSY` 行が残る |
| BAD_RESPONSE | JSON でない応答。GAS の同時実行数の上限（約30）を超えたときのエラーページなど |
| NETWORK | タイムアウト・通信エラー |
| その他のコード | `CLOSED`（受付時間外）、`NO_TIER` など |

## Logs で wait / hold を見る

DB の Logs シート（列: 日時・操作・ユーザー・結果・詳細）で:

1. フィルタ表示（「データ」→「フィルタ表示を作成」。ほかの人の画面に影響しない）を作る。
2. 操作（B列）が `draw` で、結果（D列）が `win` / `consolation` / `lose` の行の詳細（E列）に `wait=…ms hold=…ms` が入っている。
   - `wait`: ロックを取るまで待った時間。同時に送った件数が多いほど、後の人ほど長くなる。
   - `hold`: ロックを持っていた時間（1件の抽選処理の時間）。**これが小さいほど混雑に強い。**
3. 結果が `BUSY` の行は、ロックを取れなかった要求。詳細に `wait=…ms`（約 10000ms）が入る。
4. 目安: hold の中央値 × 同時件数 が 10 秒を超えると、BUSY が出始める。

`redeemSelf` も同じく、`OK` の行の詳細に `wait=…ms hold=…ms` が入ります。

## 後片付け

1. 抽選GAS のスクリプト プロパティに `ALLOW_RESET` = `yes` を追加する。
2. エディタで関数 `resetAllData` を実行する（Winners・Users・Logs の2行目以降を消去。`ALLOW_RESET` は自動で消える）。
3. Prizes の当選数・在庫は Winners から計算しているので、Winners を消せば元に戻る。
