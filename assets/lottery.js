// 抽選画面（アンケートの次）と結果・完了画面。抽選APIを呼ぶタイミングと演出はこの画面が制御する
(function () {
  const L = window.Lottery;
  if (L.versionMismatch) return; // 古い HTML と新しい JS が混ざっている（api.js が再読み込みを案内している）
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  // 画面の部品が見つからないなど、通信以外のエラー（古い HTML と新しい JS が混ざったときなど）は、技術的な文言ではなく再読み込みを案内する
  const RELOAD_TEXT = '画面を表示できませんでした。ページを再読み込みしてください。';
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stage = $('#stage');
  const coreText = $('#coreText');

  // 結果画面の文言（v4.0-07）。景品名は出さず、当選は「抽選特典」、はずれ景品は「参加賞」として出す
  const TEXT = {
    winHead: '当選おめでとうございます！',
    consolationHead: '残念！はずれ', // はずれ景品の人（はずれ景品もない「はずれ」の画面も同じ見出し。lottery.html）
    winCard: '抽選特典',
    consolationCard: '参加賞',
    redeemedSuffix: '（受け取り済）',
  };

  const flow = L.getFlow();
  if (!flow.userId) { L.goTo('index.html'); return; } // LP を通っていない

  const userId = flow.userId;
  let deviceId = '';
  let drawing = false;
  let pollTimer = null;
  let needReload = false; // 通信以外のエラーのあと（「もう一度試す」でページを読み込み直す）

  /* ---------- 演出 ---------- */

  function setStage(state, text) {
    stage.dataset.state = state;
    if (text !== undefined) coreText.textContent = text;
  }

  /** 抽選中の表示（Loading... のまま）。混雑で自動再試行しているときは、その旨を下に出す */
  function startDrawingText() {
    $('#drawingText').textContent = 'Loading...';
    $('#drawingNote').hidden = true;
    return () => { $('#drawingNote').hidden = true; };
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
      setStage(win ? 'win' : 'lose', win ? 'WIN' : 'LOSE');
      return;
    }
    setStage('reveal');
    vibrate(30);
    await L.sleep(520);
    setStage(win ? 'win' : 'lose', win ? 'WIN' : 'LOSE');
    if (win) {
      vibrate([60, 40, 120]);
      confetti();
    } else {
      vibrate(20);
    }
    await L.sleep(win ? 380 : 500);
  }

  /* ---------- 状態 ---------- */

  function setEventName(name) {
    if (!name) return;
    $('#eventName').textContent = name;
    document.title = name;
  }

  /**
   * 結果の表示（演出なし。再表示やポーリングでも使う）
   * result が 'lose' でも consolation が true なら、はずれ景品（ポストカードなど）と引換欄を出す
   */
  function render(res) {
    setEventName(res.eventName);
    $('#backBox').hidden = false;
    const consolation = res.result !== 'win' && !!res.consolation;
    if (res.result !== 'win' && !consolation) {
      setStage('lose', 'LOSE');
      L.show('lose');
      return;
    }
    setStage(consolation ? 'lose' : 'win', consolation ? 'LOSE' : 'WIN');
    const redeemed = res.redeemStatus === '引換済み';
    $('#resultHead').textContent = consolation ? TEXT.consolationHead : TEXT.winHead;
    $('#resultHead').classList.toggle('result-en-lose', consolation);
    $('#cardTitle').textContent = (consolation ? TEXT.consolationCard : TEXT.winCard) + (redeemed ? TEXT.redeemedSuffix : '');
    $('#redeemBox').hidden = redeemed;
    $('#redeemedBox').hidden = !redeemed;
    if (redeemed) {
      $('#redeemedText').textContent = res.redeemedAt ? `${L.fmtDate(res.redeemedAt)} に引き換えました` : '';
      stopPoll();
    } else {
      startPoll();
    }
    L.show('win');
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await L.call('status', { userId });
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
    needReload = !(err && err.code); // 通信・GAS のエラーには code がある
    $('#errorText').textContent = needReload ? RELOAD_TEXT : (err.message || 'エラーが発生しました');
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
    deviceId = await L.getDeviceId().catch(() => '');

    try {
      const status = await L.callWithRetry('status', { userId }, { retryOn: L.RETRY_READ });
      if (status.drawn) { // 抽選済み：完了画面として結果を表示
        $('#doneNote').hidden = false;
        render(status);
        return;
      }
      // 未抽選なのにボタン選択やアンケートが済んでいなければ LP からやり直す
      if (!flow.tierId || !flow.surveyDone) { L.goTo('index.html'); return; }

      const info = await L.callWithRetry('info', { eventCode: flow.eventCode || '' }, { retryOn: L.RETRY_READ });
      setEventName(info.eventName);
      if (!info.codeValid) {
        L.show('nocode');
      } else if (!info.open) {
        showClosed(info);
      } else {
        draw(); // アンケートの「抽選する」で来ているので、そのまま抽選する
        return;
      }
    } catch (err) {
      showError(err);
    }
  }

  async function draw() {
    if (drawing) return; // 二重押し防止
    drawing = true;
    vibrate(15);
    setStage('drawing', '?');
    L.show('drawing');
    const stopText = startDrawingText();
    const started = Date.now();
    let retried = false;
    try {
      const fp = await L.getFingerprint().catch(() => '');
      // draw は同じユーザーIDで何度呼んでも二重抽選にならない（2回目以降は前回の結果が返る）ので、通信エラーでも再試行してよい
      const res = await L.callWithRetry('draw', {
        userId, points: flow.points, tierId: flow.tierId, eventCode: flow.eventCode || '', deviceId, fp,
      }, {
        retryOn: L.RETRY_READ,
        onRetry: () => { retried = true; $('#drawingNote').hidden = false; },
      });
      const wait = CFG.DRAW_MIN_ANIMATION_MS - (Date.now() - started);
      if (wait > 0) await L.sleep(wait);
      stopText();
      await playReveal(res);
      L.setFlow({ surveyDone: false, tierId: '' }); // 抽選が確定したので、戻っても再抽選の画面にはしない
      // 再試行した場合は、最初の要求で抽選が済んでいて alreadyDrawn になることがあるので「完了しています」は出さない
      if (res.alreadyDrawn && !retried) $('#doneNote').hidden = false;
      render(res);
    } catch (err) {
      stopText();
      if (err.code === 'BAD_TIER' || err.code === 'NO_TIER') {
        L.setFlow({ tierId: '', surveyDone: false });
        showError(err);
      } else if (err.code === 'INVALID_CODE') {
        setStage('idle', '?');
        L.show('nocode');
      } else if (err.code === 'CLOSED') {
        try { showClosed(await L.call('info', { eventCode: flow.eventCode || '' })); } catch (e) { showClosed({}); }
      } else {
        // 再試行を打ち切った場合や、通信が途中で切れた場合でも、抽選は確定していることがあるので状態を確認する
        try {
          const status = await L.call('status', { userId });
          if (status.drawn) { await playReveal(status); render(status); return; }
        } catch (e) { /* ignore */ }
        showError(err);
      }
    } finally {
      drawing = false;
    }
  }

  /**
   * 引換パスワードの入力値をそろえる。NFKC で全角英数字・全角スペースを半角にし、前後の空白を除く。
   * 日本語キーボードのまま全角で打っても照合できるようにするため（大文字・小文字は GAS 側でそろえる）
   */
  function normalizePassword(v) {
    return String(v == null ? '' : v).normalize('NFKC').trim();
  }

  /**
   * 受け取りの文言（#redeemError）を出す。retry が true なら混雑時の再試行の案内（エラーの赤字ではなく、
   * 抽選中の再試行の文言と同じ落ち着いた色。v1.0.2）。空なら欄ごと隠れる（style.css の :empty）
   */
  function setRedeemMessage(text, retry) {
    const el = $('#redeemError');
    el.textContent = text || '';
    el.classList.toggle('is-retry', !!retry);
  }

  /** 当選者がスタッフから聞いたパスワードを入れて受け取る（引換） */
  let redeeming = false;
  async function redeem(e) {
    e.preventDefault();
    if (redeeming) return; // 二重送信防止
    const pw = normalizePassword($('#redeemPw').value);
    if (!pw) { setRedeemMessage('パスワードを入力してください'); return; }
    redeeming = true;
    $('#redeemBtn').disabled = true;
    setRedeemMessage('');
    try {
      // 自動再試行は BUSY のときだけ（BUSY なら何も書き込まれていない）
      const res = await L.callWithRetry('redeemSelf', { userId, password: pw }, {
        retryOn: L.RETRY_BUSY_ONLY,
        onRetry: () => { setRedeemMessage('混雑しています。自動で再試行しています…', true); },
      });
      $('#redeemPw').value = '';
      setRedeemMessage('');
      vibrate([40, 30, 80]);
      render(res);
    } catch (err) {
      if (err.code === 'NETWORK' || err.code === 'BAD_RESPONSE') {
        // 引換が済んだかどうか分からない。もう一度送るとパスワード違いの回数を二重に数えるおそれがあるので、送らずに状態を確認する
        try {
          const status = await L.callWithRetry('status', { userId }, { retryOn: L.RETRY_READ });
          if (status.drawn && status.redeemStatus === '引換済み') {
            $('#redeemPw').value = '';
            setRedeemMessage('');
            render(status);
            return;
          }
        } catch (e) { /* 確認できなければ下のエラー表示 */ }
      }
      setRedeemMessage(err && err.code ? (err.message || '受け取りできませんでした') : RELOAD_TEXT); // 入力欄はそのまま残す（エラーは赤字）
    } finally {
      redeeming = false;
      $('#redeemBtn').disabled = false;
    }
  }

  $('#redeemForm').addEventListener('submit', redeem);
  $('#retryBtn').addEventListener('click', () => {
    if (needReload) { location.reload(); return; }
    if (!L.getFlow().tierId) { L.goTo('index.html'); return; }
    init();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollTimer) {
      L.call('status', { userId }).then((res) => { if (res.drawn) render(res); }).catch(() => {});
    }
  });

  init();
})();
