// 抽選システムの設定。GASをデプロイしたら URL を書き換える。
window.LOTTERY_CONFIG = {
  // 抽選GAS「デプロイ > ウェブアプリ」の URL（…/exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzesRUAp8zG3HAUPZV06jba5ew-86SUgaR2FvFvxaWAqkuJalBrrISowro4pmfmskmvpA/exec',

  // アンケートGAS（DROP_Lottery_Survey_API）の URL
  SURVEY_GAS_URL: 'https://script.google.com/macros/s/AKfycbz32ki4ccmY4MKSpgaL6fq4xddcAklXLN2AQYeirnI5N7qOM-EvRuThKYuM7mps20-7/exec',

  // 遷移元（スタンプラリー）から受け取る URL パラメータ名
  // 例: index.html?account_id=ABC123&point=30（手入力欄はない。パラメータがなければ「スタンプラリーのページから開いてください」）
  PARAM_USER_ID: 'account_id',
  PARAM_POINTS: 'point',

  // 「スタンプラリーに戻る」ボタンの戻り先（空にするとボタンを表示しない）
  STAMP_RALLY_URL: 'https://drop.machiapps.com/collab-a/',

  // 通信のタイムアウト（ミリ秒）
  REQUEST_TIMEOUT_MS: 20000,

  // 混雑（BUSY）・通信エラー時の自動再試行（ミリ秒）。通信時間を含めて合計 RETRY_TOTAL_MS 程度で打ち切る（D-26）
  // 待ち時間は RETRY_BASE_MS × 回数（上限 RETRY_MAX_DELAY_MS）に ±50% のランダムなずれを加える
  RETRY_TOTAL_MS: 30000,
  RETRY_BASE_MS: 2000,
  RETRY_MAX_DELAY_MS: 6000,

  // 当選画面で引換状態を確認し直す間隔（ミリ秒）
  STATUS_POLL_MS: 30000,

  // 抽選演出の最短時間（ミリ秒）
  DRAW_MIN_ANIMATION_MS: 3000,

  // 画面のバージョン（GAS のバージョンとは別に管理する。D-52）。画面の右上に小さく出す。
  // 上げるときは、index.html・survey.html・lottery.html の CSS・JS の ?v= もすべて同じ値に変える（README「画面のバージョン」）
  APP_VERSION: 'v1.0.2',
};
