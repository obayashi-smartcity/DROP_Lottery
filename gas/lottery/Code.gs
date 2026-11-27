/**
 * DROP_Lottery 抽選API（Google Apps Script）
 *
 * 画面（GitHub Pages）から POST で呼ばれる。当落判定・在庫・引換はすべてここで行う。
 * 公開設定: デプロイ > ウェブアプリ / 次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *
 * 流れ: LP（スタンプ数でボタンを選ぶ）→ アンケート（別GAS）→ 抽選 → 結果
 *  - 抽選はユーザーIDごとに1回。
 *  - ボタン（Tiers シート）ごとの当選確率で当落を決め、当たりなら Prizes の残りから景品を割り当てる。
 *    通常の景品に当たらなかった人（はずれ・景品切れ）には、はずれ景品（区分「はずれ」）が残っていれば渡す。
 *  - 引換は、当選者が結果画面で引換パスワード（Config の REDEEM_PASSWORD）を入力して行う（スタッフ用の画面はない。D-32）。
 *
 * 初回準備（スクリプトエディタで関数を選んで実行）
 *   setupSheets() … Config の行・Tiers・Users シートと Prizes の集計式を用意（何度実行してもよい）
 */

const SPREADSHEET_ID = '1_mwPTuAW4RHXgUNELKWcoMsGJtJsSJPBjzV0qWzsUHA';

const SHEET = {
  CONFIG: 'Config',
  PRIZES: 'Prizes',
  TIERS: 'Tiers',
  USERS: 'Users',
  WINNERS: 'Winners',
  LOGS: 'Logs',
};

const STATUS = {
  UNREDEEMED: '未引換',
  REDEEMED: '引換済み',
  VOID: '失効',
};

// 列番号（1始まり）
const COL = {
  TIERS: { ID: 1, LABEL: 2, MIN: 3, MAX: 4, PROB: 5 },
  USERS: { ID: 1, FIRST_AT: 2, COUNT: 3, RESULT: 4, TICKET: 5, POINTS: 6, TIER: 7, DEVICE: 8, FP: 9 },
  WINNERS: { TICKET: 1, PRIZE: 2, NAME: 3, CODE: 4, STATUS: 5, WON_AT: 6, REDEEMED_AT: 7, STAFF: 8, DEVICE: 9, USER: 10 },
};

const HEADERS = {
  TIERS: ['tierId', 'ボタン名', '最小ポイント', '最大ポイント', '当選確率(%)', 'メモ'],
  USERS: ['userId', '抽選日時', '抽選要求回数', '結果', 'ticketId', 'ポイント', 'tierId', 'deviceId', '端末特徴ハッシュ'],
};

// Tiers シートが空のときに入れる初期値（確率は仮）
const SAMPLE_TIERS = [
  ['B1', 'ボタン1', 5, 9, 10, '5〜9スタンプ'],
  ['B2', 'ボタン2', 10, 24, 20, '10〜24スタンプ'],
  ['B3', 'ボタン3', 25, 49, 35, '25〜49スタンプ'],
  ['B4', 'ボタン4', 50, '', 50, '50スタンプ以上（最大ポイントが空欄なら上限なし）'],
];

const LOCK_WAIT_MS = 10000;
// ユーザーID（スタンプラリーの account_id）は UUID。大文字・小文字を区別せずに受け付け、小文字にそろえて使う
const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// スタンプ数の上限は Config シートの MAX_POINTS。行がない・空欄・不正な値のときはこの値を使う
const DEFAULT_MAX_POINTS = 10000000;
const DEFAULT_REDEEM_PASSWORD = '0884'; // Config に REDEEM_PASSWORD 行がないときに setupSheets が入れる初期値
// 引換パスワードの入力ミスの上限（ユーザーIDごと）とロック時間。Config の REDEEM_MAX_FAIL（回）・REDEEM_LOCK_MIN（分）で変えられる。
// 行がない・空欄・不正な値（正の整数でない）ときはこの初期値を使う
const SELF_MAX_FAIL = 10;
const SELF_LOCK_SEC = 5 * 60;
const MAX_LOCK_MIN = 360; // CacheService の保持期間の上限（6時間）
// 設定（Config・Tiers・Prizes）のキャッシュ秒数（D-28）。Config を変えてから反映されるまで最大この秒数かかる。
// すぐ反映したいときはエディタで clearSettingsCache を実行する
const SETTINGS_CACHE_SEC = 30;
const SETTINGS_CACHE_KEYS = { CONFIG: 'set:config:v1', TIERS: 'set:tiers:v1', PRIZES: 'set:prizes:v1' };
const CACHE_VALUE_MAX = 100 * 1024; // CacheService の1件の上限（100KB）
// tierId・prizeId は英字で始める（D-30）。appendRow は値の型をシートが推測するので、数字だけの ID は数値に化ける
const SETTING_ID_RE = /^[A-Za-z]/;
const PRIZE_KIND_COL = 8;                  // Prizes の「区分」列（H列）
const CONSOLATION_MARK = 'はずれ';          // 区分がこの値の景品は、P01〜のどれにも当たらなかった人に渡す（はずれ景品）
// D-42: Logs に残すエラー（不正なアクセスやトラブルの調査用）。BAD_REQUEST・UNKNOWN_ACTION は doPost の入口で、
// NOT_CONFIGURED・BAD_USER は各処理から投げられたものを doPost で書く。どれもロックの外で書く
const LOGGED_ERROR_CODES = ['NOT_CONFIGURED', 'BAD_USER'];
const LOG_CLIP_SHORT = 64;  // ログに残す、受け取った値（userId・action など）の長さの上限
const LOG_CLIP_BODY = 200;  // ログに残す、受け取った本文・エラーの文言の長さの上限

