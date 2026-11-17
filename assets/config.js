// 抽選システムの設定。GASをデプロイしたら URL を書き換える。
window.LOTTERY_CONFIG = {
  // 抽選GAS「デプロイ > ウェブアプリ」の URL（…/exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwCgzpKfQgHp9oAaZ-RYuWkzaNmAsGaRJGzoG3_Qkmb3MXtuxieJ36bZx_KIepPLxZJrw/exec',

  // アンケートGAS（DROP_Lottery_Survey_API）の URL
  SURVEY_GAS_URL: 'REPLACE_WITH_SURVEY_GAS_URL',

  // 遷移元サイトから受け取る URL パラメータ名（仕様が決まったら合わせる）
  // 例: index.html?uid=ABC123&pt=30 で開くと入力欄に入った状態で表示される
  PARAM_USER_ID: 'uid',
  PARAM_POINTS: 'pt',

  // 通信のタイムアウト（ミリ秒）
  REQUEST_TIMEOUT_MS: 20000,

  // 当選画面で引換状態を確認し直す間隔（ミリ秒）
  STATUS_POLL_MS: 30000,

  // 抽選演出の最短時間（ミリ秒）
  DRAW_MIN_ANIMATION_MS: 3000,

  // 在庫一覧の自動更新間隔（ミリ秒）
  STOCK_POLL_MS: 30000,
};
