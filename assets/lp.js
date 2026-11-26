// LP：ユーザーID・ニックネーム・スタンプ数 → スタンプ数に合うボタンを有効にする → アンケートへ
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const CODE_KEY = 'drop_lottery_event_code';
  const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,99}$/; // GAS 側と同じ

  let eventCode = '';
  let current = null; // { userId, nickname, points }

  /** URL のパラメータ（イベントコード・ユーザーID・ニックネーム・スタンプ数）を読み、アドレスバーからは消す */
  function readParams() {
    const url = new URL(location.href);
    const p = url.searchParams;
    const out = {
      code: (p.get('c') || '').trim(),
      userId: (p.get(CFG.PARAM_USER_ID) || '').trim(),
      nickname: (p.get(CFG.PARAM_NICKNAME) || '').trim().slice(0, 30),
      points: (p.get(CFG.PARAM_POINTS) || '').trim(),
    };
    if (out.code) L.lsSet(CODE_KEY, out.code);
    ['c', CFG.PARAM_USER_ID, CFG.PARAM_NICKNAME, CFG.PARAM_POINTS].forEach((k) => p.delete(k));
    history.replaceState(null, '', url.pathname + (p.toString() ? '?' + p : '') + url.hash);
    return out;
  }

  function setEventName(name) {
    if (!name) return;
    $('#eventName').textContent = name;
    document.title = name;
  }

  function showError(err) {
    $('#errorText').textContent = (err && err.message) || 'エラーが発生しました';
    L.show('error');
  }

  function showClosed(info) {
    let text = 'しばらくしてからもう一度お試しください。';
    const now = Date.now();
    if (info.openAt && now < Date.parse(info.openAt)) text = `受付開始：${L.fmtDate(info.openAt)}`;
    else if (info.closeAt && now > Date.parse(info.closeAt)) text = '抽選の受付は終了しました。';
    $('#closedText').textContent = text;
    L.show('closed');
  }

  function renderTiers(tiers, points) {
    const active = L.tierForPoints(tiers, points);
    $('#sumNick').textContent = current.nickname;
    $('#sumPoints').textContent = points.toLocaleString('ja-JP');
    $('#tierLead').innerHTML = active
      ? '押せるボタンで抽選に進めます。'
      : 'スタンプが足りないため、<br>今回は抽選に参加できません。';

    const list = $('#tierList');
    list.textContent = '';
    tiers.forEach((t, i) => {
      const on = !!active && active.id === t.id;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tier tier-c${i % 5}`;
      b.disabled = !on;
      b.innerHTML = '<span class="tier-label"></span><span class="tier-range"></span>';
      b.querySelector('.tier-label').textContent = t.label;
      b.querySelector('.tier-range').textContent = L.tierRangeText(t);
      if (on) b.addEventListener('click', () => choose(t));
      list.appendChild(b);
    });
    L.show('tiers');
  }

  function choose(tier) {
    L.setFlow({
      userId: current.userId,
      nickname: current.nickname,
      points: current.points,
      tierId: tier.id,
      tierLabel: tier.label,
      eventCode: eventCode,
      surveyDone: false,
    });
    location.href = 'survey.html';
  }

  async function start(userId, nickname, points) {
    current = { userId, nickname, points };
    L.show('loading');
    try {
      const [status, info] = await Promise.all([
        L.call('status', { userId }),
        L.call('info', { eventCode }),
      ]);
      setEventName(info.eventName);
      if (status.drawn) { // 抽選済みなら完了画面（結果）へ
        L.clearFlow();
        L.setFlow({ userId, eventCode });
        L.goTo('lottery.html');
        return;
      }
      if (!info.codeValid) { L.show('nocode'); return; }
      if (!info.open) { showClosed(info); return; }
      renderTiers(info.tiers || [], points);
    } catch (err) {
      if (err.code === 'BAD_USER') { showEntry(err.message); return; }
      showError(err);
    }
  }

  function showEntry(message) {
    $('#entryError').textContent = message || '';
    L.show('entry');
  }

  $('#entryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const userId = $('#userId').value.trim();
    const nickname = $('#nickname').value.trim();
    const raw = $('#points').value.trim();
    const points = Number(raw);
    if (!USER_ID_RE.test(userId)) { showEntry('ユーザーIDを入力してください（英数字と _ . : @ - が使えます）'); return; }
    if (!nickname || nickname.length > 30) { showEntry('ニックネームを30文字以内で入力してください'); return; }
    if (raw === '' || !Number.isInteger(points) || points < 0) { showEntry('スタンプ数を0以上の整数で入力してください'); return; }
    start(userId, nickname, points);
  });

  $('#changeBtn').addEventListener('click', () => showEntry(''));
  $('#retryBtn').addEventListener('click', () => (current ? start(current.userId, current.nickname, current.points) : showEntry('')));

  // 初期表示
  const params = readParams();
  eventCode = params.code || L.lsGet(CODE_KEY) || '';
  const flow = L.getFlow();
  $('#userId').value = params.userId || flow.userId || '';
  $('#nickname').value = params.nickname || flow.nickname || '';
  $('#points').value = params.points || (flow.points != null ? flow.points : '');
  showEntry('');
})();
