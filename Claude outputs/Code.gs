/**
 * DROP_Lottery 抽選API（Google Apps Script）
 *
 * 画面（GitHub Pages）から POST で呼ばれる。当落判定・在庫・引換はすべてここで行う。
 * 公開設定: デプロイ > ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *
 * 初回準備（スクリプトエディタで関数を選んで実行）
 *   1. setupSecrets()   … 署名用の秘密鍵とスタッフPINを作成（PINは実行ログに表示）
 *   2. buildTicketBox() … Prizes と Config の TICKET_COUNT からくじ箱を作成
 */

const SPREADSHEET_ID = '1_mwPTuAW4RHXgUNELKWcoMsGJtJsSJPBjzV0qWzsUHA';

const SHEET = {
  CONFIG: 'Config',
  PRIZES: 'Prizes',
  TICKETS: 'Tickets',
  WINNERS: 'Winners',
  DEVICES: 'Devices',
  LOGS: 'Logs',
};

const STATUS = {
  UNUSED: '未使用',
  USED: '使用済み',
  UNREDEEMED: '未引換',
  REDEEMED: '引換済み',
  VOID: '失効',
};

// 列番号（1始まり）
const COL = {
  TICKETS: { ID: 1, PRIZE: 2, STATUS: 3, DEVICE: 4, DRAWN_AT: 5 },
  WINNERS: { TICKET: 1, PRIZE: 2, NAME: 3, CODE: 4, STATUS: 5, WON_AT: 6, REDEEMED_AT: 7, STAFF: 8, DEVICE: 9 },
  DEVICES: { ID: 1, FIRST_AT: 2, COUNT: 3, TICKET: 4, RESULT: 5, FP: 6 },
};

const TOKEN_TTL_SEC = 6 * 60 * 60; // CacheService の上限が6時間
const LOCK_WAIT_MS = 10000;
const PIN_MAX_FAIL = 5;
const PIN_LOCK_SEC = 15 * 60;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい I O 0 1 を除外
const CODE_LENGTH = 6;

/* ============================== 入口 ============================== */