/* ============================== 入口 ============================== */

function doGet() {
  return json_({ ok: true, service: 'DROP_Lottery' });
}

function doPost(e) {
  const body = String((e && e.postData && e.postData.contents) || '{}');
  let req = null;
  try {
    req = JSON.parse(body);
  } catch (err) {
    req = null;
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) { // 画面は JSON のオブジェクトを送る
    logRejected_('request', '', 'BAD_REQUEST', `len=${body.length} body=${clip_(body, LOG_CLIP_BODY)}`); // D-42
    return json_(fail_('BAD_REQUEST', 'リクエストの形式が正しくありません'));
  }
  const handlers = {
    info: apiInfo_,
    draw: apiDraw_,
    status: apiStatus_,
    redeemSelf: apiRedeemSelf_,
  };
  const action = typeof req.action === 'string' ? req.action : '';
  // hasOwnProperty で確かめる（"constructor" などの名前で Object の関数を呼ばせない）
  if (!action || !Object.prototype.hasOwnProperty.call(handlers, action)) {
    logRejected_('request', '', 'UNKNOWN_ACTION', `action=${clip_(req.action, LOG_CLIP_SHORT)}`); // D-42
    return json_(fail_('UNKNOWN_ACTION', '不明な操作です'));
  }
  try {
    return json_(handlers[action](req));
  } catch (err) {
    if (err && err.appCode) {
      if (LOGGED_ERROR_CODES.indexOf(err.appCode) !== -1) logAppError_(action, req, err); // D-42
      return json_(fail_(err.appCode, err.message, err.extra));
    }
    console.error(err);
    try { log_('error', req.action, 'NG', String((err && err.stack) || err)); } catch (ignore) {}
    return json_(fail_('SERVER_ERROR', 'サーバーでエラーが発生しました'));
  }
}

/* ============================== 参加者向け ============================== */

/** イベント情報・受付状態・ボタン（Tiers）の一覧。確率は返さない */
function apiInfo_(req) {
  const ss = ss_();
  const cfg = getConfig_(ss);
  const now = new Date();
  return {
    ok: true,
    eventName: cfg.EVENT_NAME,
    open: isOpen_(cfg, now),
    openAt: iso_(cfg.OPEN_AT),
    closeAt: iso_(cfg.CLOSE_AT),
    redeemDeadline: iso_(cfg.REDEEM_DEADLINE),
    now: iso_(now),
    codeRequired: !!cfg.EVENT_CODE, // EVENT_CODE が空なら合言葉なし
    codeValid: !cfg.EVENT_CODE || String(req.eventCode || '') === cfg.EVENT_CODE,
    maxPoints: cfg.MAX_POINTS, // 画面でも同じ上限で確認する
    tiers: getTiers_(ss).map((t) => ({ id: t.id, label: t.label, min: t.min, max: t.max })),
  };
}

/**
 * 抽選。ユーザーIDごとに1回。抽選済みなら前回の結果を返す。
 * ロック（ScriptLock）を持つのは「抽選済みの再確認・当落・景品の選択・追記」の間だけにする（#5）。
 *   ロックの前: 入力の確認、抽選済みの判定（抽選済みなら回数 +1 して返す。ロックは取らない）、受付時間、ボタンの確認、景品の構成の読み込み
 *   ロックの中: 抽選済みの再確認（二重抽選の防止）、Winners を1回読んで当落と景品を決める、Winners・Users に追記、flush
 *   ロックの後: ログ、結果の組み立て
 */
