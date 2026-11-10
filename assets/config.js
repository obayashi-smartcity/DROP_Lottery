// 抽選システムの設定。GASをデプロイしたら GAS_URL を書き換える。
window.LOTTERY_CONFIG = {
  // GAS「デプロイ > ウェブアプリ」の URL（…/exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbz9eeoqO-NIlcfLw298EsmX2NVaJNW2stQ2c1X3I6_HYTsFLC1JA6NVf4zULlbi8D4P7Q/exec',

  // 通信のタイムアウト（ミリ秒）
  REQUEST_TIMEOUT_MS: 20000,

  // 当選画面で引換状態を確認し直す間隔（ミリ秒）
  STATUS_POLL_MS: 30000,

  // 抽選演出の最短時間（ミリ秒）
  DRAW_MIN_ANIMATION_MS: 1800,

  // 在庫一覧の自動更新間隔（ミリ秒）
  STOCK_POLL_MS: 30000,
};
