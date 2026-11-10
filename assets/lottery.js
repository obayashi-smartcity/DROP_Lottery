// 参加者画面。抽選APIを呼ぶタイミングと演出はこの画面が制御する
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const RESULT_KEY = 'drop_lottery_result';
  const CODE_KEY = 'drop_lottery_event_code';
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stage = $('#stage');
  const coreText = $('#coreText');

  let deviceId = null;
  let eventCode = '';
  let drawing = false;
  let pollTimer = null;

  /* ---------- 演出 ---------- */

  function setStage(state, text) {
    stage.dataset.state = state;
    if (text !== undefined) coreText.textContent = text;
  }

  const DRAW_LINES = ['まぜています', '運をあつめています', 'もうすぐです', 'いよいよ…！'];

  function startDrawingText() {
    const el = $('#drawingText');
    let i = 0;
    el.textContent = DRAW_LINES[0];
    const t = setInterval(() => {
      i = Math.min(i + 1, DRAW_LINES.length - 1);
      el.textContent = DRAW_LINES[i];
    }, 750);
    return () => clearInterval(t);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  }

  /** ロゴの5色で紙吹雪を降らせる */
  function confetti() {
    if (REDUCED) return;
    const canvas = $('#confetti');
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = innerWidth, H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#F2803A', '#F6CF3A', '#F49AC1', '#43B26E', '#46B4E3'];
    const rect = stage.getBoundingClientRect();
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height / 2;
    const parts = Array.from({ length: 150 }, () => {
      const a = Math.random() * Math.PI * 2;
      const v = 6 + Math.random() * 9;
      return {
        x: ox, y: oy,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6,
        s: 6 + Math.random() * 8,
        r: Math.random() * Math.PI, vr: (Math.random() - .5) * .3,
        c: colors[(Math.random() * colors.length) | 0],
        oct: Math.random() < .35,
      };
    });
    const start = performance.now();
    function octagon(s) {
      const k = s * .29, e = s / 2;
      ctx.beginPath();
      ctx.moveTo(-e + k, -e); ctx.lineTo(e - k, -e); ctx.lineTo(e, -e + k); ctx.lineTo(e, e - k);
      ctx.lineTo(e - k, e); ctx.lineTo(-e + k, e); ctx.lineTo(-e, e - k); ctx.lineTo(-e, -e + k);
      ctx.closePath(); ctx.fill();
    }
    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.max(0, 1 - t / 3800);
      parts.forEach((p) => {
        p.vx *= .985; p.vy = p.vy * .985 + .32;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        if (p.oct) octagon(p.s);
        else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (t < 3800) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  /** 抽選中 → 集まる → はじける（当たり）/ 落ちる（はずれ） */
  async function playReveal(res) {
    const win = res.result === 'win';
    if (REDUCED) {
      setStage(win ? 'win' : 'lose', win ? 'WIN' : '…');
      return;
    }
    setStage('reveal');
    vibrate(30);
    await L.sleep(520);
    setStage(win ? 'win' : 'lose', win ? 'WIN' : '…');
    if (win) {
      vibrate([60, 40, 120]);
      confetti();
    } else {
      vibrate(20);
    }
    await L.sleep(win ? 380 : 500);
  }

  /* ---------- 状態 ---------- */

  function readEventCode() {
    const url = new URL(location.href);
    const fromUrl = (url.searchParams.get('c') || '').trim();
    if (fromUrl) {
      L.lsSet(CODE_KEY, fromUrl); // タブを閉じても再表示できるよう端末に残す
      url.searchParams.delete('c');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return L.lsGet(CODE_KEY) || '';
  }

  function setEventName(name) {
    if (!name) return;
    $('#eventName').textContent = name;
    document.title = name;
  }

  function saveResult(res) { L.lsSet(RESULT_KEY, JSON.stringify(res)); }

  function loadResult() {
    try { return JSON.parse(L.lsGet(RESULT_KEY) || 'null'); } catch (e) { return null; }
  }

  function clearResult() {
    try { localStorage.removeItem(RESULT_KEY); } catch (e) { /* ignore */ }
  }

  /** 結果の表示（演出なし。再表示やポーリングでも使う） */
  function render(res) {
    setEventName(res.eventName);
    saveResult(res);
    if (res.result !== 'win') {
      setStage('lose', '…');
      L.show('lose');
      return;
    }
    setStage('win', 'WIN');
    $('#prizeName').textContent = res.prizeName;
    const redeemed = res.redeemStatus === '引換済み';
    $('#redeemBox').hidden = redeemed;
    $('#redeemedBox').hidden = !redeemed;
    if (redeemed) {
      $('#redeemedText').textContent = res.redeemedAt ? `${L.fmtDate(res.redeemedAt)} に引き換えました` : '';
      stopPoll();
    } else {
      const qr = qrcode(0, 'M');
      qr.addData(res.qr);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      $('#redeemCode').textContent = L.fmtCode(res.redeemCode);
      $('#deadlineText').textContent = res.redeemDeadline ? `引換期限：${L.fmtDate(res.redeemDeadline)}` : '';
      startPoll();
    }
    L.show('win');
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await L.call('status', { deviceId });
        if (res.drawn) render(res);
      } catch (e) { /* 次の周期で再試行 */ }
    }, CFG.STATUS_POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function showError(err) {
    setStage('idle', '?');
    $('#errorText').textContent = (err && err.message) || 'エラーが発生しました';
    L.show('error');
  }

  function showClosed(info) {
    let text = '';
    const now = Date.now();
    if (info.openAt && now < Date.parse(info.openAt)) text = `受付開始：${L.fmtDate(info.openAt)}`;
    else if (info.closeAt && now > Date.parse(info.closeAt)) text = '抽選の受付は終了しました。';
    else text = 'しばらくしてからもう一度お試しください。';
    $('#closedText').textContent = text;
    L.show('closed');
  }

  async function init() {
    setStage('idle', '?');
    L.show('loading');
    eventCode = readEventCode();
    try {
      deviceId = await L.getDeviceId();
    } catch (e) {
      showError({ message: 'この端末では抽選できません（ブラウザの設定で保存が無効になっている可能性があります）' });
      return;
    }

    // 前回の結果があれば先に表示し、サーバーで最新の状態に更新する
    const cached = loadResult();
    if (cached) render(cached);

    try {
      const status = await L.call('status', { deviceId });
      if (status.drawn) {
        render(status);
        return;
      }
      if (cached) { clearResult(); setStage('idle', '?'); } // サーバー側で消えている（テストのやり直しなど）

      const info = await L.call('info', { eventCode });
      setEventName(info.eventName);
      if (!info.codeValid) { // 合言葉ありの設定で、コードが無いか違う
        L.show('nocode');
      } else if (!info.open) {
        showClosed(info);
      } else {
        $('#drawBtn').disabled = false;
        L.show('ready');
      }
    } catch (err) {
      if (!cached) showError(err);
    }
  }

  async function draw() {
    if (drawing) return; // 二重押し防止
    drawing = true;
    $('#drawBtn').disabled = true;
    vibrate(15);
    setStage('drawing', '?');
    L.show('drawing');
    const stopText = startDrawingText();
    const started = Date.now();
    try {
      const fp = await L.getFingerprint().catch(() => '');
      const res = await L.call('draw', { deviceId, eventCode, fp });
      const wait = CFG.DRAW_MIN_ANIMATION_MS - (Date.now() - started);
      if (wait > 0) await L.sleep(wait);
      stopText();
      await playReveal(res);
      render(res);
    } catch (err) {
      stopText();
      if (err.code === 'INVALID_CODE') {
        setStage('idle', '?');
        L.show('nocode');
      } else if (err.code === 'CLOSED') {
        init();
      } else {
        // 通信が途中で切れても抽選は確定している場合があるので、状態を確認する
        try {
          const status = await L.call('status', { deviceId });
          if (status.drawn) { await playReveal(status); render(status); return; }
        } catch (e) { /* ignore */ }
        showError(err);
      }
    } finally {
      drawing = false;
    }
  }

  $('#drawBtn').addEventListener('click', draw);
  $('#retryBtn').addEventListener('click', init);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollTimer) {
      L.call('status', { deviceId }).then((res) => { if (res.drawn) render(res); }).catch(() => {});
    }
  });

  init();
})();
