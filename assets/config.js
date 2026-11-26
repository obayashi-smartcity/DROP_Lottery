// 抽選システムの設定。GASをデプロイしたら URL を書き換える。
window.LOTTERY_CONFIG = {
  // 抽選GAS「デプロイ > ウェブアプリ」の URL（…/exec で終わるもの）
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwCgzpKfQgHp9oAaZ-RYuWkzaNmAsGaRJGzoG3_Qkmb3MXtuxieJ36bZx_KIepPLxZJrw/exec',

  // アンケートGAS（DROP_Lottery_Survey_API）の URL
  SURVEY_GAS_URL: 'https://script.google.com/macros/s/AKfycbxd_8nC9tJUyLXnqon1qpzALdbkYm5jVr_op9AAuRJnqM4t2x7QQckpRQr32pF6tIKF/exec',

  // 遷移元（スタンプラリー）から受け取る URL パラメータ名
  // 例: index.html?account_id=ABC123&point=30（手入力欄はない。パラメータがなければ「スタンプラリーのページから開いてください」）
  PARAM_USER_ID: 'account_id',
  PARAM_POINTS: 'point',

  // 「スタンプラリーに戻る」ボタンの戻り先（空にするとボタンを表示しない）
  STAMP_RALLY_URL: 'https://drop.machiapps.com/collab-a/',

  // 通信のタイムアウト（ミリ秒）
  REQUEST_TIMEOUT_MS: 20000,

  // 当選画面で引換状態を確認し直す間隔（ミリ秒）
  STATUS_POLL_MS: 30000,

  // 抽選演出の最短時間（ミリ秒）
  DRAW_MIN_ANIMATION_MS: 3000,

  // 在庫一覧の自動更新間隔（ミリ秒）
  STOCK_POLL_MS: 30000,
};
