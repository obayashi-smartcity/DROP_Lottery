// 参加者画面。抽選APIを呼ぶタイミングはこの画面が制御する
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const RESULT_KEY = 'drop_lottery_result';
  const CODE_KEY = 'drop_lottery_event_code';

  let deviceId = null;
  let eventCode = '';
  let drawing = false;
  let pollTimer = null;

  function readEventCode() {
    const url = new URL(location.href);
    const fromUrl = (url.searchParams.get('c') || '').trim();
    if (fromUrl) {
      L.lsSet(CODE_KEY, fromUrl); // タブを閉じても再表示できるよう端末に残す
      // 再共有されにくいよう、アドレスバーからコードを消す
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

  function saveResult(res) {
    L.lsSet(RESULT_KEY, JSON.stringify(res));
  }

  function loadResult() {
    try { return JSON.parse(L.lsGet(RESULT_KEY) || 'null'); } catch (e) { return null; }
  }

  function clearResult() {
    try { localStorage.removeItem(RESULT_KEY); } catch (e) { /* ignore */ }
  }

  function render(res) {
    setEventName(res.eventName);
    saveResult(res);
    if (res.result !== 'win') {
      L.show('lose');
      return;
    }
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
      if (cached) clearResult(); // サーバー側で消えている（テストのやり直しなど）

      const info = await L.call('info', eventCode ? { eventCode } : {});
      setEventName(info.eventName);
      if (!eventCode || !info.codeValid) {
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
    L.show('drawing');
    const started = Date.now();
    try {
      const fp = await L.getFingerprint().catch(() => '');
      const res = await L.call('draw', { deviceId, eventCode, fp });
      const wait = CFG.DRAW_MIN_ANIMATION_MS - (Date.now() - started);
      if (wait > 0) await L.sleep(wait);
      render(res);
    } catch (err) {
      if (err.code === 'INVALID_CODE') {
        L.show('nocode');
      } else if (err.code === 'CLOSED') {
        init();
      } else {
        // 通信が途中で切れても抽選は確定している場合があるので、状態を確認する
        try {
          const status = await L.call('status', { deviceId });
          if (status.drawn) { render(status); return; }
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