function apiDraw_(req) {
  const userId = requireUserId_(req.userId);
  const ss = ss_();
  const cfg = getConfig_(ss);
  let points;
  try {
    points = requirePoints_(req.points, cfg.MAX_POINTS);
  } catch (err) {
    log_('draw', userId, 'BAD_POINTS', `points=${String(req.points).slice(0, 20)} max=${cfg.MAX_POINTS}`, ss);
    throw err;
  }
  const tierId = String(req.tierId || '').slice(0, 32);
  const deviceId = optionalDeviceId_(req.deviceId);
  const fp = String(req.fp || '').replace(/[^0-9a-f]/gi, '').slice(0, 64);
  const eventCode = String(req.eventCode || '').slice(0, 64);
  if (cfg.EVENT_CODE && eventCode !== cfg.EVENT_CODE) throw appError_('INVALID_CODE', 'イベントコードが正しくありません');

  // ---- ロックの前 ----
  const uSheet = ss.getSheetByName(SHEET.USERS);
  const drawn = readUser_(uSheet, userId);
  if (drawn) return drawRepeat_(ss, cfg, uSheet, drawn, userId);

  if (!isOpen_(cfg, new Date())) throw appError_('CLOSED', '現在は抽選の受付時間外です');
  const tier = tierForPoints_(getTiers_(ss), points);
  if (!tier) throw appError_('NO_TIER', 'スタンプ数が足りないため抽選できません');
  if (tier.id !== tierId) {
    log_('draw', userId, 'BAD_TIER', `tierId=${tierId} points=${points} expected=${tier.id}`, ss);
    throw appError_('BAD_TIER', '選んだボタンとスタンプ数が合いません。最初からやり直してください');
  }
  // 景品の構成（手入力の列）。残り数はロックの中で Winners から数える。
  // prizeId が英字で始まらなければ新規の抽選を止める（D-30。抽選済みの人は上の drawRepeat_ で返るので止まらない）
  const prizes = requirePrizeIds_(getPrizes_(ss));
  const wSheet = ss.getSheetByName(SHEET.WINNERS);

  // ---- ロックの中 ----
  const timing = {};
  const out = withLock_(() => {
    // ロックの前の確認だけに頼らず、もう一度確認する（同じユーザーIDの同時の抽選で二重にならないように）
    if (findRow_(uSheet, COL.USERS.ID, userId)) return { repeat: true };

    const now = new Date();
    const winners = readRows_(wSheet, COL.WINNERS.PRIZE); // ticketId・prizeId。Winners を読むのはこの1回だけ
    const won = countByPrize_(winners);
    const details = [];
    let prize = null;
    let consolation = false;
    if (randomFloat_() * 100 < tier.prob) {
      prize = choosePrize_(prizes, won, false);
      if (!prize) details.push('当選したが景品切れ');
    }
    if (!prize) { // 通常の景品に当たらなかった人には、はずれ景品（残っていれば）
      prize = choosePrize_(prizes, won, true);
      consolation = !!prize;
      if (!prize) details.push('はずれ景品なし');
    }
    let ticketId = '';
    if (prize) {
      ticketId = newTicketId_(winners);
      // appendRow 1回で追加する（D-28）。割り込まれない追加なので、人が末尾に足した行を上書きしない（#11）。
      // 列の書式は引き継がれず値の型はシートが推測するが、入る値は文字列のまま入るので許容する（D-30）
      wSheet.appendRow([ // 引換コード（D列）は発行しない（D-25）
        ticketId, prize.id, prize.name, '', STATUS.UNREDEEMED, now, '', '', deviceId, userId,
      ]);
    }
    uSheet.appendRow([
      userId, now, 1, prize && !consolation ? '当たり' : 'はずれ', ticketId, points, tier.id, deviceId, fp,
    ]);
    SpreadsheetApp.flush();
    return { prize: prize, consolation: consolation, ticketId: ticketId, details: details };
  }, { action: 'draw', actor: userId, ss: ss, timing: timing });

  // ---- ロックの後 ----
  if (out.repeat) { // ロックを待っている間に、同じユーザーIDの抽選が先に終わっていた
    const user = readUser_(uSheet, userId);
    if (!user) throw appError_('NOT_FOUND', '抽選結果が見つかりません。もう一度お試しください');
    return drawRepeat_(ss, cfg, uSheet, user, userId);
  }
  const result = out.consolation ? 'consolation' : (out.prize ? 'win' : 'lose');
  log_('draw', userId, result, [tier.id, points + 'pt', out.ticketId].concat(out.details, [timingText_(timing)]).filter(String).join(' '), ss);
  const w = out.prize ? {
    ticketId: out.ticketId, prizeId: out.prize.id, prizeName: out.prize.name,
    status: STATUS.UNREDEEMED, redeemedAt: '', consolation: out.consolation,
  } : null;
  return Object.assign(buildResult_(ss, cfg, out.ticketId, w), { alreadyDrawn: false });
}

/**
 * 抽選済みの人の再要求。回数 +1・ログ・結果の組み立てをすべてロックの外で行う（D-24）。
 * 同時アクセスで回数が少なく記録されることがあるが、監視の目安として許容する。
 */
function drawRepeat_(ss, cfg, uSheet, user, userId) {
  const ticketId = String(user.values[COL.USERS.TICKET - 1] || '');
  uSheet.getRange(user.row, COL.USERS.COUNT).setValue((Number(user.values[COL.USERS.COUNT - 1]) || 0) + 1);
  log_('draw', userId, 'repeat', ticketId, ss);
  return Object.assign(buildResult_(ss, cfg, ticketId), { alreadyDrawn: true });
}

/** 抽選結果の再表示（ユーザーIDで確認） */
function apiStatus_(req) {
  const userId = requireUserId_(req.userId);
  const ss = ss_();
  const user = readUser_(ss.getSheetByName(SHEET.USERS), userId);
  if (!user) return { ok: true, drawn: false };
  const ticketId = String(user.values[COL.USERS.TICKET - 1] || '');
  return Object.assign(buildResult_(ss, getConfig_(ss), ticketId), { drawn: true });
}

/**
 * 参加者の結果画面で、スタッフが口頭で伝えたパスワードを入れて引き換える。
 * 未引換 → 引換済み を1回だけ行う。パスワードは Config シートの REDEEM_PASSWORD。
 * 口頭で伝えると大文字・小文字が伝わりにくく、先頭を自動で大文字にする端末もあるため、両方を小文字にそろえて比べる。
 * （全角→半角は画面側で NFKC 正規化してから送る）
 *
 * ロックを持つのは、パスワードが正しいときの「行の読み直し・在庫の確認・引換済みへの更新」の間だけにする（#5）。
 *   ロックの前: 失敗回数の上限、当選の検索と状態（引換済み・失効・期限切れ）、パスワードの照合（違えば記録してエラー）
 *   ロックの中: 行の読み直し（行ずれの確認）、未引換の確認、在庫の確認、更新、flush
 *   ロックの後: 失敗回数のリセット、ログ、結果の組み立て
 */