function doGet() {
  return json_({ ok: true, service: 'DROP_Lottery' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_(fail_('BAD_REQUEST', 'リクエストの形式が正しくありません'));
  }
  const handlers = {
    info: apiInfo_,
    draw: apiDraw_,
    status: apiStatus_,
    staffLogin: apiStaffLogin_,
    verify: apiVerify_,
    redeem: apiRedeem_,
    stock: apiStock_,
  };
  const handler = handlers[req.action];
  if (!handler) return json_(fail_('UNKNOWN_ACTION', '不明な操作です'));
  try {
    return json_(handler(req));
  } catch (err) {
    if (err && err.appCode) return json_(fail_(err.appCode, err.message, err.extra));
    console.error(err);
    try { log_('error', req.action, 'NG', String((err && err.stack) || err)); } catch (ignore) {}
    return json_(fail_('SERVER_ERROR', 'サーバーでエラーが発生しました'));
  }
}

/* ============================== 参加者向け ============================== */

/** イベント情報と受付状態 */
function apiInfo_(req) {
  const cfg = getConfig_();
  const now = new Date();
  const res = {
    ok: true,
    eventName: cfg.EVENT_NAME,
    open: isOpen_(cfg, now),
    openAt: iso_(cfg.OPEN_AT),
    closeAt: iso_(cfg.CLOSE_AT),
    redeemDeadline: iso_(cfg.REDEEM_DEADLINE),
    now: iso_(now),
  };
  if (req.eventCode !== undefined) res.codeValid = String(req.eventCode) === cfg.EVENT_CODE;
  return res;
}

/** 抽選。1端末1回。抽選済みの端末には前回の結果を返す */
function apiDraw_(req) {
  const deviceId = requireDeviceId_(req.deviceId);
  const eventCode = String(req.eventCode || '').slice(0, 64);
  const fp = String(req.fp || '').replace(/[^0-9a-f]/gi, '').slice(0, 64);
  const cfg = getConfig_();
  if (eventCode !== cfg.EVENT_CODE) throw appError_('INVALID_CODE', 'イベントコードが正しくありません。会場のQRコードから開き直してください');

  return withLock_(() => {
    const ss = ss_();
    const now = new Date();
    const devSheet = ss.getSheetByName(SHEET.DEVICES);
    const devRow = findRow_(devSheet, COL.DEVICES.ID, deviceId);

    if (devRow) {
      const countCell = devSheet.getRange(devRow, COL.DEVICES.COUNT);
      countCell.setValue(Number(countCell.getValue() || 0) + 1);
      const ticketId = String(devSheet.getRange(devRow, COL.DEVICES.TICKET).getValue() || '');
      log_('draw', deviceId, 'repeat', ticketId);
      return Object.assign(buildResult_(ss, cfg, ticketId), { alreadyDrawn: true });
    }

    if (!isOpen_(cfg, now)) throw appError_('CLOSED', '現在は抽選の受付時間外です');

    const tSheet = ss.getSheetByName(SHEET.TICKETS);
    const lastRow = tSheet.getLastRow();
    let ticketId = '';
    let prizeId = '';
    if (lastRow >= 2) {
      const data = tSheet.getRange(2, 1, lastRow - 1, 3).getValues();
      const unused = [];
      for (let i = 0; i < data.length; i++) {
        if (data[i][COL.TICKETS.STATUS - 1] === STATUS.UNUSED) unused.push(i);
      }
      if (unused.length > 0) {
        const idx = unused[randomInt_(unused.length)];
        ticketId = String(data[idx][COL.TICKETS.ID - 1]);
        prizeId = String(data[idx][COL.TICKETS.PRIZE - 1] || '');
        tSheet.getRange(idx + 2, COL.TICKETS.STATUS, 1, 3).setValues([[STATUS.USED, deviceId, now]]);
      }
    }

    if (prizeId) {
      const prize = getPrizes_(ss).find((p) => p.id === prizeId);
      const code = newRedeemCode_(ss);
      ss.getSheetByName(SHEET.WINNERS).appendRow([
        ticketId, prizeId, prize ? prize.name : prizeId, code, STATUS.UNREDEEMED, now, '', '', deviceId,
      ]);
    }
    devSheet.appendRow([deviceId, now, 1, ticketId, prizeId ? '当たり' : 'はずれ', fp]);
    SpreadsheetApp.flush();
    log_('draw', deviceId, prizeId ? 'win' : 'lose', ticketId || '(くじ切れ)');
    return Object.assign(buildResult_(ss, cfg, prizeId ? ticketId : ''), { alreadyDrawn: false });
  });
}

/** 自分の抽選結果の再表示 */
function apiStatus_(req) {
  const deviceId = requireDeviceId_(req.deviceId);
  const ss = ss_();
  const devSheet = ss.getSheetByName(SHEET.DEVICES);
  const devRow = findRow_(devSheet, COL.DEVICES.ID, deviceId);
  if (!devRow) return { ok: true, drawn: false };
  const ticketId = String(devSheet.getRange(devRow, COL.DEVICES.TICKET).getValue() || '');
  return Object.assign(buildResult_(ss, getConfig_(), ticketId), { drawn: true });
}

/* ============================== スタッフ向け ============================== */

function apiStaffLogin_(req) {
  const name = String(req.staffName || '').trim().slice(0, 20);
  const pin = String(req.pin || '');
  if (!name) throw appError_('BAD_REQUEST', 'スタッフ名を入力してください');
  const expected = PropertiesService.getScriptProperties().getProperty('STAFF_PIN');
  if (!expected) throw appError_('NOT_CONFIGURED', 'スタッフPINが未設定です（setupSecrets を実行してください）');

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinfail') || 0);
  if (fails >= PIN_MAX_FAIL) throw appError_('LOCKED', 'PINの入力ミスが続いたため、15分間ログインできません');

  if (!safeEqual_(pin, expected)) {
    cache.put('pinfail', String(fails + 1), PIN_LOCK_SEC);
    log_('staffLogin', name, 'NG', `失敗 ${fails + 1}回目`);
    throw appError_('BAD_PIN', `PINが違います（あと${PIN_MAX_FAIL - fails - 1}回）`);
  }
  cache.remove('pinfail');
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('tok:' + token, name, TOKEN_TTL_SEC);
  log_('staffLogin', name, 'OK', '');
  return { ok: true, token: token, staffName: name, expiresInSec: TOKEN_TTL_SEC };
}

/** QR または引換コードから当選内容を確認（状態は変えない） */
function apiVerify_(req) {
  const staff = requireStaff_(req.token);
  const ss = ss_();
  const w = findWinner_(ss, req);
  log_('verify', staff, w.status, w.ticketId);
  return Object.assign({ ok: true }, winnerView_(w, getConfig_()));
}

/** 引き渡し完了。未引換 → 引換済み を1回だけ行う */
function apiRedeem_(req) {
  const staff = requireStaff_(req.token);
  const cfg = getConfig_();
  return withLock_(() => {
    const ss = ss_();
    const w = findWinner_(ss, req); // ロック内で最新の状態を読み直す
    const view = winnerView_(w, cfg);
    if (w.status === STATUS.REDEEMED) throw appError_('ALREADY_REDEEMED', 'この当選はすでに引換済みです', view);
    if (w.status === STATUS.VOID) throw appError_('VOID', 'この当選は無効になっています', view);
    if (view.expired) throw appError_('EXPIRED', '引換期限を過ぎています', view);

    const prize = getPrizes_(ss).find((p) => p.id === w.prizeId);
    const redeemed = countWinners_(ss, w.prizeId, STATUS.REDEEMED);
    if (!prize || prize.initial - redeemed <= 0) throw appError_('OUT_OF_STOCK', 'この景品の在庫がありません', view);

    const now = new Date();
    const sheet = ss.getSheetByName(SHEET.WINNERS);
    sheet.getRange(w.row, COL.WINNERS.STATUS).setValue(STATUS.REDEEMED);
    sheet.getRange(w.row, COL.WINNERS.REDEEMED_AT, 1, 2).setValues([[now, staff]]);
    SpreadsheetApp.flush();
    log_('redeem', staff, 'OK', w.ticketId);
    return Object.assign({ ok: true }, view, { status: STATUS.REDEEMED, redeemedAt: iso_(now), redeemedBy: staff });
  });
}

/** 在庫一覧と不正の兆候 */
function apiStock_(req) {
  requireStaff_(req.token);
  const ss = ss_();
  const prizes = getPrizes_(ss);
  const winners = readRows_(ss.getSheetByName(SHEET.WINNERS), 9);
  const tickets = readRows_(ss.getSheetByName(SHEET.TICKETS), 3);
  const devices = readRows_(ss.getSheetByName(SHEET.DEVICES), 6);

  const items = prizes.map((p) => {
    const won = winners.filter((r) => r[COL.WINNERS.PRIZE - 1] === p.id).length;
    const redeemed = winners.filter((r) => r[COL.WINNERS.PRIZE - 1] === p.id && r[COL.WINNERS.STATUS - 1] === STATUS.REDEEMED).length;
    const unusedInBox = tickets.filter((r) => r[COL.TICKETS.PRIZE - 1] === p.id && r[COL.TICKETS.STATUS - 1] === STATUS.UNUSED).length;
    return { prizeId: p.id, name: p.name, initial: p.initial, won: won, redeemed: redeemed, onHand: p.initial - redeemed, unusedInBox: unusedInBox };
  });

  const fpCount = {};
  devices.forEach((r) => {
    const fp = String(r[COL.DEVICES.FP - 1] || '');
    if (fp) fpCount[fp] = (fpCount[fp] || 0) + 1;
  });
  const fpDuplicates = Object.keys(fpCount)
    .filter((k) => fpCount[k] > 1)
    .map((k) => ({ fp: k.slice(0, 8), devices: fpCount[k] }))
    .sort((a, b) => b.devices - a.devices);

  return {
    ok: true,
    items: items,
    totals: {
      draws: devices.length,
      wins: winners.length,
      redeemed: winners.filter((r) => r[COL.WINNERS.STATUS - 1] === STATUS.REDEEMED).length,
      ticketsLeft: tickets.filter((r) => r[COL.TICKETS.STATUS - 1] === STATUS.UNUSED).length,
      repeatRequests: devices.filter((r) => Number(r[COL.DEVICES.COUNT - 1]) > 1).length,
    },
    fpDuplicates: fpDuplicates,
    updatedAt: iso_(new Date()),
  };
}

/* ============================== 管理者向け（エディタから実行） ============================== */

/** 署名用の秘密鍵とスタッフPINを作成する。既にあれば変更しない */
function setupSecrets() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('HMAC_SECRET')) {
    props.setProperty('HMAC_SECRET', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
    console.log('HMAC_SECRET を作成しました');
  }
  if (!props.getProperty('STAFF_PIN')) {
    let pin = '';
    for (let i = 0; i < 6; i++) pin += String(randomInt_(10));
    props.setProperty('STAFF_PIN', pin);
    console.log('STAFF_PIN を作成しました: ' + pin + '（プロジェクトの設定 > スクリプト プロパティで変更できます）');
  } else {
    console.log('STAFF_PIN は設定済みです（プロジェクトの設定 > スクリプト プロパティで確認・変更）');
  }
}

