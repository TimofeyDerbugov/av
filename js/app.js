/*
 * Интерфейс трекера и хранение данных.
 * Данные: личное хранилище страницы (db), если оно доступно, иначе localStorage.
 */
(function () {
  'use strict';

  var Q = window.Quit;
  var STORE_KEY = 'quit-tracker-v1';
  var VIEWS = [
    ['today', 'Сегодня'],
    ['plan', 'План'],
    ['analysis', 'Анализ'],
    ['report', 'Итоги дня'],
    ['setup', 'Настройки']
  ];

  var state = {
    settings: Q.mergeSettings(null, Q.dateKey(Date.now())),
    days: {},
    ready: false,
    mode: 'loading',
    settingsSaved: false,
    note: ''
  };
  var ui = { view: 'today', trig: null, period: '7', reportKey: null, rows: [], resetArmed: false };

  var viewEl = document.getElementById('view');
  var tabsEl = document.getElementById('tabs');
  var statusEl = document.getElementById('status');

  /* ---------- утилиты ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function todayKey() { return Q.dateKey(Date.now()); }

  function agoText(ts) {
    var m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'меньше минуты назад';
    if (m < 60) return m + ' мин назад';
    var h = Math.floor(m / 60);
    return h + ' ч ' + Q.pad(m % 60) + ' мин назад';
  }

  function niceMax(v) {
    if (v <= 10) return 10;
    var m = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * m >= v) return steps[i] * m;
    return 10 * m;
  }

  function setStatus() {
    var t = state.mode === 'cloud' ? 'Данные сохраняются в вашем личном хранилище'
      : state.mode === 'local' ? 'Данные хранятся только в этом браузере'
      : state.mode === 'memory' ? 'Хранилище недоступно, данные пропадут при закрытии'
      : 'Загрузка данных';
    statusEl.textContent = state.note ? t + '. ' + state.note : t;
  }

  /* ---------- хранилище ---------- */

  var Store = (function () {
    var col = null, queue = [], busy = false;

    function pump() {
      if (busy || !queue.length) return;
      busy = true;
      var job = queue.shift(), p;
      try {
        p = job.data === null ? col.doc(job.id).delete() : col.doc(job.id).set(job.data);
      } catch (e) { p = Promise.reject(e); }
      p.catch(function (e) {
        state.note = 'Не удалось сохранить' + (e && e.code ? ' (' + e.code + ')' : '');
        setStatus();
      }).then(function () { busy = false; pump(); });
    }

    function enqueue(id, data) {
      for (var i = 0; i < queue.length; i++) {
        if (queue[i].id === id) { queue[i].data = data; return; }
      }
      queue.push({ id: id, data: data });
      pump();
    }

    function saveLocal() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, days: state.days }));
        state.mode = 'local';
      } catch (e) { state.mode = 'memory'; }
      setStatus();
    }

    function loadLocal(onData) {
      try {
        var raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          var obj = JSON.parse(raw);
          state.days = obj.days || {};
          state.settings = Q.mergeSettings(obj.settings, state.settings.startDate);
          state.settingsSaved = !!obj.settings;
        }
        localStorage.setItem(STORE_KEY + '-probe', '1');
        localStorage.removeItem(STORE_KEY + '-probe');
        state.mode = 'local';
      } catch (e) { state.mode = 'memory'; }
      state.ready = true;
      setStatus();
      onData();
    }

    function init(onData) {
      var user = null, db = null;
      var go = function () {
        if (!db || !user) return null;
        return user.id();
      };
      var chain = Promise.resolve();
      if (window.claude && window.claude.use) {
        chain = window.claude.use('user').then(function (u) {
          user = u;
          return window.claude.use('db');
        }).then(function (d) { db = d; return go(); });
      }
      chain.catch(function () { return null; }).then(function (uid) {
        if (!db || !uid) { loadLocal(onData); return; }
        col = db.collection('data/users/' + uid);
        state.mode = 'cloud';
        var timer = setTimeout(function () {
          state.note = 'Сервер отвечает долго, данные могут быть неполными';
          state.ready = true;
          setStatus();
          onData();
        }, 10000);
        col.onSnapshot(function (snap) {
          clearTimeout(timer);
          var days = {}, settings = null;
          snap.docs.forEach(function (d) {
            var data = d.data() || {};
            if (d.id === 'settings' && data.settings) settings = data.settings;
            else if (d.id.indexOf('day-') === 0) days[d.id.slice(4)] = data.events || [];
          });
          state.days = days;
          if (settings) {
            state.settings = Q.mergeSettings(settings, state.settings.startDate);
            state.settingsSaved = true;
          }
          state.note = '';
          state.ready = true;
          setStatus();
          onData();
        }, function () {
          clearTimeout(timer);
          col = null;
          loadLocal(onData);
        });
      });
    }

    return {
      init: init,
      saveDay: function (key) {
        var ev = state.days[key] || [];
        if (col) enqueue('day-' + key, ev.length ? { events: ev } : null);
        else saveLocal();
      },
      saveSettings: function () {
        state.settingsSaved = true;
        if (col) enqueue('settings', { settings: state.settings });
        else saveLocal();
      }
    };
  })();

  /* ---------- действия ---------- */

  function ensureSettingsSaved() {
    if (!state.settingsSaved) Store.saveSettings();
  }

  function logEvent(kind, n) {
    if (!state.ready) return;
    ensureSettingsSaved();
    var t = Date.now(), key = Q.dateKey(t);
    var ev = { id: t.toString(36) + Math.random().toString(36).slice(2, 6), t: t, k: kind, n: n };
    if (ui.trig) { ev.tr = ui.trig; ui.trig = null; }
    (state.days[key] = state.days[key] || []).push(ev);
    Store.saveDay(key);
    render();
  }

  function removeEvent(key, id) {
    var list = state.days[key] || [];
    var next = list.filter(function (e) { return e.id !== id; });
    if (next.length === list.length) return;
    if (next.length) state.days[key] = next; else delete state.days[key];
    Store.saveDay(key);
    render();
  }

  function undoLast() {
    var key = todayKey(), list = state.days[key] || [];
    if (!list.length) return;
    var last = list.reduce(function (a, b) { return b.t > a.t ? b : a; });
    removeEvent(key, last.id);
  }

  function flash(text) {
    var el = document.getElementById('msg');
    if (el) el.textContent = text;
  }

  function readSettingsForm() {
    var S = Object.assign({}, state.settings);
    function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    S.startDate = val('s-start') || S.startDate;
    S.totalDays = Number(val('s-total')) || S.totalDays;
    S.measureDays = Number(val('s-measure')) || S.measureDays;
    S.baseline = val('s-base') ? Number(val('s-base')) : null;
    S.wakeFrom = val('s-from') === '' ? S.wakeFrom : Number(val('s-from'));
    S.wakeTo = val('s-to') === '' ? S.wakeTo : Number(val('s-to'));
    state.settings = Q.mergeSettings(S, state.settings.startDate);
    Store.saveSettings();
    render();
  }

  function importBackup() {
    var ta = document.getElementById('b-text');
    try {
      var obj = JSON.parse(ta.value);
      if (!obj || typeof obj.days !== 'object') throw new Error('format');
      var days = {};
      Object.keys(obj.days).forEach(function (k) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(obj.days[k])) {
          days[k] = obj.days[k].filter(function (e) { return e && typeof e.t === 'number' && (e.k === 'v' || e.k === 'd'); })
            .map(function (e) {
              var o = { id: String(e.id || e.t), t: e.t, k: e.k, n: Number(e.n) || 1 };
              if (e.tr) o.tr = String(e.tr).slice(0, 40);
              return o;
            });
        }
      });
      var old = Object.keys(state.days);
      state.days = days;
      state.settings = Q.mergeSettings(obj.settings, state.settings.startDate);
      Store.saveSettings();
      Object.keys(days).concat(old).forEach(function (k) { Store.saveDay(k); });
      render();
      flash('Данные загружены из копии.');
    } catch (e) {
      flash('Не удалось прочитать копию. Вставь текст целиком, как его выдала кнопка «Показать копию».');
    }
  }

  function resetAll() {
    var old = Object.keys(state.days);
    state.days = {};
    state.settings = Q.mergeSettings(null, todayKey());
    state.settingsSaved = false;
    Store.saveSettings();
    old.forEach(function (k) { Store.saveDay(k); });
    ui.resetArmed = false;
    render();
  }

  function copyText(text, ta) {
    var done = function () { flash('Скопировано. Можно вставлять в Telegram.'); };
    var fallback = function () {
      ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      flash(ok ? 'Скопировано. Можно вставлять в Telegram.' : 'Текст выделен, скопируй его вручную.');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  /* ---------- графики ---------- */

  function planChart(rows, plan) {
    var W = 720, H = 260, l = 34, r = 8, t = 16, b = 24;
    var pw = W - l - r, ph = H - t - b, N = rows.length;
    var maxV = plan.B.value;
    rows.forEach(function (x) { maxV = Math.max(maxV, x.vape, x.dummy, x.limit || 0); });
    var ymax = niceMax(maxV), cw = pw / N, bw = Math.max(2, Math.min(18, cw * 0.62));
    function X(i) { return l + (i + 0.5) * cw; }
    function Y(v) { return t + ph - (v / ymax) * ph; }

    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="График по дням: затяжки вейпа, потяги пустышки и лимит. Те же данные в таблице ниже.">';
    if (plan.M > 0) s += '<rect class="zone" x="' + l + '" y="' + t + '" width="' + (plan.M * cw) + '" height="' + ph + '"/><text x="' + (l + 4) + '" y="' + (t + 12) + '">замер</text>';
    [0, 0.5, 1].forEach(function (f) {
      var v = ymax * f, y = Y(v);
      s += '<line class="grid" x1="' + l + '" x2="' + (W - r) + '" y1="' + y + '" y2="' + y + '"/>';
      s += '<text x="' + (l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    });

    rows.forEach(function (x, i) {
      if (x.idx <= plan.todayIdx && x.vape > 0) {
        var h = (x.vape / ymax) * ph;
        s += '<rect class="b-vape" x="' + (X(i) - bw / 2) + '" y="' + (t + ph - h) + '" width="' + bw + '" height="' + h + '" rx="2"/>';
      }
    });

    var path = '';
    rows.forEach(function (x, i) {
      if (x.limit === null) return;
      var x0 = l + i * cw, x1 = l + (i + 1) * cw, y = Y(x.limit);
      path += (path ? ' L' : 'M') + x0 + ',' + y + ' L' + x1 + ',' + y;
    });
    if (path) s += '<path class="l-limit" d="' + path + '"/>';

    var pts = [];
    rows.forEach(function (x, i) { if (x.idx <= plan.todayIdx && (x.dummy > 0 || x.vape > 0)) pts.push([X(i), Y(x.dummy)]); });
    if (pts.length > 1) s += '<polyline class="l-dummy" points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"/>';
    if (pts.length) s += '<circle class="p-dummy" cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1] + '" r="4"/>';

    if (plan.todayIdx >= 1 && plan.todayIdx <= N) {
      var tx = X(plan.todayIdx - 1);
      s += '<line class="mark" x1="' + tx + '" x2="' + tx + '" y1="' + t + '" y2="' + (t + ph) + '"/>';
    }

    s += '<line class="axis" x1="' + l + '" x2="' + (W - r) + '" y1="' + (t + ph) + '" y2="' + (t + ph) + '"/>';
    rows.forEach(function (x, i) {
      if (x.idx === 1 || x.idx % 5 === 0 || x.idx === N) s += '<text x="' + X(i) + '" y="' + (H - 7) + '" text-anchor="middle">' + x.idx + '</text>';
      s += '<rect class="hit" data-day="' + i + '" x="' + (l + i * cw) + '" y="' + t + '" width="' + cw + '" height="' + ph + '"/>';
    });
    return s + '</svg>';
  }

  function hoursChart(A) {
    var W = 720, H = 200, l = 30, r = 8, t = 10, b = 22;
    var pw = W - l - r, ph = H - t - b, cw = pw / 24, bw = Math.max(3, cw * 0.36);
    var mx = niceMax(Math.max.apply(null, A.vHours.concat(A.dHours, [1])));
    function X(c) { return l + (c + 0.5) * cw; }
    function Y(v) { return t + ph - (v / mx) * ph; }
    var s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Распределение затяжек и потягов по часам суток">';
    [0, 0.5, 1].forEach(function (f) {
      var y = Y(mx * f);
      s += '<line class="grid" x1="' + l + '" x2="' + (W - r) + '" y1="' + y + '" y2="' + y + '"/>';
      s += '<text x="' + (l - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + Math.round(mx * f) + '</text>';
    });
    for (var c = 0; c < 24; c++) {
      var h = (Q.DAY_START_H + c) % 24;
      var hv = (A.vHours[h] / mx) * ph, hd = (A.dHours[h] / mx) * ph;
      if (A.vHours[h] > 0) s += '<rect class="b-vape" x="' + (X(c) - bw - 1) + '" y="' + (t + ph - hv) + '" width="' + bw + '" height="' + hv + '" rx="2"/>';
      if (A.dHours[h] > 0) s += '<rect class="b-dummy" x="' + (X(c) + 1) + '" y="' + (t + ph - hd) + '" width="' + bw + '" height="' + hd + '" rx="2"/>';
      if (c % 3 === 0) s += '<text x="' + X(c) + '" y="' + (H - 6) + '" text-anchor="middle">' + Q.pad(h) + '</text>';
      s += '<rect class="hit" data-hour="' + h + '" x="' + (l + c * cw) + '" y="' + t + '" width="' + cw + '" height="' + ph + '"/>';
    }
    s += '<line class="axis" x1="' + l + '" x2="' + (W - r) + '" y1="' + (t + ph) + '" y2="' + (t + ph) + '"/>';
    return s + '</svg>';
  }

  /* ---------- экраны ---------- */

  function viewToday(c) {
    var S = c.S, plan = c.plan, st = c.stats[c.today] || Q.emptyStats();
    var idx = plan.todayIdx, limit = Q.limitForIdx(plan, idx);
    var disabled = state.ready ? '' : ' disabled';
    var h = '';

    var head;
    if (idx < 1) head = 'План стартует ' + Q.ruDate(S.startDate) + ' (через ' + Q.withWord(1 - idx, Q.W_DAY) + '). Отметки до старта в план не входят.';
    else head = Q.dayLabel(idx, S.totalDays).replace(/^./, function (x) { return x.toUpperCase(); }) + ', ' + Q.ruWeekday(c.today) + ', ' + Q.ruDate(c.today);
    h += '<p class="day-line">' + esc(head) + '</p>';

    /* вейп */
    h += '<section class="counter vape"><p class="label">Вейп</p><p class="big"><span class="value">' + st.vape + '</span>';
    if (limit !== null) h += '<span class="of">из ' + limit + '</span>';
    h += '</p>';
    if (limit !== null) {
      var scale = Math.max(st.vape, limit, 1);
      h += '<div class="meter" aria-hidden="true"><div class="fill" style="width:' + (Math.min(st.vape, limit) / scale * 100) + '%"></div>';
      if (st.vape > limit) h += '<div class="over" style="left:' + (limit / scale * 100) + '%;width:' + ((st.vape - limit) / scale * 100) + '%"></div>';
      if (st.vape > limit) h += '<div class="tick" style="left:calc(' + (limit / scale * 100) + '% - 1px)"></div>';
      h += '</div>';
      var note;
      if (st.vape < limit) note = 'Осталось ' + Q.withWord(limit - st.vape, Q.W_PUFF) + '.';
      else if (st.vape === limit) note = 'Лимит выбран полностью.';
      else note = '<span class="bad">Лимит превышен на ' + (st.vape - limit) + '.</span> Снижение лимита подождёт: оно идёт после двух дней в лимите.';
      h += '<p class="note">' + note + '</p>';
      var pace = Q.paceLimit(limit, S, c.now);
      h += '<p class="muted small">Равномерный темп к этому часу: до ' + pace + '.</p>';
    } else if (idx >= 1) {
      h += '<p class="note">Идёт замер нормы (день ' + idx + ' из ' + S.measureDays + '), лимита пока нет. Отмечай всё как есть.</p>';
    }
    h += '<p class="muted small" style="margin-top:.3rem">' + Q.withWord(st.vapeSessions, Q.W_SESSION) + '. ';
    h += st.lastVape ? 'Последняя затяжка ' + agoText(st.lastVape) + ' (в ' + Q.hhmm(st.lastVape) + ').' : 'Сегодня вейп без отметок.';
    h += '</p>';
    h += '<div class="tap"><button class="t-vape" data-act="log" data-k="v" data-n="1"' + disabled + '>+1 затяжка</button>' +
         '<button class="t-vape" data-act="log" data-k="v" data-n="5"' + disabled + '>+5</button></div>';
    h += '</section>';

    /* пустышка */
    h += '<section class="counter dummy"><p class="label">Пустышка</p><p class="big"><span class="value">' + st.dummy + '</span><span class="of">' + Q.plural(st.dummy, Q.W_PULL) + ', без лимита</span></p>';
    h += '<p class="muted small">' + Q.withWord(st.dummySessions, Q.W_SESSION) + '.</p>';
    h += '<div class="tap"><button class="t-dummy" data-act="log" data-k="d" data-n="1"' + disabled + '>+1 потяг</button>' +
         '<button class="t-dummy" data-act="log" data-k="d" data-n="5"' + disabled + '>+5</button></div>';
    h += '</section>';

    /* метки */
    h += '<section class="section"><h2>Что запускает тягу</h2><p class="muted small">Метка прикрепится к следующей отметке и сбросится. Можно не ставить.</p><div class="chips" style="margin-top:.6rem">';
    Q.TRIGGERS.forEach(function (t) {
      h += '<button class="chip" data-act="trig" data-t="' + esc(t) + '" aria-pressed="' + (ui.trig === t) + '">' + esc(t) + '</button>';
    });
    h += '</div></section>';

    /* журнал */
    var list = (state.days[c.today] || []).slice().sort(function (a, b) { return b.t - a.t; });
    h += '<section class="section"><h2>Журнал дня</h2>';
    if (!list.length) h += '<p class="muted">Пока пусто.</p>';
    else {
      h += '<div class="btn-row" style="margin-bottom:.5rem"><button class="link-btn" data-act="undo">Отменить последнюю отметку</button></div>';
      h += '<div class="table-wrap"><table><thead><tr><th>Время</th><th>Что</th><th class="r">Сколько</th><th>Метка</th><th></th></tr></thead><tbody>';
      list.slice(0, 20).forEach(function (e) {
        h += '<tr><td>' + Q.hhmm(e.t) + '</td><td>' + (e.k === 'v' ? 'Вейп' : 'Пустышка') + '</td><td class="r">' + (e.n || 1) + '</td><td>' + esc(e.tr || '') + '</td>' +
             '<td><button class="link-btn" data-act="del" data-key="' + c.today + '" data-id="' + esc(e.id) + '">удалить</button></td></tr>';
      });
      h += '</tbody></table></div>';
      if (list.length > 20) h += '<p class="muted small" style="margin-top:.4rem">Показаны последние 20 из ' + list.length + '.</p>';
    }
    return h + '</section>';
  }

  function viewPlan(c) {
    var S = c.S, plan = c.plan, rows = Q.dayRows(S, plan, c.stats);
    ui.rows = rows;
    var B = plan.B, h = '';
    var src = B.source === 'measured' ? 'замерено за ' + Q.withWord(B.n, Q.W_DAY)
      : B.source === 'manual' ? 'задана вручную' : 'пока предположение, уточнится после первого полного дня замера';

    h += '<section class="section"><h2>Где ты сейчас</h2><div class="facts">';
    h += '<p>Исходная норма: <strong>' + B.value + '</strong> ' + Q.plural(B.value, Q.W_PUFF) + ' в день (' + src + ').</p>';
    if (plan.todayIdx < 1) h += '<p>План стартует ' + Q.ruDate(S.startDate) + '.</p>';
    else if (plan.todayIdx <= plan.M) h += '<p>Сейчас замер нормы, лимит появится с дня ' + (plan.M + 1) + ' (' + Q.ruDate(Q.addDays(S.startDate, plan.M)) + ').</p>';
    else {
      var lim = Q.limitForIdx(plan, plan.todayIdx);
      h += '<p>Уровень <strong>' + plan.atToday.level + ' из ' + plan.K + '</strong>, лимит сегодня <strong>' + lim + '</strong>.</p>';
      if (plan.atToday.level < plan.K) h += '<p>До следующего уровня: ' + Q.withWord(Math.max(0, Q.STEP_DAYS - plan.atToday.ok), Q.W_DAY) + ' в лимите.</p>';
    }
    if (plan.firstZero !== null) {
      var zk = Q.addDays(S.startDate, plan.firstZero - 1), delay = plan.firstZero - plan.plannedZero;
      h += '<p>Первый день без вейпа: <strong>' + Q.ruDate(zk) + '</strong>, день ' + plan.firstZero + '. ' +
           (delay > 0 ? '<span class="bad">Позже графика на ' + Q.withWord(delay, Q.W_DAY) + '.</span>' : 'Это по графику.') + '</p>';
    }
    h += '</div></section>';

    h += '<section class="section"><h2>Динамика по дням</h2>' + planChart(rows, plan);
    h += '<div class="legend"><span><i class="sw-bar"></i>вейп, затяжек</span><span><i class="sw-line"></i>пустышка, потягов</span><span><i class="sw-dash"></i>лимит вейпа</span></div>';
    h += '<p class="readout" id="readout">Нажми на день, чтобы увидеть цифры.</p></section>';

    h += '<section class="section"><h2>Таблица дней</h2><div class="table-wrap"><table><thead><tr><th>День</th><th>Дата</th><th class="r">Лимит</th><th class="r">Вейп</th><th class="r">Пустышка</th><th>Итог</th></tr></thead><tbody>';
    var labels = { measure: 'замер', ok: 'в лимите', over: 'выше лимита', none: 'нет отметок', today: 'сегодня', future: '' };
    rows.forEach(function (x) {
      var fut = x.status === 'future';
      h += '<tr class="' + (x.status === 'today' ? 'today' : fut ? 'future' : '') + '"><td>' + x.idx + '</td><td>' + Q.ruDate(x.key) + '</td><td class="r">' +
           (x.limit === null ? '—' : x.limit) + '</td><td class="r">' + (fut ? '' : x.vape) + '</td><td class="r">' + (fut ? '' : x.dummy) + '</td><td>' +
           (x.status === 'over' ? '<span class="bad">' + labels.over + '</span>' : labels[x.status]) + '</td></tr>';
    });
    h += '</tbody></table></div><p class="muted small" style="margin-top:.5rem">Лимиты будущих дней показаны при условии, что каждый день укладываешься. Если нет, график сдвигается.</p></section>';
    return h;
  }

  function viewAnalysis(c) {
    var keys = Object.keys(c.stats).filter(function (k) { return k <= c.today; }).sort();
    if (ui.period === 'today') keys = keys.filter(function (k) { return k === c.today; });
    else if (ui.period === '7') keys = keys.filter(function (k) { return k > Q.addDays(c.today, -7); });
    var A = Q.sumStats(c.stats, keys);
    var h = '';
    var opts = [['today', 'Сегодня'], ['7', '7 дней'], ['all', 'Всё время']];

    h += '<section class="section"><h2>Период</h2><div class="chips">';
    opts.forEach(function (o) { h += '<button class="chip" data-act="period" data-p="' + o[0] + '" aria-pressed="' + (ui.period === o[0]) + '">' + o[1] + '</button>'; });
    h += '</div></section>';

    h += '<section class="section"><h2>Когда тянет</h2>' + hoursChart(A);
    h += '<div class="legend"><span><i class="sw-bar"></i>вейп, затяжек</span><span><i class="sw-bar d"></i>пустышка, потягов</span></div>';
    h += '<p class="readout" id="readout">Нажми на час, чтобы увидеть цифры. Часы идут с 04:00, как и сутки.</p></section>';

    h += '<section class="section"><h2>Наблюдения</h2><ul class="plain">';
    Q.observations(A, c.plan.B.value).forEach(function (o) { h += '<li>' + esc(o) + '</li>'; });
    h += '</ul></section>';

    var names = {};
    Object.keys(A.vTrig).concat(Object.keys(A.dTrig)).forEach(function (k) { names[k] = 1; });
    var tl = Object.keys(names).sort(function (a, b) { return (A.vTrig[b] || 0) - (A.vTrig[a] || 0); });
    h += '<section class="section"><h2>Метки</h2>';
    if (!tl.length) h += '<p class="muted">Нет данных за период.</p>';
    else {
      h += '<div class="table-wrap"><table><thead><tr><th>Метка</th><th class="r">Вейп</th><th class="r">Доля вейпа</th><th class="r">Пустышка</th></tr></thead><tbody>';
      tl.forEach(function (k) {
        var v = A.vTrig[k] || 0;
        h += '<tr><td>' + esc(k) + '</td><td class="r">' + v + '</td><td class="r">' + (A.vape ? Math.round(v / A.vape * 100) + '%' : '—') + '</td><td class="r">' + (A.dTrig[k] || 0) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '</section>';

    var wr = Q.weekRows(c.S, c.stats, c.plan);
    h += '<section class="section"><h2>По неделям</h2>';
    if (!wr.length) h += '<p class="muted">Появится после первого завершённого дня.</p>';
    else {
      h += '<div class="table-wrap"><table><thead><tr><th>Неделя</th><th class="r">Вейп в день</th><th class="r">Пустышка в день</th><th class="r">К норме</th></tr></thead><tbody>';
      wr.forEach(function (w) {
        h += '<tr><td>' + w.label + '</td><td class="r">' + w.vAvg + '</td><td class="r">' + w.dAvg + '</td><td class="r">' + Q.signed(w.vs) + '%</td></tr>';
      });
      h += '</tbody></table></div><p class="muted small" style="margin-top:.5rem">Среднее по завершённым дням, сегодняшний день не считается.</p>';
    }
    return h + '</section>';
  }

  function viewReport(c) {
    var key = ui.reportKey || c.today;
    var text = Q.buildReport(c.S, c.stats, c.plan, key);
    var h = '<section class="section"><h2>Итоги дня для Telegram</h2>';
    h += '<div class="btn-row" style="margin-top:.75rem"><button class="btn plain" data-act="rshift" data-d="-1" aria-label="Предыдущий день">←</button>' +
         '<input type="date" id="r-date" value="' + key + '" max="' + c.today + '" style="width:auto">' +
         '<button class="btn plain" data-act="rshift" data-d="1" aria-label="Следующий день">→</button></div>';
    h += '<textarea id="r-text" rows="16" readonly style="margin-top:.75rem">' + esc(text) + '</textarea>';
    h += '<div class="btn-row" style="margin-top:.6rem"><button class="btn primary" data-act="copy">Скопировать текст</button></div>';
    h += '<p class="msg" id="msg"></p></section>';
    return h;
  }

  function viewSetup(c) {
    var S = c.S, h = '<section class="section"><h2>План</h2><div class="fields">';
    h += '<div class="field"><label for="s-start">Дата старта</label><input type="date" id="s-start" value="' + S.startDate + '"><span class="hint">С этого дня идёт отсчёт дней плана.</span></div>';
    h += '<div class="pair"><div class="field"><label for="s-total">Дней всего</label><input type="number" id="s-total" min="10" max="120" value="' + S.totalDays + '"></div>' +
         '<div class="field"><label for="s-measure">Дней замера</label><input type="number" id="s-measure" min="1" max="7" value="' + S.measureDays + '"></div></div>';
    h += '<div class="field"><label for="s-base">Исходная норма, затяжек в день</label><input type="number" id="s-base" min="1" max="2000" value="' + (S.baseline || '') + '" placeholder="считать по замеру"><span class="hint">Пусто: возьмётся среднее за дни замера. Если задать число, замер не используется.</span></div>';
    h += '<div class="pair"><div class="field"><label for="s-from">Подъём, час</label><input type="number" id="s-from" min="0" max="12" value="' + S.wakeFrom + '"></div>' +
         '<div class="field"><label for="s-to">Отбой, час</label><input type="number" id="s-to" min="13" max="28" value="' + S.wakeTo + '"></div></div>';
    h += '<span class="hint">Часы нужны для расчёта равномерного темпа в течение дня.</span>';
    h += '</div></section>';

    h += '<section class="section"><h2>Копия данных</h2><p class="muted small">Текстовая копия всех отметок. Её можно сохранить в заметках или перенести на другое устройство.</p>';
    h += '<div class="btn-row" style="margin-top:.6rem"><button class="btn" data-act="export">Показать копию</button><button class="btn" data-act="import">Загрузить из поля</button></div>';
    h += '<textarea id="b-text" rows="6" style="margin-top:.6rem" placeholder="Здесь появится копия. Для загрузки вставь сюда текст копии."></textarea><p class="msg" id="msg"></p></section>';

    h += '<section class="section"><h2>Сброс</h2><p class="muted small">Удаляет все отметки и возвращает настройки по умолчанию.</p><div class="btn-row" style="margin-top:.6rem">';
    if (!ui.resetArmed) h += '<button class="btn danger" data-act="reset1">Удалить все данные</button>';
    else h += '<button class="btn danger" data-act="reset2">Да, удалить без возврата</button><button class="btn plain" data-act="reset0">Отмена</button>';
    return h + '</div></section>';
  }

  /* ---------- отрисовка ---------- */

  function render() {
    var c = { S: state.settings, now: Date.now(), today: todayKey() };
    c.stats = Q.allStats(state.days);
    c.plan = Q.buildPlan(c.S, c.stats, c.today);

    tabsEl.innerHTML = VIEWS.map(function (v) {
      return '<a href="#' + v[0] + '"' + (ui.view === v[0] ? ' aria-current="page"' : '') + '>' + v[1] + '</a>';
    }).join('');

    var html = ui.view === 'plan' ? viewPlan(c)
      : ui.view === 'analysis' ? viewAnalysis(c)
      : ui.view === 'report' ? viewReport(c)
      : ui.view === 'setup' ? viewSetup(c)
      : viewToday(c);
    viewEl.innerHTML = html;
    viewEl._ctx = c;
  }

  function routeFromHash() {
    var name = (location.hash || '').replace('#', '');
    ui.view = VIEWS.some(function (v) { return v[0] === name; }) ? name : 'today';
    render();
  }

  /* ---------- события ---------- */

  viewEl.addEventListener('click', function (e) {
    var hit = e.target.closest('.hit');
    if (hit) {
      var ro = document.getElementById('readout'), c = viewEl._ctx;
      if (hit.hasAttribute('data-day')) {
        var x = ui.rows[Number(hit.getAttribute('data-day'))];
        if (x && ro) {
          ro.textContent = 'День ' + x.idx + ', ' + Q.ruDate(x.key) + ': ' +
            (x.status === 'future' ? 'впереди' : 'вейп ' + x.vape + ', пустышка ' + x.dummy) +
            (x.limit === null ? ', замер' : ', лимит ' + x.limit);
        }
      } else if (hit.hasAttribute('data-hour') && ro) {
        var hh = Number(hit.getAttribute('data-hour'));
        var keys = Object.keys(c.stats).filter(function (k) { return k <= c.today; });
        if (ui.period === 'today') keys = keys.filter(function (k) { return k === c.today; });
        else if (ui.period === '7') keys = keys.filter(function (k) { return k > Q.addDays(c.today, -7); });
        var A = Q.sumStats(c.stats, keys);
        ro.textContent = Q.hourRange(hh) + ': вейп ' + A.vHours[hh] + ', пустышка ' + A.dHours[hh];
      }
      return;
    }

    var b = e.target.closest('[data-act]');
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'log') logEvent(b.getAttribute('data-k'), Number(b.getAttribute('data-n')));
    else if (act === 'undo') undoLast();
    else if (act === 'del') removeEvent(b.getAttribute('data-key'), b.getAttribute('data-id'));
    else if (act === 'trig') { var t = b.getAttribute('data-t'); ui.trig = ui.trig === t ? null : t; render(); }
    else if (act === 'period') { ui.period = b.getAttribute('data-p'); render(); }
    else if (act === 'rshift') {
      var base = ui.reportKey || todayKey(), next = Q.addDays(base, Number(b.getAttribute('data-d')));
      if (next <= todayKey()) { ui.reportKey = next; render(); }
    }
    else if (act === 'copy') { var ta = document.getElementById('r-text'); copyText(ta.value, ta); }
    else if (act === 'export') {
      var box = document.getElementById('b-text');
      box.value = JSON.stringify({ v: 1, settings: state.settings, days: state.days });
      box.focus(); box.select();
      flash('Копия готова. Скопируй текст из поля.');
    }
    else if (act === 'import') importBackup();
    else if (act === 'reset1') { ui.resetArmed = true; render(); }
    else if (act === 'reset0') { ui.resetArmed = false; render(); }
    else if (act === 'reset2') resetAll();
  });

  viewEl.addEventListener('change', function (e) {
    var id = e.target.id || '';
    if (id.indexOf('s-') === 0) readSettingsForm();
    else if (id === 'r-date' && e.target.value) { ui.reportKey = e.target.value > todayKey() ? todayKey() : e.target.value; render(); }
  });

  window.addEventListener('hashchange', routeFromHash);

  setInterval(function () {
    if (ui.view === 'today' && state.ready && !viewEl.contains(document.activeElement)) render();
  }, 30000);

  /* ---------- запуск ---------- */

  routeFromHash();
  Store.init(function () { render(); });
})();