function apiRedeemSelf_(req) {
  const userId = requireUserId_(req.userId);
  const password = String(req.password == null ? '' : req.password).trim().toLowerCase();
  const ss = ss_();
  const cfg = getConfig_(ss);
  if (!cfg.REDEEM_PASSWORD) throw appError_('NOT_CONFIGURED', '引換パスワードが未設定です（スタッフにお知らせください）');

  // ---- ロックの前 ----
  const cache = CacheService.getScriptCache();
  const failKey = 'rfail:' + userId;
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= cfg.REDEEM_MAX_FAIL) {
    log_('redeemSelf', userId, 'LOCKED', `fails=${fails}`, ss);
    throw appError_('LOCKED', `パスワードの入力ミスが続いたため、${cfg.REDEEM_LOCK_MIN}分間は受け取りできません`);
  }

  const user = readUser_(ss.getSheetByName(SHEET.USERS), userId);
  const ticketId = user ? String(user.values[COL.USERS.TICKET - 1] || '') : '';
  const wSheet = ss.getSheetByName(SHEET.WINNERS);
  const w = ticketId ? findWinnerByTicket_(wSheet, ticketId) : null;
  if (!w) throw appError_('NOT_FOUND', '当選が見つかりません');
  if (w.status === STATUS.REDEEMED) return Object.assign(buildResult_(ss, cfg, ticketId, w), { alreadyRedeemed: true });
  if (w.status === STATUS.VOID) throw appError_('VOID', 'この当選は無効になっています');
  if (winnerView_(w, cfg).expired) throw appError_('EXPIRED', '引換期限を過ぎています');

  if (!safeEqual_(password, cfg.REDEEM_PASSWORD.toLowerCase())) { // 違うときはロックを取らない
    cache.put(failKey, String(fails + 1), cfg.REDEEM_LOCK_MIN * 60);
    log_('redeemSelf', userId, 'NG', `パスワード違い ${fails + 1}回目`, ss);
    const left = cfg.REDEEM_MAX_FAIL - fails - 1;
    if (left <= 0) { // この失敗で上限に達した（次からは LOCKED）
      throw appError_('BAD_PASSWORD', `入力ミスが上限に達しました。${cfg.REDEEM_LOCK_MIN}分後にもう一度入力してください`);
    }
    throw appError_('BAD_PASSWORD', `パスワードが違います（あと${left}回）`);
  }
  const prize = getPrizes_(ss).find((p) => p.id === w.prizeId);

  // ---- ロックの中（パスワードが正しいときだけ） ----
  const timing = {};
  const out = withLock_(() => {
    // 行を読み直し、その行が想定どおりの当選かを確かめてから書く（並べ替え・行の挿入による行ずれ対策。#11・#19）
    let row = w.row;
    let cur = readWinner_(wSheet, row);
    let moved = false;
    if (cur.ticketId !== ticketId) { // ずれていたら、その行には書かずに探し直す
      moved = true;
      row = findRow_(wSheet, COL.WINNERS.TICKET, ticketId);
      cur = row ? readWinner_(wSheet, row) : null;
      if (!cur || cur.ticketId !== ticketId) throw appError_('NOT_FOUND', '当選が見つかりません。もう一度お試しください');
    }
    cur.consolation = !!(prize && prize.consolation);
    if (cur.status === STATUS.REDEEMED) return { already: true, w: cur, moved: moved }; // 同時に押された
    if (cur.status === STATUS.VOID) throw appError_('VOID', 'この当選は無効になっています');

    const redeemed = readRows_(wSheet, COL.WINNERS.STATUS)
      .filter((r) => String(r[COL.WINNERS.PRIZE - 1]) === cur.prizeId && r[COL.WINNERS.STATUS - 1] === STATUS.REDEEMED).length;
    if (!prize || prize.initial - redeemed <= 0) throw appError_('OUT_OF_STOCK', 'この景品の在庫がありません（スタッフにお知らせください）');

    const now = new Date();
    wSheet.getRange(row, COL.WINNERS.STATUS).setValue(STATUS.REDEEMED);
    wSheet.getRange(row, COL.WINNERS.REDEEMED_AT, 1, 2).setValues([[now, 'パスワード']]);
    SpreadsheetApp.flush();
    cur.status = STATUS.REDEEMED;
    cur.redeemedAt = now;
    return { already: false, w: cur, moved: moved };
  }, { action: 'redeemSelf', actor: userId, ss: ss, timing: timing });

  // ---- ロックの後 ----
  cache.remove(failKey); // パスワードは正しかった
  const detail = [ticketId, out.moved ? 'row-moved' : '', timingText_(timing)].filter(String).join(' ');
  log_('redeemSelf', userId, out.already ? 'already' : 'OK', detail, ss);
  return Object.assign(buildResult_(ss, cfg, ticketId, out.w), { alreadyRedeemed: out.already });
}

/* ============================== 管理者向け（エディタから実行） ============================== */

/**
 * Tiers・Users シートを用意し、Winners に userId 列、Prizes に集計式を入れる。
 * 既存のデータは消さないので、景品の行を増やしたときも実行してよい。
 */
