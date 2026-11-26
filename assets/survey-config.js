// アンケートの設問（全ボタン共通）。ここを書き換えるだけで設問を変えられる。
//
// id       … 回答の保存先の列名になる（英数字・_・-）。一度使ったら変えない
// type     … 'radio'（1つ選ぶ）/ 'checkbox'（複数選ぶ）/ 'select'（プルダウン）/ 'text'（1行）/ 'textarea'（複数行）
// options  … radio / checkbox / select の選択肢
// required … true なら回答必須
//
// ※ 以下は仮の設問です。
window.SURVEY_QUESTIONS = [
  {
    id: 'q1_age',
    label: '年代を教えてください',
    type: 'radio',
    options: ['10代以下', '20代', '30代', '40代', '50代', '60代以上'],
    required: true,
  },
  {
    id: 'q2_satisfaction',
    label: '今日のイベントの満足度は？',
    type: 'radio',
    options: ['とても満足', '満足', 'ふつう', 'やや不満', '不満'],
    required: true,
  },
  {
    id: 'q3_found',
    label: 'このイベントを何で知りましたか？（複数選択可）',
    type: 'checkbox',
    options: ['SNS', 'Webサイト', 'ポスター・チラシ', '知人の紹介', '通りがかり', 'その他'],
    required: false,
  },
  {
    id: 'q4_comment',
    label: 'ご意見・ご感想があればお書きください',
    type: 'textarea',
    required: false,
  },
];
