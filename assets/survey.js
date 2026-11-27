// アンケート：設問は assets/survey-config.js。回答はアンケートGASに送り、抽選画面へ進む
(function () {
  const L = window.Lottery;
  if (L.versionMismatch) return; // 古い HTML と新しい JS が混ざっている（api.js が再読み込みを案内している）
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  // 画面の部品が見つからないなど、通信以外のエラー（古い HTML と新しい JS が混ざったときなど）は、技術的な文言ではなく再読み込みを案内する
  const RELOAD_TEXT = '画面を表示できませんでした。ページを再読み込みしてください。';
  const QUESTIONS = window.SURVEY_QUESTIONS || [];
  // 選択肢がこの文字数より長い設問は、スマホでも1列に並べる（短い選択肢の設問は2列。style.css）
  const WIDE_OPTION_CHARS = 16;
  const OTHER_MAX = 200; // 「その他」の自由記述の上限（文字）

  const flow = L.getFlow();
  // LP を通っていなければ LP へ戻す
  if (!flow.userId || !flow.tierId) { L.goTo('index.html'); return; }
  // 回答済みなら抽選へ
  if (flow.surveyDone) { L.goTo('lottery.html'); return; }

  let sending = false;

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** 「その他」の自由記述を送る先の ID（設問とは別の列） */
  function otherId(q) { return `${q.id}_other`; }

  function isExclusive(q, value) { return (q.exclusiveOptions || []).indexOf(value) !== -1; }

  /** 選択肢の input の一覧 */
  function optionInputs(name) {
    return Array.from($('#surveyForm').querySelectorAll(`input[name="${name}"]`));
  }

  /** 「その他」を選んでいるときだけ自由記述の入力欄を出す（外したら隠す。内容は collect で送らない） */
  function syncOther(q, name) {
    if (!q.otherOption) return;
    const chosen = optionInputs(name).some((i) => i.checked && i.value === q.otherOption);
    const box = $('#surveyForm').querySelector(`input[name="${name}_other"]`);
    box.hidden = !chosen;
  }

  /** 選んだときの処理: 同時に選べない選択肢（exclusiveOptions）を外し、「その他」の入力欄を出し入れする */
  function onOptionChange(q, name, target) {
    if (q.type === 'checkbox' && target.checked) {
      const exclusive = isExclusive(q, target.value);
      optionInputs(name).forEach((i) => {
        if (i !== target && i.checked && (exclusive || isExclusive(q, i.value))) i.checked = false;
      });
    }
    syncOther(q, name);
  }

  function renderQuestions() {
    const box = $('#questions');
    QUESTIONS.forEach((q, qi) => {
      const fs = el('fieldset', { class: 'q', 'data-id': q.id });
      const lg = el('legend', { class: 'q-label' }, q.label);
      if (q.required) lg.appendChild(el('span', { class: 'req' }, '必須'));
      fs.appendChild(lg);
      const name = `q_${qi}`;
      if (q.type === 'radio' || q.type === 'checkbox') {
        const wide = (q.options || []).some((o) => o.length > WIDE_OPTION_CHARS);
        const opts = el('div', { class: wide ? 'q-options q-options-wide' : 'q-options' });
        (q.options || []).forEach((o) => {
          const lab = el('label', { class: 'opt' });
          const inp = el('input', { type: q.type, name: name, value: o });
          inp.addEventListener('change', () => onOptionChange(q, name, inp));
          lab.appendChild(inp);
          lab.appendChild(el('span', {}, o));
          opts.appendChild(lab);
        });
        fs.appendChild(opts);
        if (q.otherOption) {
          const other = el('input', {
            type: 'text', name: `${name}_other`, class: 'q-input q-other', maxlength: String(OTHER_MAX),
            'aria-label': `「${q.otherOption}」の内容`, placeholder: `「${q.otherOption}」の内容（${OTHER_MAX}文字まで）`,
          });
          other.hidden = true;
          fs.appendChild(other);
        }
      } else if (q.type === 'select') {
        const sel = el('select', { name: name, class: 'q-input' });
        sel.appendChild(el('option', { value: '' }, '選択してください'));
        (q.options || []).forEach((o) => sel.appendChild(el('option', { value: o }, o)));
        fs.appendChild(sel);
      } else if (q.type === 'textarea') {
        fs.appendChild(el('textarea', { name: name, class: 'q-input', rows: '3', maxlength: '2000' }));
      } else {
        fs.appendChild(el('input', { type: 'text', name: name, class: 'q-input', maxlength: '200' }));
      }
      fs.appendChild(el('p', { class: 'q-error', role: 'alert' }));
      box.appendChild(fs);
    });
  }

  /**
   * 回答を集める。未回答の必須設問（「その他」を選んで内容が空の場合を含む）があれば null。
   * 「その他」の内容は <id>_other に入れる。選んでいなければ空欄で送る（入力していた内容は送らない。
   * 空欄でも送るのは、Responses シートの列が設問の順に並ぶようにするため）
   */
  function collect() {
    const form = $('#surveyForm');
    const answers = {};
    let firstNg = null;
    QUESTIONS.forEach((q, qi) => {
      const name = `q_${qi}`;
      let v;
      if (q.type === 'checkbox') {
        v = Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((i) => i.value);
      } else if (q.type === 'radio') {
        const c = form.querySelector(`input[name="${name}"]:checked`);
        v = c ? c.value : '';
      } else {
        v = (form.querySelector(`[name="${name}"]`).value || '').trim();
      }
      const empty = Array.isArray(v) ? v.length === 0 : v === '';
      const fs = form.querySelector(`fieldset[data-id="${q.id}"]`);
      let msg = q.required && empty ? '回答してください' : '';
      let otherText = '';
      if (q.otherOption) {
        const chosen = Array.isArray(v) ? v.indexOf(q.otherOption) !== -1 : v === q.otherOption;
        const box = form.querySelector(`input[name="${name}_other"]`);
        otherText = chosen ? (box.value || '').trim().slice(0, OTHER_MAX) : '';
        if (!msg && chosen && !otherText) msg = `「${q.otherOption}」の内容を入力してください`;
      }
      const ng = !!msg;
      fs.classList.toggle('ng', ng);
      fs.querySelector('.q-error').textContent = msg;
      if (ng && !firstNg) firstNg = fs;
      answers[q.id] = v;
      if (q.otherOption) answers[otherId(q)] = otherText;
    });
    if (firstNg) {
      firstNg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return null;
    }
    return answers;
  }

  $('#surveyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return; // 二重送信防止
    const answers = collect();
    if (!answers) { $('#surveyError').textContent = '未回答の設問があります'; return; }
    $('#surveyError').textContent = '';
    sending = true;
    $('#submitBtn').disabled = true;
    L.show('sending');
    try {
      const deviceId = await L.getDeviceId().catch(() => '');
      // 自動再試行は BUSY のときだけ（通信エラーで送り直すと、同じ回答が二重に記録されるおそれがある）
      await L.callWithRetry('submit', {
        userId: flow.userId,
        points: flow.points,
        tierId: flow.tierId,
        tierLabel: flow.tierLabel,
        deviceId: deviceId,
        params: { userId: flow.userId, points: flow.points, tierId: flow.tierId, eventCode: flow.eventCode || '' },
        answers: answers,
      }, {
        url: CFG.SURVEY_GAS_URL,
        retryOn: L.RETRY_BUSY_ONLY,
        onRetry: () => { $('#sendingNote').hidden = false; },
      });
      L.setFlow({ surveyDone: true });
      L.goTo('lottery.html');
    } catch (err) {
      $('#sendingNote').hidden = true;
      $('#surveyError').textContent = err && err.code ? (err.message || '送信できませんでした') : RELOAD_TEXT;
      L.show('form');
      $('#submitBtn').disabled = false;
      sending = false;
    }
  });

  $('#sumTier').textContent = `${flow.tierLabel || ''}（${Number(flow.points).toLocaleString('ja-JP')} スタンプ）`;
  renderQuestions();
  L.show('form');
})();
