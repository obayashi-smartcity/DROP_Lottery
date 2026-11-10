// スタッフ画面：ログイン、QR読取 → 確認 → 引き渡し完了、在庫一覧
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const SESSION_KEY = 'drop_lottery_staff';
  const NAME_KEY = 'drop_lottery_staff_name'; // 入力したスタッフ名を端末に覚えておく

  let session = null;
  let scanner = null;
  let scanning = false;
  let busy = false;
  let lastQuery = null; // 確認中の { qr } または { code }
  let stockTimer = null;

  /* ---------- セッション ---------- */

  function loadSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (s && s.exp > Date.now()) return s;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveSession(s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  async function logout(message) {
    session = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    await stopScanner();
    stopStockPoll();
    closeSheet(false);
    $('#staffInfo').hidden = true;
    $('#pin').value = '';
    $('#loginError').textContent = message || '';
    L.show('login');
  }

  /** スタッフ用API。トークン切れならログイン画面へ戻す */
  async function staffCall(action, payload) {
    try {
      return await L.call(action, Object.assign({ token: session && session.token }, payload));
    } catch (err) {
      if (err.code === 'AUTH') await logout(err.message);
      throw err;
    }
  }

  function enterMain() {
    $('#staffInfo').textContent = `${session.name} さんでログイン中`;
    $('#staffInfo').hidden = false;
    L.show('main');
    selectTab('scan');
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#loginForm button');
    btn.disabled = true;
    $('#loginError').textContent = '';
    try {
      const typedName = $('#staffName').value.trim();
      const res = await L.call('staffLogin', { staffName: typedName, pin: $('#pin').value });
      if (typedName) L.lsSet(NAME_KEY, typedName);
      else { try { localStorage.removeItem(NAME_KEY); } catch (err) { /* ignore */ } }
      session = { token: res.token, name: res.staffName, exp: Date.now() + res.expiresInSec * 1000 - 60000 };
      saveSession(session);
      $('#pin').value = '';
      enterMain();
    } catch (err) {
      $('#loginError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#logoutBtn').addEventListener('click', () => logout());

  /* ---------- タブ ---------- */

  function selectTab(name) {
    document.querySelectorAll('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'stock') {
      stopScanner();
      loadStock();
      startStockPoll();
    } else {
      stopStockPoll();
    }
  }

  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  /* ---------- QR読取 ---------- */

  async function startScanner() {
    if (scanning) return;
    $('#scanError').textContent = '';
    try {
      if (!scanner) scanner = new Html5Qrcode('reader');
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, onScan, () => {});
      scanning = true;
      $('#cameraBtn').textContent = 'カメラを停止';
    } catch (e) {
      $('#scanError').textContent = 'カメラを起動できません。ブラウザのカメラ許可を確認するか、引換コードを入力してください';
    }
  }

  async function stopScanner() {
    if (!scanner || !scanning) return;
    try { await scanner.stop(); } catch (e) { /* ignore */ }
    scanning = false;
    $('#cameraBtn').textContent = 'カメラを起動';
  }

  function pauseScanner() {
    if (scanner && scanning) { try { scanner.pause(true); } catch (e) { /* ignore */ } }
  }

  function resumeScanner() {
    if (scanner && scanning) { try { scanner.resume(); } catch (e) { /* ignore */ } }
  }

  $('#cameraBtn').addEventListener('click', () => (scanning ? stopScanner() : startScanner()));

  function onScan(text) {
    if (busy || !$('#sheet').hidden) return;
    if (navigator.vibrate) navigator.vibrate(80);
    pauseScanner();
    verify({ qr: text.trim() });
  }

  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#codeInput').value.toUpperCase().replace(/[\s-]/g, '');
    if (!code) return;
    pauseScanner();
    verify({ code });
  });

  /* ---------- 確認と引換 ---------- */

  async function verify(query) {
    if (busy) return;
    busy = true;
    lastQuery = query;
    $('#scanError').textContent = '';
    try {
      const res = await staffCall('verify', query);
      openSheet(res);
    } catch (err) {
      if (err.code !== 'AUTH') openSheetError(err.message);
    } finally {
      busy = false;
    }
  }

  function openSheet(v, justRedeemed) {
    const badge = $('#sheetBadge');
    const redeemBtn = $('#redeemBtn');
    $('#sheetPrize').textContent = v.prizeName || '';
    let canRedeem = false;
    if (justRedeemed) {
      badge.textContent = '引き渡し完了';
      badge.className = 'badge badge-win';
      $('#sheetDetail').textContent = '景品をお渡しください。';
    } else if (v.status === '引換済み') {
      badge.textContent = '引換済み・渡さないでください';
      badge.className = 'badge badge-ng';
      $('#sheetDetail').textContent = `${L.fmtDate(v.redeemedAt)} に ${v.redeemedBy || '不明'} さんが引換済み`;
    } else if (v.status === '失効') {
      badge.textContent = '無効';
      badge.className = 'badge badge-ng';
      $('#sheetDetail').textContent = 'この当選は無効になっています。';
    } else if (v.expired) {
      badge.textContent = '引換期限切れ';
      badge.className = 'badge badge-ng';
      $('#sheetDetail').textContent = '引換期限を過ぎています。';
    } else {
      badge.textContent = '未引換';
      badge.className = 'badge badge-ok';
      $('#sheetDetail').textContent = `当選：${L.fmtDate(v.wonAt)}`;
      canRedeem = true;
    }
    redeemBtn.hidden = !canRedeem;
    redeemBtn.disabled = false;
    $('#sheet').hidden = false;
  }

  function openSheetError(message) {
    $('#sheetBadge').textContent = '確認できません';
    $('#sheetBadge').className = 'badge badge-ng';
    $('#sheetPrize').textContent = '';
    $('#sheetDetail').textContent = message;
    $('#redeemBtn').hidden = true;
    $('#sheet').hidden = false;
  }

  function closeSheet(resume) {
    $('#sheet').hidden = true;
    $('#codeInput').value = '';
    lastQuery = null;
    if (resume !== false) resumeScanner();
  }

  $('#redeemBtn').addEventListener('click', async () => {
    if (busy || !lastQuery) return;
    busy = true;
    $('#redeemBtn').disabled = true; // 二重押し防止
    try {
      const res = await staffCall('redeem', lastQuery);
      openSheet(res, true);
    } catch (err) {
      if (err.code === 'AUTH') return;
      if (err.data && err.data.status) openSheet(err.data);
      else openSheetError(err.message);
    } finally {
      busy = false;
    }
  });

  $('#sheetClose').addEventListener('click', () => closeSheet());

  /* ---------- 在庫 ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadStock() {
    try {
      const res = await staffCall('stock', {});
      $('#stockBody').innerHTML = res.items.map((i) => `
        <tr class="${i.onHand <= 0 ? 'zero' : ''}">
          <td>${esc(i.name)}</td><td>${i.initial}</td><td>${i.won}</td><td>${i.redeemed}</td>
          <td><strong>${i.onHand}</strong></td><td>${i.unusedInBox}</td>
        </tr>`).join('');
      const t = res.totals;
      $('#totals').innerHTML = `
        <div><dt>抽選数</dt><dd>${t.draws}</dd></div>
        <div><dt>当選数</dt><dd>${t.wins}</dd></div>
        <div><dt>引換数</dt><dd>${t.redeemed}</dd></div>
        <div><dt>くじ箱残</dt><dd>${t.ticketsLeft}</dd></div>
        <div><dt>再抽選の試み</dt><dd>${t.repeatRequests}</dd></div>`;
      const warn = $('#fpWarn');
      if (res.fpDuplicates.length) {
        warn.innerHTML = `<strong>同じ特徴の端末から複数の抽選があります</strong>（同機種の別人の場合もあります）<br>` +
          res.fpDuplicates.slice(0, 5).map((d) => `${esc(d.fp)}… : ${d.devices}台`).join('<br>');
        warn.hidden = false;
      } else {
        warn.hidden = true;
      }
      $('#stockUpdated').textContent = `更新：${L.fmtDate(res.updatedAt)}`;
    } catch (err) {
      if (err.code !== 'AUTH') $('#stockUpdated').textContent = err.message;
    }
  }

  function startStockPoll() {
    stopStockPoll();
    stockTimer = setInterval(() => { if (!document.hidden) loadStock(); }, CFG.STOCK_POLL_MS);
  }

  function stopStockPoll() {
    if (stockTimer) clearInterval(stockTimer);
    stockTimer = null;
  }

  $('#stockRefresh').addEventListener('click', loadStock);

  /* ---------- 起動 ---------- */

  $('#staffName').value = L.lsGet(NAME_KEY) || '';

  session = loadSession();
  if (session) enterMain();
  else L.show('login');
})();
