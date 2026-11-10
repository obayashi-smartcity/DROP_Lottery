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

  /** GAS に POST する。text/plain で送るのでCORSのプリフライトは発生しない */
  async function call(action, payload) {
    if (!CFG.GAS_URL || CFG.GAS_URL.includes('REPLACE_WITH')) {
      throw new ApiError('NOT_CONFIGURED', 'GASのURLが設定されていません（assets/config.js）');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(CFG.GAS_URL, {
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
    if (!body.ok) {
      const err = body.error || {};
      throw new ApiError(err.code || 'ERROR', err.message || 'エラーが発生しました', body);
    }
    return body;
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

  window.Lottery = { call, ApiError, getDeviceId, getFingerprint, fmtDate, fmtCode, sleep, $, show, lsGet, lsSet };
})();
