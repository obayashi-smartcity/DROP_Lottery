// LP：URL で受け取ったユーザーID・スタンプ数 → スタンプ数に合うボタンを有効にする → アンケートへ
// 例: index.html?account_id=<ユーザーID>&point=<スタンプ数>（パラメータ名は config.js）
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const CODE_KEY = 'drop_lottery_event_code';
  // ユーザーID（account_id）は UUID。大文字・小文字を区別せずに受け付け、小文字にそろえる（GAS 側と同じ）
  const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POINTS_RE = /^\d{1,9}$/; // 0 以上の整数（上限は GAS の info が返す maxPoints で確認する）

  let eventCode = '';
  let current = null; // { userId, points }

  /** URL のパラメータ（イベントコード・ユーザーID・スタンプ数）を読み、アドレスバーからは消す */
  function readParams() {
    const url = new URL(location.href);
    const p = url.searchParams;
    const out = {
      code: (p.get('c') || '').trim(),
      hasUser: p.has(CFG.PARAM_USER_ID) || p.has(CFG.PARAM_POINTS),
      userId: (p.get(CFG.PARAM_USER_ID) || '').trim(),
      points: (p.get(CFG.PARAM_POINTS) || '').trim(),
    };
    if (out.code) L.lsSet(CODE_KEY, out.code);
    ['c', CFG.PARAM_USER_ID, CFG.PARAM_POINTS].forEach((k) => p.delete(k));
    history.replaceState(null, '', url.pathname + (p.toString() ? '?' + p : '') + url.hash);
    return out;
  }

  /** ユーザーID・スタンプ数が使える形式か。使えなければ null */
  function validate(userId, points) {
    const raw = String(points == null ? '' : points).trim();
    if (!USER_ID_RE.test(userId || '') || !POINTS_RE.test(raw)) return null;
    return { userId: String(userId).toLowerCase(), points: Number(raw) };
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

  /** ユーザーID・スタンプ数を受け取れなかったとき（直接開いた・パラメータが不正） */
  function showNoParam() {
    L.show('noparam');
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
      points: current.points,
      tierId: tier.id,
      tierLabel: tier.label,
      eventCode: eventCode,
      surveyDone: false,
    });
    location.href = 'survey.html';
  }

  async function start(user) {
    current = user;
    L.show('loading');
    try {
      const [status, info] = await Promise.all([
        L.call('status', { userId: user.userId }),
        L.call('info', { eventCode }),
      ]);
      setEventName(info.eventName);
      if (status.drawn) { // 抽選済みなら完了画面（結果）へ
        L.clearFlow();
        L.setFlow({ userId: user.userId, points: user.points, eventCode });
        L.goTo('lottery.html');
        return;
      }
      // スタンプ数の上限（Config の MAX_POINTS）。古い GAS で maxPoints が返らないときは確認しない
      if (typeof info.maxPoints === 'number' && user.points > info.maxPoints) { L.clearFlow(); showNoParam(); return; }
      if (!info.codeValid) { L.show('nocode'); return; }
      if (!info.open) { showClosed(info); return; }
      renderTiers(info.tiers || [], user.points);
    } catch (err) {
      if (err.code === 'BAD_USER') { L.clearFlow(); showNoParam(); return; }
      showError(err);
    }
  }

  $('#retryBtn').addEventListener('click', () => (current ? start(current) : showNoParam()));

  // 初期表示
  const params = readParams();
  eventCode = params.code || L.lsGet(CODE_KEY) || '';
  let user;
  if (params.hasUser) {
    // 遷移元から来たときは URL の値だけを使う（前回の状態は捨てる）
    L.clearFlow();
    user = validate(params.userId, params.points);
    if (user) L.setFlow({ userId: user.userId, points: user.points, eventCode });
  } else {
    // 再読み込みやアンケート・抽選画面から戻ったとき（URL からは消してあるので画面間の状態から復元）
    const flow = L.getFlow();
    user = validate(flow.userId, flow.points);
  }
  if (user) start(user);
  else showNoParam();
})();
