# DROP_Lottery

イベント向けの簡易抽選システムです。画面は GitHub Pages、API は Google Apps Script（GAS）、データは Google スプレッドシートに置きます。当落判定・在庫・引換の判定はすべて GAS で行い、画面は表示と API 呼び出しの制御だけを担います。

## 流れ

```
LP（index.html） → アンケート（survey.html） → 抽選（lottery.html） → 結果
```

1. **LP**：ユーザーIDとポイント数を受け取り、ポイントに合うボタンだけを有効にする。
   遷移元サイトからの受け渡し方法が決まるまでは手入力。`index.html?uid=<ID>&pt=<ポイント>` で開くと入力欄に入った状態になる（パラメータ名は `assets/config.js` で変更可）。
2. **アンケート**：全ボタン共通。回答はアンケートGASがスプレッドシートに記録する。
3. **抽選**：選んだボタンの当選確率で当落を決め、当たりなら景品の残りから割り当てる。
4. **結果**：当たりなら引換用QRと引換コードを表示する。

- 抽選はユーザーIDごとに1回。抽選済みのIDで来た場合は「抽選は完了しています」と結果を表示する。
- LP を通らずにアンケート・抽選ページを開いた場合は LP に戻す。

| 画面 | URL | 使う人 |
| --- | --- | --- |
| LP | `https://obayashi-smartcity.github.io/DROP_Lottery/` | 参加者 |
| 景品引換 | `https://obayashi-smartcity.github.io/DROP_Lottery/staff.html` | 引換所のスタッフ |

## ファイル構成

```
index.html              LP（ユーザーID・ポイント入力、ボタン選択）
survey.html             アンケート
lottery.html            抽選・結果・完了画面
staff.html              スタッフの引換・在庫画面
assets/config.js        GAS の URL、URL パラメータ名などの設定
assets/survey-config.js アンケートの設問
assets/api.js           GAS 呼び出し、画面間の状態、共通処理
assets/lp.js            LP の処理
assets/survey.js        アンケートの処理
assets/lottery.js       抽選画面の処理
assets/staff.js         スタッフ画面の処理
assets/style.css        スタイル
```

GAS とスプレッドシートは、共有ドライブ「00_GAS」の「抽選システム」フォルダにあります。

| 種類 | 名前 | 役割 |
| --- | --- | --- |
| GAS | `DROP_Lottery` | 抽選・引換の API |
| GAS | `DROP_Lottery_Survey_API` | アンケート回答の記録 |
| スプレッドシート | `DROP_Lottery_DB` | 設定・景品・ボタン・抽選結果 |
| スプレッドシート | `DROP_Lottery_Survey` | アンケート回答（Responses シート） |

## 設定を変える場所

| 変えたいもの | 場所 |
| --- | --- |
| ボタンの数・名前・ポイントの閾値・当選確率 | `DROP_Lottery_DB` の **Tiers** シート（1行＝1ボタン。最大ポイントが空欄なら上限なし。確率は %） |
| 景品と数 | `DROP_Lottery_DB` の **Prizes** シート（行を増やしたら GAS の `setupSheets` を実行して集計式を入れる） |
| イベント名・受付時間・引換期限・受付停止 | `DROP_Lottery_DB` の **Config** シート |
| アンケートの設問 | `assets/survey-config.js`（設問IDを増やすと回答シートに列が自動で追加される） |
| 遷移元から受け取る URL パラメータ名 | `assets/config.js` の `PARAM_USER_ID`・`PARAM_POINTS` |

スプレッドシートの変更はすぐに反映されます（GAS の再デプロイは不要）。

## DROP_Lottery_DB のシート

| シート | 内容 |
| --- | --- |
| Config | イベント設定 |
| Prizes | 景品。当選数・引換数・手元残数・当選可能残は式で自動計算 |
| Tiers | ボタン（tierId・ボタン名・最小/最大ポイント・当選確率） |
| Users | ユーザーIDごとの抽選結果（1人1行） |
| Winners | 当選者（引換コード・引換状態・userId） |
| Logs | 操作ログ |

Tickets・Devices シートは旧方式（くじ箱・端末単位）のもので、今は使っていません。

## セットアップ

### 1. 抽選GAS（DROP_Lottery）

1. 関数 `setupSecrets` を実行する（初回は権限の承認が必要）。実行ログに表示されるスタッフ PIN を控える。PIN はプロジェクトの設定 > スクリプト プロパティの `STAFF_PIN` で変更できる。
2. 関数 `setupSheets` を実行する。Tiers・Users シートと Prizes の集計式ができる（何度実行してもデータは消えない）。
3. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」。次のユーザーとして実行：自分 / アクセスできるユーザー：全員。
4. 表示された URL（`…/exec`）を `assets/config.js` の `GAS_URL` に貼る。

### 2. アンケートGAS（DROP_Lottery_Survey_API）

1. 関数 `setupSheet` を実行する（初回は権限の承認が必要）。DROP_Lottery_Survey に Responses シートができる。
2. 抽選GASと同じ設定でウェブアプリとしてデプロイし、URL を `assets/config.js` の `SURVEY_GAS_URL` に貼る。

Responses シートには、受信日時・userId・ポイント・tierId・ボタン名・deviceId・画面から渡されたパラメータ（JSON）・回答（JSON）と、設問IDごとの列が並びます。

コードを直したときは「デプロイを管理」から既存のデプロイを編集して新しいバージョンにすると、URL が変わりません。

### 3. GitHub Pages

リポジトリの Settings > Pages で、Branch を `main`、フォルダを `/ (root)` にする。

## 不正防止の仕組み

| 不正 | 対策 |
| --- | --- |
| 同じユーザーIDで何度も抽選 | Users シートでユーザーIDごとに1回。抽選済みなら前回の結果を返す |
| ポイントと違うボタンで抽選 | GAS が Tiers を見てポイントとボタンの組み合わせを検証する |
| 同じ QR で何度も引換 | 引換は GAS のロック内で「未引換 → 引換済み」を1回だけ行う |
| 偽の QR | QR に HMAC 署名を入れ、GAS で検証する |
| 在庫を超えた当選 | 当選時に「初期数 − 当選数」が残っている景品だけを割り当てる（ロック内） |
| 画面の改ざん | 当落は GAS が決め、画面には確率も景品構成も置かない |

※ ユーザーIDとポイント数は今は手入力のため、本人確認やポイントの正しさは保証されません。遷移元サイトからの受け渡し方法（署名付きパラメータなど）が決まったら対応が必要です。

## テストのやり直し

1. 抽選GASのスクリプト プロパティに `ALLOW_RESET` = `yes` を追加する。
2. 関数 `resetAllData` を実行する（Winners・Users・Logs を消去。`ALLOW_RESET` は自動で消える）。
3. アンケート回答は DROP_Lottery_Survey の Responses シートの行を手で消す。

## 注意

- このリポジトリに秘密情報（PIN、署名鍵）を置かないでください。どちらも GAS のスクリプト プロパティにあります。
- GAS の同時実行は1スクリプトあたり約30件までです。本番前に複数台で同時に抽選するテストをしてください。
- CacheService の上限により、スタッフのログインは6時間で切れます。
