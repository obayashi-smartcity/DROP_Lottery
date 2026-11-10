// 抽選システムの設定。GASをデプロイしたら GAS_URL を書き換える。
window.LOTTERY_CONFIG = {
  // GAS「デプロイ > ウェブアプリ」の URL（…/exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/REPLACE_WITH_DEPLOYMENT_ID/exec',

  // 通信のタイムアウト（ミリ秒）
  REQUEST_TIMEOUT_MS: 20000,

  // 当選画面で引換状態を確認し直す間隔（ミリ秒）
  STATUS_POLL_MS: 30000,

  // 抽選演出の最短時間（ミリ秒）
  DRAW_MIN_ANIMATION_MS: 1800,

  // 在庫一覧の自動更新間隔（ミリ秒）
  STOCK_POLL_MS: 30000,
};