function setupSheets() {
  const ss = ss_();

  const config = ss.getSheetByName(SHEET.CONFIG);
  const keys = readRows_(config, 1).map((r) => String(r[0]).trim());
  if (keys.indexOf('REDEEM_PASSWORD') === -1) {
    const r = config.getLastRow() + 1;
    config.getRange(r, 2).setNumberFormat('@'); // 先頭の0が消えないよう文字列にする
    config.getRange(r, 1, 1, 3).setValues([['REDEEM_PASSWORD', DEFAULT_REDEEM_PASSWORD, '景品引換のパスワード。スタッフが当選者に伝え、当選者が結果画面で入力する']]);
    console.log('Config に REDEEM_PASSWORD を追加しました');
  }
  if (keys.indexOf('MAX_POINTS') === -1) {
    const r = config.getLastRow() + 1;
    config.getRange(r, 1, 1, 3).setValues([['MAX_POINTS', DEFAULT_MAX_POINTS, 'スタンプ数の上限。これを超える値で来たら抽選できない（画面は「スタンプラリーのページから開いてください」）']]);
    console.log('Config に MAX_POINTS を追加しました');
  }
  if (keys.indexOf('REDEEM_MAX_FAIL') === -1) {
    const r = config.getLastRow() + 1;
    config.getRange(r, 1, 1, 3).setValues([['REDEEM_MAX_FAIL', SELF_MAX_FAIL, '引換パスワードの入力ミスの上限（回、ユーザーIDごと）。この回数間違えると REDEEM_LOCK_MIN 分間は引き換えできない']]);
    console.log('Config に REDEEM_MAX_FAIL を追加しました');
  }
  if (keys.indexOf('REDEEM_LOCK_MIN') === -1) {
    const r = config.getLastRow() + 1;
    config.getRange(r, 1, 1, 3).setValues([['REDEEM_LOCK_MIN', SELF_LOCK_SEC / 60, '引換パスワードの入力ミスが上限に達したときのロック時間（分）。最大 360']]);
    console.log('Config に REDEEM_LOCK_MIN を追加しました');
  }

  let tiers = ss.getSheetByName(SHEET.TIERS);
  if (!tiers) tiers = ss.insertSheet(SHEET.TIERS);
  if (tiers.getLastRow() === 0) {
    tiers.getRange(1, 1, 1, HEADERS.TIERS.length).setValues([HEADERS.TIERS]).setFontWeight('bold');
    tiers.getRange(2, 1, SAMPLE_TIERS.length, HEADERS.TIERS.length).setValues(SAMPLE_TIERS);
    tiers.setFrozenRows(1);
    console.log('Tiers シートを作成しました（確率は仮の値です）');
  }

  let users = ss.getSheetByName(SHEET.USERS);
  if (!users) users = ss.insertSheet(SHEET.USERS);
  if (users.getLastRow() === 0) {
    users.getRange(1, 1, 1, HEADERS.USERS.length).setValues([HEADERS.USERS]).setFontWeight('bold');
    users.setFrozenRows(1);
    console.log('Users シートを作成しました');
  }
  // 抽選は appendRow で行を足す（D-28）。appendRow で足した行には列の書式が引き継がれず、値の型はシートが推測する（v4.0-05 の負荷試験で確認）。
  // 実際に入る値（UUID・W… の ticketId・英字で始まる tierId・16進の端末特徴）は推測されても文字列のままなので許容する（D-30）。
  // 下の文字列書式は、手で入力・修正する行のためのもの（害がないので残す）
  ['A:A', 'E:E', 'G:G', 'H:H', 'I:I'].forEach((a1) => users.getRange(a1).setNumberFormat('@')); // userId・ticketId・tierId・deviceId・端末特徴
  users.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm:ss');

  const winners = ss.getSheetByName(SHEET.WINNERS);
  winners.getRange(1, COL.WINNERS.USER).setValue('userId').setFontWeight('bold');
  // ticketId・引換コード（D-25 から空欄。列の位置を変えないために列は残す。D-43）・deviceId・userId
  ['A:A', 'D:D', 'I:I', 'J:J'].forEach((a1) => winners.getRange(a1).setNumberFormat('@'));

  const prizes = ss.getSheetByName(SHEET.PRIZES);
  prizes.getRange(1, 7).setValue('当選可能残');
  if (prizes.getMaxColumns() < PRIZE_KIND_COL) prizes.insertColumnsAfter(prizes.getMaxColumns(), PRIZE_KIND_COL - prizes.getMaxColumns());
  prizes.getRange(1, PRIZE_KIND_COL).setValue('区分').setFontWeight('bold');
  fillPrizeFormulas_(ss);
  console.log('準備が完了しました');
}

/** 設定（Config・Tiers・Prizes）のキャッシュを消す。Config を変えてすぐ反映したいとき（緊急停止など）にエディタで実行する */
function clearSettingsCache() {
  CacheService.getScriptCache().removeAll(Object.keys(SETTINGS_CACHE_KEYS).map((k) => SETTINGS_CACHE_KEYS[k]));
  console.log('設定のキャッシュを消しました（次の要求からシートを読み直します）');
}

/**
 * テストデータを全部消す（Winners・Users・Logs）。
 * 誤操作防止のため、スクリプト プロパティ ALLOW_RESET に yes を入れたときだけ動く（実行後に自動で消える）。
 */
function resetAllData() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALLOW_RESET') !== 'yes') {
    throw new Error('スクリプト プロパティ ALLOW_RESET に yes を設定してから実行してください');
  }
  const ss = ss_();
  [SHEET.WINNERS, SHEET.USERS, SHEET.LOGS].forEach((name) => {
    const sh = ss.getSheetByName(name);
    if (sh && sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  });
  props.deleteProperty('ALLOW_RESET');
  console.log('テストデータを消去しました');
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

/**
 * ScriptLock を取って fn を実行する。LOCK_WAIT_MS 待っても取れなければ BUSY（Logs に操作名と待った時間を残す）。
 * opt: { action, actor, ss, timing }。timing を渡すと、ロック待ち時間（wait）と保持時間（hold）をミリ秒で入れる
 */
function withLock_(fn, opt) {
  opt = opt || {};
  const lock = LockService.getScriptLock();
  const t0 = Date.now();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    const action = opt.action || 'lock';
    const actor = opt.actor || '';
    const waited = Date.now() - t0;
    // D-27: 実行ログにも出す（匿名アクセスの実行ログは、Cloud プロジェクトに紐づけないと「実行数」画面で見られない。D-27 の補足）。
    // Logs シートへの書き込みは試みるが、失敗してもよい（監視は Logs の BUSY 行を最低限の件数として見る）
    console.warn(`BUSY action=${action} actor=${actor} wait=${waited}ms`);
    try {
      log_(action, actor, 'BUSY', `wait=${waited}ms`, opt.ss);
    } catch (e) {
      console.warn(`BUSY の Logs への書き込みに失敗 action=${action} actor=${actor}: ${(e && e.message) || e}`);
    }
    throw appError_('BUSY', '混雑しています。少し待ってからもう一度お試しください');
  }
  const t1 = Date.now();
  if (opt.timing) opt.timing.wait = t1 - t0;
  try {
    return fn();
  } finally {
    if (opt.timing) opt.timing.hold = Date.now() - t1;
    lock.releaseLock();
  }
}