/**
 * くじ箱を作る。Prizes の初期数ぶんの当たりと、TICKET_COUNT までのはずれを混ぜて Tickets に書く。
 * 抽選が始まった後（使用済みのくじがある）は実行できない。
 */
function buildTicketBox() {
  const ss = ss_();
  const cfg = getConfig_();
  const tSheet = ss.getSheetByName(SHEET.TICKETS);
  const existing = readRows_(tSheet, 3);
  if (existing.some((r) => r[COL.TICKETS.STATUS - 1] === STATUS.USED)) {
    throw new Error('使用済みのくじがあるため作り直せません。テストをやり直す場合は resetAllData を使ってください');
  }

  const prizes = getPrizes_(ss).filter((p) => p.initial > 0);
  const totalPrizes = prizes.reduce((s, p) => s + p.initial, 0);
  const count = Number(cfg.TICKET_COUNT);
  if (!(count > 0)) throw new Error('Config の TICKET_COUNT を設定してください');
  if (totalPrizes > count) throw new Error(`景品の初期数合計（${totalPrizes}）が TICKET_COUNT（${count}）を超えています`);

  const box = [];
  prizes.forEach((p) => { for (let i = 0; i < p.initial; i++) box.push(p.id); });
  while (box.length < count) box.push('');
  for (let i = box.length - 1; i > 0; i--) { // Fisher–Yates
    const j = randomInt_(i + 1);
    const t = box[i]; box[i] = box[j]; box[j] = t;
  }
  const rows = box.map((prizeId, i) => ['T' + String(i + 1).padStart(4, '0'), prizeId, STATUS.UNUSED, '', '']);

  if (tSheet.getLastRow() >= 2) tSheet.getRange(2, 1, tSheet.getLastRow() - 1, 5).clearContent();
  if (tSheet.getMaxRows() < count + 1) tSheet.insertRowsAfter(tSheet.getMaxRows(), count + 1 - tSheet.getMaxRows());
  tSheet.getRange(2, 1, rows.length, 5).setValues(rows);

  fillPrizeFormulas_(ss);
  log_('buildTicketBox', 'admin', 'OK', `くじ${count}枚（当たり${totalPrizes}枚）`);
  console.log(`くじ箱を作成しました: ${count}枚（当たり${totalPrizes}枚）`);
}

