// アンケート：設問は assets/survey-config.js。回答はアンケートGASに送り、抽選画面へ進む
(function () {
  const L = window.Lottery;
  const CFG = window.LOTTERY_CONFIG;
  const $ = L.$;
  const QUESTIONS = window.SURVEY_QUESTIONS || [];

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

  function renderQuestions() {
    const box = $('#questions');
    QUESTIONS.forEach((q, qi) => {
      const fs = el('fieldset', { class: 'q', 'data-id': q.id });
      const lg = el('legend', { class: 'q-label' }, q.label);
      if (q.required) lg.appendChild(el('span', { class: 'req' }, '必須'));
      fs.appendChild(lg);
      const name = `q_${qi}`;
      if (q.type === 'radio' || q.type === 'checkbox') {
        const opts = el('div', { class: 'q-options' });
        (q.options || []).forEach((o) => {
          const lab = el('label', { class: 'opt' });
          const inp = el('input', { type: q.type, name: name, value: o });
          lab.appendChild(inp);
          lab.appendChild(el('span', {}, o));
          opts.appendChild(lab);
        });
        fs.appendChild(opts);
      } else if (q.type === 'select') {
        const sel = el('select', { name: name, class: 'q-input' });
        sel.appendChild(el('option', { value: '' }, '選択してください'));
        (q.options || []).forEach((o) => sel.appendChild(el('option', { value: o }, o)));
        fs.appendChild(sel);
      } else if (q.type === 'textarea') {
        fs.appendChild(el('textarea', { name: name, class: 'q-input', rows: '4', maxlength: '2000' }));
      } else {
        fs.appendChild(el('input', { type: 'text', name: name, class: 'q-input', maxlength: '200' }));
      }
      fs.appendChild(el('p', { class: 'q-error', role: 'alert' }));
      box.appendChild(fs);
    });
  }

  /** 回答を集める。未回答の必須設問があれば null */
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
        v = (form.elements[name].value || '').trim();
      }
      const empty = Array.isArray(v) ? v.length === 0 : v === '';
      const fs = form.querySelector(`fieldset[data-id="${q.id}"]`);
      const ng = q.required && empty;
      fs.classList.toggle('ng', ng);
      fs.querySelector('.q-error').textContent = ng ? '回答してください' : '';
      if (ng && !firstNg) firstNg = fs;
      answers[q.id] = v;
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
      await L.call('submit', {
        userId: flow.userId,
        points: flow.points,
        tierId: flow.tierId,
        tierLabel: flow.tierLabel,
        deviceId: deviceId,
        params: { userId: flow.userId, points: flow.points, tierId: flow.tierId, eventCode: flow.eventCode || '' },
        answers: answers,
      }, CFG.SURVEY_GAS_URL);
      L.setFlow({ surveyDone: true });
      L.goTo('lottery.html');
    } catch (err) {
      $('#surveyError').textContent = err.message || '送信できませんでした';
      L.show('form');
      $('#submitBtn').disabled = false;
      sending = false;
    }
  });

  $('#sumUser').textContent = flow.userId;
  $('#sumTier').textContent = `${flow.tierLabel || ''}（${Number(flow.points).toLocaleString('ja-JP')} pt）`;
  renderQuestions();
  L.show('form');
})();
