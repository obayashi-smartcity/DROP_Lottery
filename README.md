# DROP_Lottery

イベント会場向けの簡易抽選システムです。画面は GitHub Pages、API は Google Apps Script（GAS）、データは Google スプレッドシートに置きます。当落判定・在庫・引換の判定はすべて GAS で行い、画面は表示と API 呼び出しの制御だけを担います。

| 画面 | URL | 使う人 |
| --- | --- | --- |
| 抽選 | `https://obayashi-smartcity.github.io/DROP_Lottery/` | 参加者（Config の EVENT_CODE を入れた場合は `?c=<コード>` 付きURLのみ） |
| 景品引換 | `https://obayashi-smartcity.github.io/DROP_Lottery/staff.html` | 引換所のスタッフ |

## ファイル構成

```
index.html          参加者の抽選画面
staff.html          スタッフの引換・在庫画面
assets/config.js    GAS の URL などの設定
assets/api.js       GAS 呼び出し、端末ID、共通処理
assets/lottery.js   抽選画面の処理
assets/staff.js     スタッフ画面の処理
assets/style.css    スタイル
```

GAS のソース（`Code.gs`、`appsscript.json`）とスプレッドシート（`DROP_Lottery_DB`）は、共有ドライブ「GAS」の「抽選システム」フォルダにあります。

## セットアップ

### 1. GAS プロジェクトを作る

1. 共有ドライブ「GAS」>「抽選システム」で、新規 > その他 > Google Apps Script を選び、名前を `DROP_Lottery_API` にする。
2. エディタの `コード.gs` の中身を、同じフォルダの `Code.gs` の内容で置き換える。
3. プロジェクトの設定で「appsscript.json マニフェスト ファイルをエディタで表示する」をオンにし、`appsscript.json` を同じフォルダのものに置き換える。
4. 関数 `setupSecrets` を実行する（初回は権限の承認が必要）。実行ログに表示されるスタッフ PIN を控える。PIN はプロジェクトの設定 > スクリプト プロパティの `STAFF_PIN` で変更できる。

### 2. 景品とくじ箱を用意する

1. スプレッドシート `DROP_Lottery_DB` の Prizes シートに、景品の prizeId・景品名・初期数を入れる（サンプル行は書き換える）。
2. Config シートでイベント名・イベントコード・受付時間・引換期限・くじ箱の枚数（TICKET_COUNT）を設定する。
3. GAS で関数 `buildTicketBox` を実行する。Tickets シートにくじが並べば完了。

### 3. GAS をウェブアプリとして公開する

1. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」。
2. 次のユーザーとして実行：自分 / アクセスできるユーザー：全員。
3. 表示された URL（`…/exec`）を `assets/config.js` の `GAS_URL` に貼る。

コードを直したときは「デプロイを管理」から既存のデプロイを編集して新しいバージョンにすると、URL が変わりません。

### 4. GitHub Pages を有効にする

リポジトリの Settings > Pages で、Branch を `main`、フォルダを `/ (root)` にする。

### 5. 会場用 QR を作る

`https://obayashi-smartcity.github.io/DROP_Lottery/?c=<Config の EVENT_CODE>` を QR コードにして掲示する。イベントコードを日ごとに変える場合は、QR も作り直す。

## 不正防止の仕組み

| 不正 | 対策 |
| --- | --- |
| 同じ端末で何度も抽選 | 端末ID（localStorage と IndexedDB に保存）ごとに1回。抽選済みなら前回の結果を返す |
| ブラウザや端末を変えて再抽選 | 端末特徴ハッシュを記録し、在庫画面に警告を出す。引換時のスタンプ等の運用で補う |
| 同じ QR で何度も引換 | 引換は GAS のロック内で「未引換 → 引換済み」を1回だけ行う |
| 偽の QR | QR に HMAC 署名を入れ、GAS で検証する |
| 在庫を超えた当選 | くじ箱方式（引いたくじは戻さない）＋ロック |
| 画面の改ざん | 当落は GAS が決め、画面には確率も景品構成も置かない |

## テストのやり直し

1. スクリプト プロパティに `ALLOW_RESET` = `yes` を追加する。
2. 関数 `resetAllData` を実行する（Tickets・Winners・Devices・Logs を消去。`ALLOW_RESET` は自動で消える）。
3. 関数 `buildTicketBox` を実行する。

参加者側の端末に残った端末IDと結果は、ブラウザのサイトデータを消すとリセットできます。

## 注意

- このリポジトリに秘密情報（PIN、署名鍵）を置かないでください。どちらも GAS のスクリプト プロパティにあります。
- GAS の同時実行は1スクリプトあたり約30件までです。300人規模なら問題ありませんが、本番前に複数台で同時に抽選するテストをしてください。
- CacheService の上限により、スタッフのログインは6時間で切れます。