/**
 * テストデータを全部消す（Tickets・Winners・Devices・Logs）。
 * 誤操作防止のため、スクリプト プロパティ ALLOW_RESET に yes を入れたときだけ動く（実行後に自動で消える）。
 */
function resetAllData() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALLOW_RESET') !== 'yes') {
    throw new Error('スクリプト プロパティ ALLOW_RESET に yes を設定してから実行してください');
  }
  const ss = ss_();
  [SHEET.TICKETS, SHEET.WINNERS, SHEET.DEVICES, SHEET.LOGS].forEach((name) => {
    const sh = ss.getSheetByName(name);
    if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  });
  props.deleteProperty('ALLOW_RESET');
  console.log('テストデータを消去しました。続けて buildTicketBox を実行してください');
}

/* ============================== 内部処理 ============================== */

function ss_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message, extra) {
  return Object.assign({ ok: false, error: { code: code, message: message } }, extra || {});
}

function appError_(code, message, extra) {
  const err = new Error(message);
  err.appCode = code;
  err.extra = extra;
  return err;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw appError_('BUSY', '混雑しています。少し待ってからもう一度お試しください');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getConfig_() {
  const sheet = ss_().getSheetByName(SHEET.CONFIG);
  const values = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2).getValues();
  const cfg = {};
  values.forEach((r) => { if (r[0]) cfg[String(r[0]).trim()] = r[1]; });
  cfg.EVENT_NAME = String(cfg.EVENT_NAME || '');
  cfg.EVENT_CODE = String(cfg.EVENT_CODE || '');
  cfg.OPEN_AT = toDate_(cfg.OPEN_AT);
  cfg.CLOSE_AT = toDate_(cfg.CLOSE_AT);
  cfg.REDEEM_DEADLINE = toDate_(cfg.REDEEM_DEADLINE);
  cfg.ACCEPTING = cfg.ACCEPTING === true || String(cfg.ACCEPTING).toUpperCase() === 'TRUE';
  return cfg;
}