/** ログの詳細欄に付けるロックの計測値 */
function timingText_(t) {
  return `wait=${t.wait}ms hold=${t.hold}ms`;
}

/**
 * Config シート。ss を渡すと開き直さずに使う。
 * 読み込んだ値は SETTINGS_CACHE_SEC 秒キャッシュする（D-28。変更の反映は最大その秒数遅れる）
 */
function getConfig_(ss) {
  const data = cachedSettings_(SETTINGS_CACHE_KEYS.CONFIG, () => {
    const sheet = (ss || ss_()).getSheetByName(SHEET.CONFIG);
    const range = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 1), 2);
    // パスワードは表示どおりの文字列で比べる（0884 が 884 にならないように）
    return { values: range.getValues(), shown: range.getDisplayValues() };
  });
  const values = data.values;
  const shown = data.shown;
  const cfg = {};
  const disp = {};
  values.forEach((r, i) => {
    if (!r[0]) return;
    const k = String(r[0]).trim();
    cfg[k] = r[1];
    disp[k] = shown[i][1];
  });
  cfg.REDEEM_PASSWORD = String(disp.REDEEM_PASSWORD || '').trim();
  cfg.EVENT_NAME = String(cfg.EVENT_NAME || '');
  cfg.EVENT_CODE = String(cfg.EVENT_CODE || '');
  cfg.OPEN_AT = toDate_(cfg.OPEN_AT);
  cfg.CLOSE_AT = toDate_(cfg.CLOSE_AT);
  cfg.REDEEM_DEADLINE = toDate_(cfg.REDEEM_DEADLINE);
  cfg.ACCEPTING = cfg.ACCEPTING === true || String(cfg.ACCEPTING).toUpperCase() === 'TRUE';
  cfg.MAX_POINTS = toMaxPoints_(cfg.MAX_POINTS);
  cfg.REDEEM_MAX_FAIL = toPositiveInt_(cfg.REDEEM_MAX_FAIL, SELF_MAX_FAIL);
  cfg.REDEEM_LOCK_MIN = Math.min(toPositiveInt_(cfg.REDEEM_LOCK_MIN, SELF_LOCK_SEC / 60), MAX_LOCK_MIN);
  return cfg;
}

/** 正の整数ならその値。行がない・空欄・0 以下・小数・数値でないなら fallback */
function toPositiveInt_(v, fallback) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Config の MAX_POINTS（正の整数）。行がない・空欄・0 以下・不正な値なら DEFAULT_MAX_POINTS（P-04: 0 だと全員が抽選できなくなるため） */
function toMaxPoints_(v) {
  return toPositiveInt_(v, DEFAULT_MAX_POINTS);
}

function isOpen_(cfg, now) {
  if (!cfg.ACCEPTING) return false;
  if (cfg.OPEN_AT && now < cfg.OPEN_AT) return false;
  if (cfg.CLOSE_AT && now > cfg.CLOSE_AT) return false;
  return true;
}

/** Tiers シートのボタン一覧（上から順）。最大ポイント（スタンプ数）が空欄なら上限なし。ID が英字で始まらなければ NOT_CONFIGURED（D-30） */
function getTiers_(ss) {
  const rows = cachedSettings_(SETTINGS_CACHE_KEYS.TIERS, () => {
    const sheet = ss.getSheetByName(SHEET.TIERS);
    if (!sheet) throw appError_('NOT_CONFIGURED', 'Tiers シートがありません（setupSheets を実行してください）');
    return readRows_(sheet, 5);
  });
  return rows
    .filter((r) => String(r[0]).trim() !== '')
    .map((r) => ({
      id: requireSettingId_(String(r[0]).trim(), 'Tiers', 'ボタンID（tierId）'),
      label: String(r[1] || r[0]),
      min: Number(r[2]) || 0,
      max: r[3] === '' || r[3] === null ? null : Number(r[3]),
      prob: Math.min(Math.max(Number(r[4]) || 0, 0), 100),
    }));
}

/**
 * 設定シートの ID（tierId・prizeId）が英字で始まることを確かめる（D-30）。
 * 数字だけの ID は appendRow で数値に化け、照合や在庫の数え方が狂うので、使われる前に止める。
 * tierId は getTiers_ で常に確かめる。prizeId は抽選（apiDraw_）でだけ確かめる（requirePrizeIds_）
 */
function requireSettingId_(id, sheetName, label) {
  if (!SETTING_ID_RE.test(id)) {
    throw appError_('NOT_CONFIGURED', `${sheetName} シートの${label}「${id}」が英字で始まっていません（英字で始まる ID に直してください。スタッフにお知らせください）`);
  }
  return id;
}

/**
 * 設定（Config・Tiers・Prizes）の読み込み結果を CacheService に SETTINGS_CACHE_SEC 秒保存して使い回す（D-28）。
 * キャッシュの読み書きに失敗したらシートから読む（キャッシュがなくても動く）。日付は {$d: ミリ秒} にして保存する。
 * 1件 CACHE_VALUE_MAX（100KB）を超えそうなら保存しない
 */
