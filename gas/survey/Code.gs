/**
 * DROP_Lottery アンケートAPI（Google Apps Script）
 *
 * アンケート画面（GitHub Pages の survey.html）から POST で呼ばれ、回答を
 * スプレッドシート DROP_Lottery_Survey の Responses シートに1行ずつ追記する。
 * 画面から渡されたパラメータ（ユーザーID・ポイント数・選んだボタンなど）も一緒に記録する。
 *
 * 公開設定: デプロイ > ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *
 * 設問を増やしたり減らしたりしても、このスクリプトを直す必要はない。
 * 新しい設問IDが届くと、Responses シートの右端に列が自動で追加される。
 */

const SPREADSHEET_ID = '1e4bIao1l9Zd9DaUE3WQo3AOhSTwN_8CUQWJq2cAwh5U';
const SHEET_NAME = 'Responses';

// 先頭の固定列。この右に設問IDごとの列が並ぶ
const FIXED_HEADERS = ['受信日時', 'userId', 'ポイント', 'tierId', 'ボタン名', 'deviceId', 'パラメータ(JSON)', '回答(JSON)'];

const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,99}$/;
const MAX_POINTS = 10000000;
const MAX_ANSWERS = 50;
const MAX_TEXT = 2000;
const LOCK_WAIT_MS = 10000;

function doGet() {
  return json_({ ok: true, service: 'DROP_Lottery_Survey' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_(fail_('BAD_REQUEST', 'リクエストの形式が正しくありません'));
  }
  try {
    if (req.action !== 'submit') return json_(fail_('UNKNOWN_ACTION', '不明な操作です'));
    return json_(submit_(req));
  } catch (err) {
    if (err && err.appCode) return json_(fail_(err.appCode, err.message));
    console.error(err);
    return json_(fail_('SERVER_ERROR', 'サーバーでエラーが発生しました'));
  }
}

/** 回答を1行追記する */
function submit_(req) {
  const userId = String(req.userId == null ? '' : req.userId).trim();
  if (!USER_ID_RE.test(userId)) throw appError_('BAD_USER', 'ユーザーIDの形式が正しくありません');
  const points = Number(req.points);
  if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) throw appError_('BAD_POINTS', 'ポイント数が正しくありません');
  const tierId = text_(req.tierId, 32);
  const tierLabel = text_(req.tierLabel, 50);
  const deviceId = text_(req.deviceId, 36);
  const params = (req.params && typeof req.params === 'object') ? req.params : {};

  const answers = {};
  const src = (req.answers && typeof req.answers === 'object') ? req.answers : {};
  Object.keys(src).slice(0, MAX_ANSWERS).forEach((k) => {
    const key = String(k).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!key) return;
    const v = src[k];
    answers[key] = Array.isArray(v) ? v.map((x) => text_(x, 200)).join(', ') : text_(v, MAX_TEXT);
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', '混雑しています。少し待ってからもう一度お試しください');
  try {
    const sheet = getSheet_();
    const headers = ensureHeaders_(sheet, Object.keys(answers));
    const row = headers.map((h, i) => {
      if (i < FIXED_HEADERS.length) return '';
      return Object.prototype.hasOwnProperty.call(answers, h) ? answers[h] : '';
    });
    row[0] = new Date();
    row[1] = userId;
    row[2] = points;
    row[3] = tierId;
    row[4] = tierLabel;
    row[5] = deviceId;
    row[6] = text_(JSON.stringify(params), MAX_TEXT);
    row[7] = text_(JSON.stringify(answers), 45000);

    const r = sheet.getLastRow() + 1;
    // 日時・ポイント以外は文字列として保存（"=..." が数式になったり、"00123" が数値に化けたりしないように）
    sheet.getRange(r, 1, 1, row.length).setNumberFormat('@');
    sheet.getRange(r, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    sheet.getRange(r, 3).setNumberFormat('0');
    sheet.getRange(r, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** 見出し行を用意し、未登録の設問IDがあれば右端に列を足す。見出しの配列を返す */
function ensureHeaders_(sheet, keys) {
  const lastCol = sheet.getLastColumn();
  let headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  if (headers.length === 0 || headers[0] === '') {
    headers = FIXED_HEADERS.slice();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  const missing = keys.filter((k) => headers.indexOf(k) === -1);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    headers = headers.concat(missing);
  }
  return headers;
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

/** エディタから実行して、Responses シートと見出しを先に作っておく（任意） */
function setupSheet() {
  ensureHeaders_(getSheet_(), []);
  console.log('Responses シートを用意しました');
}

function text_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function appError_(code, message) {
  const err = new Error(message);
  err.appCode = code;
  return err;
}
