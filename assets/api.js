// GAS呼び出し・端末ID・共通の小物
(function () {
  const CFG = window.LOTTERY_CONFIG;
  const DEVICE_KEY = 'drop_lottery_device_id';
  const DB_NAME = 'drop_lottery';
  const STORE = 'kv';

  class ApiError extends Error {
    constructor(code, message, data) {
      super(message);
      this.code = code;
      this.data = data || {};
    }
  }

  /**
   * GAS に POST する。text/plain で送るのでCORSのプリフライトは発生しない。url 省略時は抽選GAS。
   * timeoutMs 省略時は REQUEST_TIMEOUT_MS。
   * エラーコード: NETWORK（通信できない・タイムアウト）、BAD_RESPONSE（JSON でない応答。GAS の同時実行数の上限を超えたときの
   * エラーページなども含む）、それ以外は GAS が返したコード（BUSY など）
   */
  async function call(action, payload, url, timeoutMs) {
    const target = url || CFG.GAS_URL;
    if (!target || target.includes('REPLACE_WITH')) {
      throw new ApiError('NOT_CONFIGURED', 'GASのURLが設定されていません（assets/config.js）');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || CFG.REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(target, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError('NETWORK', '通信できませんでした。電波の良い場所でもう一度お試しください');
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw new ApiError('BAD_RESPONSE', 'サーバーの応答を読み取れませんでした');
    }
    if (!body || typeof body !== 'object') throw new ApiError('BAD_RESPONSE', 'サーバーの応答を読み取れませんでした');
    if (!body.ok) {
      const err = body.error || {};
      throw new ApiError(err.code || 'ERROR', err.message || 'エラーが発生しました', body);
    }
    return body;
  }

  /** 混雑・通信エラーのときに自動で再試行してよいコード（処理ごとに選ぶ） */
  const RETRY_READ = ['BUSY', 'NETWORK', 'BAD_RESPONSE']; // 読み取りだけ（status・info）と、何度呼んでも結果が同じ draw
  const RETRY_BUSY_ONLY = ['BUSY'];                         // BUSY なら何も書かれていない。通信エラーは書けたか分からないので再試行しない

  /**
   * call を自動再試行つきで呼ぶ（D-26: 参加者を待たせるのは合計 RETRY_TOTAL_MS 程度まで）。
   * opts: { url, retryOn（再試行するエラーコードの配列。省略時は RETRY_READ）, onRetry(info) }
   * 待ち時間は RETRY_BASE_MS × 回数（上限 RETRY_MAX_DELAY_MS）に、±50% のランダムなずれ（ジッター）を加える。
   * 通信時間を含めて RETRY_TOTAL_MS を超えそうなら打ち切り、最後のエラーを投げる。
   * onRetry には { attempt（次が何回目か）, code, delayMs } を渡す（画面に「再試行しています」を出すため）
   */
  async function callWithRetry(action, payload, opts) {
    opts = opts || {};
    const retryOn = opts.retryOn || RETRY_READ;
    const total = CFG.RETRY_TOTAL_MS || 30000;
    const base = CFG.RETRY_BASE_MS || 2000;
    const maxDelay = CFG.RETRY_MAX_DELAY_MS || 6000;
    const minLeft = Math.min(5000, total / 3); // 残りがこれより短ければ、もう送らない（応答を待てないため）
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      const left = total - (Date.now() - started);
      try {
        return await call(action, payload, opts.url, Math.max(Math.min(CFG.REQUEST_TIMEOUT_MS, left), 1000));
      } catch (err) {
        if (retryOn.indexOf(err.code) === -1) throw err;
        const wait = Math.min(base * attempt, maxDelay);
        const delayMs = Math.round(wait * (0.5 + Math.random())); // ジッター（同時に失敗した人の再試行がそろわないように）
        if (Date.now() - started + delayMs + minLeft > total) throw err; // 打ち切り
        if (opts.onRetry) { try { opts.onRetry({ attempt: attempt + 1, code: err.code, delayMs }); } catch (e) { /* 表示の失敗は無視 */ } }
        await sleep(delayMs);
      }
    }
  }

  /* ---------- 端末ID（localStorage と IndexedDB の両方に保存） ---------- */

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できない環境 */ } }

  function idb() {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function idbGet(k) {
    const db = await idb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  async function idbSet(k, v) {
    const db = await idb();
    if (!db) return;
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k); } catch (e) { /* ignore */ }
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  async function getDeviceId() {
    let id = lsGet(DEVICE_KEY);
    if (!UUID_RE.test(id || '')) id = await idbGet(DEVICE_KEY);
    if (!UUID_RE.test(id || '')) id = crypto.randomUUID();
    lsSet(DEVICE_KEY, id);
    await idbSet(DEVICE_KEY, id);
    return id.toLowerCase();
  }

  /** 端末特徴のハッシュ（監視用。これだけで拒否はしない） */
  async function getFingerprint() {
    const parts = [
      navigator.userAgent,
      navigator.language,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      `${screen.width}x${screen.height}`,
      window.devicePixelRatio,
      navigator.hardwareConcurrency || '',
      navigator.platform || '',
      navigator.maxTouchPoints || 0,
    ].join('|');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- 表示用 ---------- */

  function fmtDate(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  }

  function fmtCode(code) {
    return code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code || '';
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function $(sel) { return document.querySelector(sel); }

  function show(id) {
    document.querySelectorAll('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== id; });
  }

  /* ---------- 画面間で引き継ぐ状態（LP → アンケート → 抽選）。タブを閉じると消える ---------- */

  const FLOW_KEY = 'drop_lottery_flow';

  function getFlow() {
    try { return JSON.parse(sessionStorage.getItem(FLOW_KEY) || 'null') || {}; } catch (e) { return {}; }
  }
  function setFlow(patch) {
    const next = Object.assign(getFlow(), patch);
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(next)); } catch (e) { /* 保存できない環境 */ }
    return next;
  }
  function clearFlow() {
    try { sessionStorage.removeItem(FLOW_KEY); } catch (e) { /* ignore */ }
  }

  /** スタンプ数に合うボタン（GAS と同じ判定。範囲が重なっていたら上の行を優先） */
  function tierForPoints(tiers, points) {
    return (tiers || []).find((t) => points >= t.min && (t.max === null || t.max === undefined || points <= t.max)) || null;
  }

  function tierRangeText(t) {
    return t.max === null || t.max === undefined ? `${t.min}スタンプ〜` : `${t.min}〜${t.max}スタンプ`;
  }

  function goTo(page) { location.replace(page); }

  /** 「スタンプラリーに戻る」ボタン（.js-rally）に戻り先を入れる。未設定なら隠す */
  document.querySelectorAll('.js-rally').forEach((a) => {
    if (CFG.STAMP_RALLY_URL) a.href = CFG.STAMP_RALLY_URL;
    else a.hidden = true;
  });

  window.Lottery = {
    call, callWithRetry, RETRY_READ, RETRY_BUSY_ONLY, ApiError, getDeviceId, getFingerprint, fmtDate, fmtCode, sleep, $, show, lsGet, lsSet,
    getFlow, setFlow, clearFlow, tierForPoints, tierRangeText, goTo,
  };
})();