function cachedSettings_(key, load) {
  let cache = null;
  try {
    cache = CacheService.getScriptCache();
    const hit = cache.get(key);
    if (hit) return decodeCells_(JSON.parse(hit));
  } catch (e) {
    console.warn(`設定のキャッシュを読めませんでした key=${key}: ${(e && e.message) || e}`);
  }
  const data = load();
  try {
    const json = JSON.stringify(encodeCells_(data));
    if (cache && json.length * 3 < CACHE_VALUE_MAX) cache.put(key, json, SETTINGS_CACHE_SEC); // 3倍は UTF-8 の最大バイト数の見積もり
  } catch (e) {
    console.warn(`設定のキャッシュに保存できませんでした key=${key}: ${(e && e.message) || e}`);
  }
  return data;
}

function encodeCells_(v) {
  if (v instanceof Date) return { $d: v.getTime() };
  if (Array.isArray(v)) return v.map(encodeCells_);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = encodeCells_(v[k]); });
    return o;
  }
  return v;
}

function decodeCells_(v) {
  if (Array.isArray(v)) return v.map(decodeCells_);
  if (v && typeof v === 'object') {
    if (typeof v.$d === 'number') return new Date(v.$d);
    const o = {};
    Object.keys(v).forEach((k) => { o[k] = decodeCells_(v[k]); });
    return o;
  }
  return v;
}

/** スタンプ数に合うボタン（範囲が重なっていたら上の行を優先）。なければ null */
function tierForPoints_(tiers, points) {
  return tiers.find((t) => points >= t.min && (t.max === null || points <= t.max)) || null;
}

/** Winners の行（ticketId・prizeId）から、景品ごとの当選数を数える */
function countByPrize_(winners) {
  const won = {};
  winners.forEach((r) => {
    const id = String(r[COL.WINNERS.PRIZE - 1]);
    if (id) won[id] = (won[id] || 0) + 1;
  });
  return won;
}

/**
 * 当選可能残（初期数 − 当選数）の多さに比例して景品を選ぶ。残りがなければ null。
 * consolation が true ならはずれ景品（区分「はずれ」）から、false なら通常の景品から選ぶ。
 * won は countByPrize_ の結果（ロックの中で読んだ Winners から作る）。prizeId は文字列で比べる（#9）
 */
function choosePrize_(prizes, won, consolation) {
  const pool = prizes
    .filter((p) => p.consolation === !!consolation)
    .map((p) => Object.assign({}, p, { left: p.initial - (won[p.id] || 0) }))
    .filter((p) => p.left > 0);
  const total = pool.reduce((s, p) => s + p.left, 0);
  if (total <= 0) return null;
  let n = randomInt_(total);
  for (let i = 0; i < pool.length; i++) {
    if (n < pool[i].left) return pool[i];
    n -= pool[i].left;
  }
  return null;
}

/** ticketId を作る。重複の確認は、ロックの中で読んだ Winners の行を使ってメモリ上で行う */
function newTicketId_(winners) {
  const used = new Set(winners.map((r) => String(r[COL.WINNERS.TICKET - 1])));
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = 'W' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MMdd') + '-' + String(randomInt_(1000000)).padStart(6, '0');
    if (!used.has(id)) return id;
  }
  throw new Error('ticketId を作れませんでした');
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

function requireUserId_(v) {
  const id = String(v == null ? '' : v).trim();
  if (!USER_ID_RE.test(id)) throw appError_('BAD_USER', 'ユーザーIDの形式が正しくありません');
  return id.toLowerCase();
}

function requirePoints_(v, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw appError_('BAD_POINTS', 'スタンプ数が正しくありません');
  return n;
}

function optionalDeviceId_(v) {
  const id = String(v || '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : '';
}

/** 列 col が value と完全一致する最初の行番号（なければ 0） */
function findRow_(sheet, col, value) {
  const last = sheet.getLastRow();
  if (last < 2 || !value) return 0;
  const cell = sheet.getRange(2, col, last - 1, 1).createTextFinder(String(value)).matchEntireCell(true).matchCase(true).findNext();
  return cell ? cell.getRow() : 0;
}

/**
 * Users からユーザーIDの行を探して読む（{ row, values } / なければ null）。
 * 検索してから読むまでに行がずれた場合（並べ替えなど）に備えて、読んだ行のユーザーIDを確かめ、違えば1回だけ探し直す
 */
function readUser_(uSheet, userId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = findRow_(uSheet, COL.USERS.ID, userId);
    if (!row) return null;
    const values = uSheet.getRange(row, 1, 1, COL.USERS.TICKET).getValues()[0];
    if (String(values[COL.USERS.ID - 1]) === userId) return { row: row, values: values };
  }
  return null;
}

function readRows_(sheet, cols) {
  const last = sheet.getLastRow();
  return last < 2 ? [] : sheet.getRange(2, 1, last - 1, cols).getValues();
}

/**
 * Prizes シートの景品の構成（手入力の列）。キャッシュする（残り数は Winners から数えるのでキャッシュしない）。
 * prizeId の確認はここではしない。期間中に景品を足して ID を誤っても、当選済みの人の結果表示（buildResult_）と
 * 引換（apiRedeemSelf_）は止めないため。抽選は requirePrizeIds_ を通す（D-30）
 */
