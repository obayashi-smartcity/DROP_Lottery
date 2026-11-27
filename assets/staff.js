// スタッフ画面：ログイン、在庫一覧（旧「引換」タブの QR 読取・引換コード入力は v4.0-05 で外した。D-29）
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const SESSION_KEY = 'drop_lottery_staff';
  const NAME_KEY = 'drop_lottery_staff_name'; // 入力したスタッフ名を端末に覚えておく

  let session = null;
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
    stopStockPoll();
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
    selectTab('stock');
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
      loadStock();
      startStockPoll();
    } else {
      stopStockPoll();
    }
  }

  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  /* ---------- 在庫 ---------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadStock() {
    try {
      const res = await staffCall('stock', {});
      $('#stockBody').innerHTML = res.items.map((i) => `
        <tr class="${i.onHand <= 0 ? 'zero' : ''}">
          <td>${esc(i.name)}${i.consolation ? '<br><small>（はずれ景品）</small>' : ''}</td><td>${i.initial}</td><td>${i.won}</td><td>${i.redeemed}</td>
          <td><strong>${i.onHand}</strong></td><td>${i.remaining}</td>
        </tr>`).join('');
      const t = res.totals;
      $('#totals').innerHTML = `
        <div><dt>抽選数</dt><dd>${t.draws}</dd></div>
        <div><dt>当選数</dt><dd>${t.wins}</dd></div>
        <div><dt>引換数</dt><dd>${t.redeemed}</dd></div>
        <div><dt>当選可能残</dt><dd>${t.prizesLeft}</dd></div>${t.consolationLeft !== undefined ? `
        <div><dt>はずれ景品の配布数</dt><dd>${t.consolations}</dd></div>
        <div><dt>はずれ景品の残り</dt><dd>${t.consolationLeft}</dd></div>` : ''}
        <div><dt>再抽選の試み</dt><dd>${t.repeatRequests}</dd></div>`;
      $('#tierBody').innerHTML = (res.tiers || []).map((x) => `
        <tr><td>${esc(x.label)}</td><td>${x.prob}%</td><td>${x.draws}</td><td>${x.wins}</td></tr>`).join('');
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