function isOpen_(cfg, now) {
  if (!cfg.ACCEPTING) return false;
  if (cfg.OPEN_AT && now < cfg.OPEN_AT) return false;
  if (cfg.CLOSE_AT && now > cfg.CLOSE_AT) return false;
  return true;
}

function toDate_(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  const d = new Date(String(v).replace(/\//g, '-').replace(' ', 'T') + '+09:00');
  return isNaN(d.getTime()) ? null : d;
}

function iso_(d) {
  return d instanceof Date ? d.toISOString() : null;
}

function requireDeviceId_(v) {
  const id = String(v || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw appError_('BAD_DEVICE', '端末情報を確認できませんでした。ページを開き直してください');
  }
  return id.toLowerCase();
}

function requireStaff_(token) {
  const t = String(token || '');
  const name = t ? CacheService.getScriptCache().get('tok:' + t) : null;
  if (!name) throw appError_('AUTH', 'ログインの有効期限が切れました。ログインし直してください');
  return name;
}

/** 列 col が value と完全一致する最初の行番号（なければ 0） */
function findRow_(sheet, col, value) {
  const last = sheet.getLastRow();
  if (last < 2 || !value) return 0;
  const cell = sheet.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findNext();
  return cell ? cell.getRow() : 0;
}

function readRows_(sheet, cols) {
  const last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, cols).getValues();
}

function getPrizes_(ss) {
  return readRows_(ss.getSheetByName(SHEET.PRIZES), 3)
    .filter((r) => r[0] !== '')
    .map((r) => ({ id: String(r[0]), name: String(r[1]), initial: Number(r[2]) || 0 }));
}

function countWinners_(ss, prizeId, status) {
  return readRows_(ss.getSheetByName(SHEET.WINNERS), COL.WINNERS.STATUS)
    .filter((r) => r[COL.WINNERS.PRIZE - 1] === prizeId && r[COL.WINNERS.STATUS - 1] === status).length;
}

function fillPrizeFormulas_(ss) {
  const sheet = ss.getSheetByName(SHEET.PRIZES);
  const last = sheet.getLastRow();
  if (last < 2) return;
  const formulas = [];
  for (let r = 2; r <= last; r++) {
    formulas.push([
      `=IF($A${r}="","",COUNTIF(Winners!$B:$B,$A${r}))`,
      `=IF($A${r}="","",COUNTIFS(Winners!$B:$B,$A${r},Winners!$E:$E,"${STATUS.REDEEMED}"))`,
      `=IF($A${r}="","",C${r}-E${r})`,
      `=IF($A${r}="","",COUNTIFS(Tickets!$B:$B,$A${r},Tickets!$C:$C,"${STATUS.UNUSED}"))`,
    ]);
  }
  sheet.getRange(2, 4, formulas.length, 4).setFormulas(formulas);
}

/** 当選を ticketId（QR）または引換コードで探す */
function findWinner_(ss, req) {
  const sheet = ss.getSheetByName(SHEET.WINNERS);
  let row = 0;
  if (req.qr) {
    const qr = String(req.qr).trim();
    const dot = qr.lastIndexOf('.');
    const ticketId = dot > 0 ? qr.slice(0, dot) : '';
    const sig = dot > 0 ? qr.slice(dot + 1) : '';
    if (!ticketId || !safeEqual_(sig, sign_(ticketId))) throw appError_('BAD_SIGNATURE', 'このQRコードは無効です（署名が一致しません）');
    row = findRow_(sheet, COL.WINNERS.TICKET, ticketId);
  } else if (req.code) {
    const code = String(req.code).toUpperCase().replace(/[\s-]/g, '');
    if (!new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`).test(code)) throw appError_('BAD_CODE', '引換コードの形式が正しくありません');
    row = findRow_(sheet, COL.WINNERS.CODE, code);
  } else {
    throw appError_('BAD_REQUEST', 'QRコードか引換コードを指定してください');
  }
  if (!row) throw appError_('NOT_FOUND', '該当する当選が見つかりません');
  const v = sheet.getRange(row, 1, 1, 9).getValues()[0];
  return {
    row: row,
    ticketId: String(v[COL.WINNERS.TICKET - 1]),
    prizeId: String(v[COL.WINNERS.PRIZE - 1]),
    prizeName: String(v[COL.WINNERS.NAME - 1]),
    code: String(v[COL.WINNERS.CODE - 1]),
    status: String(v[COL.WINNERS.STATUS - 1]),
    wonAt: v[COL.WINNERS.WON_AT - 1],
    redeemedAt: v[COL.WINNERS.REDEEMED_AT - 1],
    redeemedBy: String(v[COL.WINNERS.STAFF - 1] || ''),
  };
}

function winnerView_(w, cfg) {
  const expired = w.status === STATUS.UNREDEEMED && !!cfg.REDEEM_DEADLINE && new Date() > cfg.REDEEM_DEADLINE;
  return {
    ticketId: w.ticketId,
    prizeName: w.prizeName,
    status: w.status,
    wonAt: iso_(w.wonAt),
    redeemedAt: iso_(w.redeemedAt),
    redeemedBy: w.redeemedBy,
    expired: expired,
  };
}

/** 参加者に返す抽選結果 */
function buildResult_(ss, cfg, ticketId) {
  const base = { ok: true, eventName: cfg.EVENT_NAME, redeemDeadline: iso_(cfg.REDEEM_DEADLINE) };
  if (!ticketId) return Object.assign(base, { result: 'lose' });
  const row = findRow_(ss.getSheetByName(SHEET.WINNERS), COL.WINNERS.TICKET, ticketId);
  if (!row) return Object.assign(base, { result: 'lose' });
  const w = findWinner_(ss, { qr: ticketId + '.' + sign_(ticketId) });
  return Object.assign(base, {
    result: 'win',
    prizeName: w.prizeName,
    ticketId: w.ticketId,
    qr: w.ticketId + '.' + sign_(w.ticketId),
    redeemCode: w.code,
    redeemStatus: w.status,
    redeemedAt: iso_(w.redeemedAt),
  });
}

function newRedeemCode_(ss) {
  const sheet = ss.getSheetByName(SHEET.WINNERS);
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_CHARS.charAt(randomInt_(CODE_CHARS.length));
    if (!findRow_(sheet, COL.WINNERS.CODE, code)) return code;
  }
  throw new Error('引換コードを作れませんでした');
}

function sign_(ticketId) {
  const secret = PropertiesService.getScriptProperties().getProperty('HMAC_SECRET');
  if (!secret) throw appError_('NOT_CONFIGURED', '署名用の秘密鍵が未設定です（setupSecrets を実行してください）');
  const bytes = Utilities.computeHmacSha256Signature(String(ticketId), secret);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '').slice(0, 22);
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 0 以上 n 未満の乱数（UUIDの乱数部分を使う） */
function randomInt_(n) {
  const hex = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16) % n;
}

function log_(action, actor, result, detail) {
  ss_().getSheetByName(SHEET.LOGS).appendRow([new Date(), action, actor, result, detail]);
}