function getPrizes_(ss) {
  const rows = cachedSettings_(SETTINGS_CACHE_KEYS.PRIZES, () => {
    const sheet = ss.getSheetByName(SHEET.PRIZES);
    return readRows_(sheet, Math.min(PRIZE_KIND_COL, sheet.getMaxColumns()));
  });
  return rows
    .filter((r) => r[0] !== '')
    .map((r) => ({
      id: String(r[0]),
      name: String(r[1]),
      initial: Number(r[2]) || 0,
      consolation: String(r[PRIZE_KIND_COL - 1] || '').trim() === CONSOLATION_MARK,
    }));
}

/** 景品の prizeId がすべて英字で始まることを確かめる（D-30）。抽選（apiDraw_）で使う */
function requirePrizeIds_(prizes) {
  prizes.forEach((p) => requireSettingId_(p.id, 'Prizes', '景品ID（prizeId）'));
  return prizes;
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
      `=IF($A${r}="","",MAX(C${r}-D${r},0))`,
    ]);
  }
  sheet.getRange(2, 4, formulas.length, 4).setFormulas(formulas);
}

/** ticketId で当選を探す。なければ null */
function findWinnerByTicket_(sheet, ticketId) {
  const row = findRow_(sheet, COL.WINNERS.TICKET, ticketId);
  return row ? readWinner_(sheet, row) : null;
}

/** Winners の1行を読む */
function readWinner_(sheet, row) {
  const v = sheet.getRange(row, 1, 1, COL.WINNERS.USER).getValues()[0];
  return {
    row: row,
    ticketId: String(v[COL.WINNERS.TICKET - 1]),
    prizeId: String(v[COL.WINNERS.PRIZE - 1]),
    prizeName: String(v[COL.WINNERS.NAME - 1]),
    status: String(v[COL.WINNERS.STATUS - 1]),
    wonAt: v[COL.WINNERS.WON_AT - 1],
    redeemedAt: v[COL.WINNERS.REDEEMED_AT - 1],
    redeemedBy: String(v[COL.WINNERS.STAFF - 1] || ''),
    userId: String(v[COL.WINNERS.USER - 1] || ''),
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
    userId: w.userId,
    expired: expired,
  };
}

/**
 * 参加者に返す抽選結果。w（当選の行の内容）が分かっていれば渡す（シートを読み直さない）。
 * w.consolation が未設定なら Prizes から調べる
 */
function buildResult_(ss, cfg, ticketId, w) {
  const base = { ok: true, eventName: cfg.EVENT_NAME, redeemDeadline: iso_(cfg.REDEEM_DEADLINE) };
  if (!ticketId) return Object.assign(base, { result: 'lose' });
  if (!w) w = findWinnerByTicket_(ss.getSheetByName(SHEET.WINNERS), ticketId);
  if (!w) return Object.assign(base, { result: 'lose' });
  let consolation = w.consolation;
  if (consolation === undefined) {
    const prize = getPrizes_(ss).find((p) => p.id === w.prizeId);
    consolation = !!(prize && prize.consolation);
  }
  return Object.assign(base, {
    result: consolation ? 'lose' : 'win', // はずれ景品は「はずれ」扱い（consolation: true で景品と引換情報を付ける）
    consolation: consolation,
    prizeName: w.prizeName,
    ticketId: w.ticketId, // qr・redeemCode は返さない（D-43。署名と HMAC_SECRET は使わない）
    redeemStatus: w.status,
    redeemedAt: iso_(w.redeemedAt),
  });
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** 0 以上 1 未満の乱数（UUIDの乱数部分を使う） */
function randomFloat_() {
  const hex = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16) / 281474976710656; // 16^12
}

/** 0 以上 n 未満の整数の乱数 */
function randomInt_(n) {
  return Math.floor(randomFloat_() * n);
}

/** Logs に1行追加する。ss を渡すと開き直さずに使う */
function log_(action, actor, result, detail, ss) {
  (ss || ss_()).getSheetByName(SHEET.LOGS).appendRow([new Date(), action, actor, result, detail]);
}

/** Logs に1行追加する。書けなくても例外にしない（D-42 のエラーの記録用。書けなくても応答は返す） */
function logRejected_(action, actor, result, detail) {
  try {
    log_(action, actor, result, detail);
  } catch (e) {
    console.warn(`Logs への書き込みに失敗 action=${action} result=${result}: ${(e && e.message) || e}`);
  }
}

/**
 * D-42: NOT_CONFIGURED（設定のエラー）・BAD_USER（UUID でない ID）を Logs に残す。doPost から呼ぶので、ロックの外。
 * BAD_USER は受け取った値（draw なら deviceId・fp も）を、NOT_CONFIGURED はエラーの文言を詳細に書く
 */
function logAppError_(action, req, err) {
  let actor = '';
  const parts = [];
  if (err.appCode === 'BAD_USER') {
    parts.push(`userId=${clip_(req.userId, LOG_CLIP_SHORT)}`);
    if (action === 'draw') parts.push(`deviceId=${clip_(req.deviceId, LOG_CLIP_SHORT)}`, `fp=${clip_(req.fp, LOG_CLIP_SHORT)}`);
  } else {
    const id = String(req.userId == null ? '' : req.userId).trim();
    if (USER_ID_RE.test(id)) actor = id.toLowerCase();
    parts.push(clip_(err.message, LOG_CLIP_BODY));
  }
  logRejected_(action, actor, err.appCode, parts.join(' '));
}

/**
 * ログに残す受け取った値を、先頭 max 文字の1行にする（長い値・改行・制御文字を送られても大丈夫なように）。
 * 呼ぶ側は「userId=」などの見出しを前に付ける（値が = で始まっても、シートで数式として扱われないように）
 */
function clip_(v, max) {
  const s = typeof v === 'string' ? v : (v === undefined ? '' : JSON.stringify(v));
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);
}
