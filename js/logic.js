/*
 * Расчёты трекера: дни, статистика, план лимитов, отчёт.
 * Без обращения к DOM, чтобы файл можно было проверять в node.
 */
(function (root) {
  'use strict';

  var DAY_START_H = 4;                  // сутки начинаются в 04:00, ночные затяжки идут в прошлый день
  var SESSION_GAP_MS = 10 * 60 * 1000;  // пауза больше 10 минут начинает новый подход
  var STEP_DAYS = 2;                    // уровень лимита снижается после двух дней в лимите
  var NO_TRIGGER = 'без метки';
  var TRIGGERS = ['еда', 'кофе или чай', 'стресс', 'скука', 'учёба или работа', 'компания', 'дорога', 'просто привычка'];
  var MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

  /* ---------- даты и текст ---------- */

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateKey(ts) { return fmtDate(new Date(ts - DAY_START_H * 3600000)); }
  function parseKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0); }
  function addDays(k, n) { var d = parseKey(k); d.setDate(d.getDate() + n); return fmtDate(d); }
  function diffDays(a, b) { return Math.round((parseKey(b) - parseKey(a)) / 86400000); }
  function ruDate(k) { var d = parseKey(k); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function ruDateFull(k) { return ruDate(k) + ' ' + parseKey(k).getFullYear(); }
  function ruWeekday(k) { return WEEKDAYS[parseKey(k).getDay()]; }
  function dotDate(k) { var p = k.split('-'); return p[2] + '.' + p[1] + '.' + p[0]; }
  function hhmm(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hourRange(h) { return pad(h) + ':00–' + pad((h + 1) % 24) + ':00'; }

  function plural(n, forms) {
    n = Math.abs(n);
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return forms[0];
    if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return forms[1];
    return forms[2];
  }
  var W_PUFF = ['затяжка', 'затяжки', 'затяжек'];
  var W_PULL = ['потяг', 'потяга', 'потягов'];
  var W_SESSION = ['подход', 'подхода', 'подходов'];
  var W_DAY = ['день', 'дня', 'дней'];

  function withWord(n, forms) { return n + ' ' + plural(n, forms); }
  function signed(n) { return n > 0 ? '+' + n : n < 0 ? '−' + Math.abs(n) : '0'; }
  function dayLabel(idx, total) {
    if (idx < 1) return 'до старта';
    if (idx <= total) return 'день ' + idx + ' из ' + total;
    return 'день ' + idx + ' (сверх плана)';
  }
  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }
  function sum(a) { return a.reduce(function (s, v) { return s + v; }, 0); }

  /* ---------- настройки ---------- */

  function defaults(startKey) {
    return { startDate: startKey, totalDays: 35, measureDays: 3, baseline: null, guess: 120, wakeFrom: 7, wakeTo: 23 };
  }

  function mergeSettings(o, startKey) {
    var d = defaults(startKey);
    o = o || {};
    function num(v, lo, hi, def) {
      v = Number(v);
      return isFinite(v) && v >= lo && v <= hi ? Math.round(v) : def;
    }
    var S = {
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(o.startDate || '') ? o.startDate : d.startDate,
      totalDays: num(o.totalDays, 10, 120, d.totalDays),
      measureDays: num(o.measureDays, 1, 7, d.measureDays),
      baseline: o.baseline ? num(o.baseline, 1, 2000, null) : null,
      guess: d.guess,
      wakeFrom: num(o.wakeFrom, 0, 12, d.wakeFrom),
      wakeTo: num(o.wakeTo, 13, 28, d.wakeTo)
    };
    if (S.totalDays < S.measureDays + 4) S.totalDays = S.measureDays + 4;
    return S;
  }

  /* ---------- статистика по дням ---------- */

  function emptyStats() {
    return {
      vape: 0, dummy: 0, vapeSessions: 0, dummySessions: 0,
      vHours: zeros(24), dHours: zeros(24), vTrig: {}, dTrig: {},
      firstVape: null, lastVape: null, gaps: [], days: 0
    };
  }

  function dayStats(events) {
    var s = emptyStats();
    var list = (events || []).slice().sort(function (a, b) { return a.t - b.t; });
    var lastV = null, lastD = null;
    list.forEach(function (e) {
      var n = e.n || 1, h = new Date(e.t).getHours(), tr = e.tr || NO_TRIGGER;
      if (e.k === 'v') {
        s.vape += n;
        s.vHours[h] += n;
        s.vTrig[tr] = (s.vTrig[tr] || 0) + n;
        if (lastV === null || e.t - lastV > SESSION_GAP_MS) {
          s.vapeSessions++;
          if (lastV !== null) s.gaps.push(e.t - lastV);
        }
        lastV = e.t;
        if (s.firstVape === null) s.firstVape = e.t;
        s.lastVape = e.t;
      } else {
        s.dummy += n;
        s.dHours[h] += n;
        s.dTrig[tr] = (s.dTrig[tr] || 0) + n;
        if (lastD === null || e.t - lastD > SESSION_GAP_MS) s.dummySessions++;
        lastD = e.t;
      }
    });
    s.days = 1;
    return s;
  }

  function allStats(days) {
    var out = {};
    Object.keys(days || {}).forEach(function (k) { out[k] = dayStats(days[k]); });
    return out;
  }

  function sumStats(stats, keys) {
    var a = emptyStats();
    keys.forEach(function (k) {
      var s = stats[k];
      if (!s) return;
      a.days++;
      a.vape += s.vape; a.dummy += s.dummy;
      a.vapeSessions += s.vapeSessions; a.dummySessions += s.dummySessions;
      for (var h = 0; h < 24; h++) { a.vHours[h] += s.vHours[h]; a.dHours[h] += s.dHours[h]; }
      Object.keys(s.vTrig).forEach(function (t) { a.vTrig[t] = (a.vTrig[t] || 0) + s.vTrig[t]; });
      Object.keys(s.dTrig).forEach(function (t) { a.dTrig[t] = (a.dTrig[t] || 0) + s.dTrig[t]; });
      a.gaps = a.gaps.concat(s.gaps);
    });
    return a;
  }

  /* ---------- план лимитов ---------- */

  function stepCount(S) { return Math.max(1, Math.floor((S.totalDays - S.measureDays) / STEP_DAYS)); }
  function limitAt(B, level, K) { return Math.max(0, Math.round(B * (1 - level / K))); }

  function baselineOf(S, stats, todayKey) {
    if (S.baseline > 0) return { value: S.baseline, source: 'manual', n: 0 };
    var vals = [];
    for (var i = 0; i < S.measureDays; i++) {
      var key = addDays(S.startDate, i);
      if (key >= todayKey) break;
      var st = stats[key];
      if (st && st.vape > 0) vals.push(st.vape);
    }
    if (!vals.length) return { value: S.guess, source: 'guess', n: 0 };
    return { value: Math.round(sum(vals) / vals.length), source: 'measured', n: vals.length };
  }

  /*
   * Уровень лимита идёт вверх на 1 после двух дней в лимите (не обязательно подряд).
   * Будущие дни считаются выполненными, так строится прогноз и линия на графике.
   */
  function buildPlan(S, stats, todayKey) {
    var M = S.measureDays, K = stepCount(S);
    var B = baselineOf(S, stats, todayKey);
    var todayIdx = diffDays(S.startDate, todayKey) + 1;
    var end = Math.max(S.totalDays, todayIdx);
    var levels = {}, level = 0, ok = 0, atToday = { level: 0, ok: 0 }, firstZero = null, lastIdx = end;

    for (var d = M + 1; d < 400; d++) {
      if (d === M + 1) {
        level = 1;
      } else {
        var prev = d - 1, fact = 0;
        if (prev < todayIdx) {
          var st = stats[addDays(S.startDate, prev - 1)];
          fact = st ? st.vape : 0;
        }
        if (fact <= limitAt(B.value, levels[prev], K)) ok++;
        if (ok >= STEP_DAYS && level < K) { level++; ok = 0; }
      }
      levels[d] = level;
      if (d === todayIdx) atToday = { level: level, ok: ok };
      if (firstZero === null && level === K) firstZero = d;
      if (firstZero !== null && d >= end && d >= firstZero + 1) { lastIdx = d; break; }
    }

    return {
      B: B, K: K, M: M, todayIdx: todayIdx, levels: levels, atToday: atToday,
      firstZero: firstZero, lastIdx: lastIdx,
      plannedZero: M + 1 + STEP_DAYS * (K - 1)
    };
  }

  function limitForIdx(plan, idx) {
    if (idx <= plan.M) return null;
    var lv = plan.levels[idx];
    return lv === undefined ? 0 : limitAt(plan.B.value, lv, plan.K);
  }

  function tomorrowLimit(plan, idx, fact) {
    if (idx < plan.M) return null;
    if (idx === plan.M) return limitForIdx(plan, idx + 1);
    var lim = limitForIdx(plan, idx);
    if (idx === plan.todayIdx && fact > lim) return lim;
    return limitForIdx(plan, idx + 1);
  }

  function paceLimit(limit, S, now) {
    var d = new Date(now), h = d.getHours() + d.getMinutes() / 60;
    if (h < DAY_START_H) h += 24;
    var f = (h - S.wakeFrom) / (S.wakeTo - S.wakeFrom);
    f = Math.max(0, Math.min(1, f));
    return Math.round(limit * f);
  }

  function dayRows(S, plan, stats) {
    var rows = [];
    for (var idx = 1; idx <= plan.lastIdx; idx++) {
      var key = addDays(S.startDate, idx - 1);
      var st = stats[key];
      var limit = limitForIdx(plan, idx);
      var status;
      if (idx > plan.todayIdx) status = 'future';
      else if (idx === plan.todayIdx) status = 'today';
      else if (limit === null) status = 'measure';
      else if (!st) status = 'none';
      else status = st.vape <= limit ? 'ok' : 'over';
      rows.push({
        idx: idx, key: key, limit: limit, status: status,
        vape: st ? st.vape : 0, dummy: st ? st.dummy : 0
      });
    }
    return rows;
  }

  function weekRows(S, stats, plan) {
    var rows = [], B = plan.B.value;
    for (var w = 0; w * 7 + 1 <= plan.todayIdx; w++) {
      var keys = [];
      for (var i = 1; i <= 7; i++) {
        var idx = w * 7 + i;
        if (idx < plan.todayIdx && stats[addDays(S.startDate, idx - 1)]) keys.push(addDays(S.startDate, idx - 1));
      }
      if (!keys.length) continue;
      var a = sumStats(stats, keys);
      var vAvg = Math.round(a.vape / keys.length), dAvg = Math.round(a.dummy / keys.length);
      rows.push({
        label: 'Дни ' + (w * 7 + 1) + '–' + (w * 7 + 7), days: keys.length,
        vAvg: vAvg, dAvg: dAvg, vs: B > 0 ? Math.round((vAvg / B - 1) * 100) : 0
      });
    }
    return rows;
  }

  /* ---------- наблюдения и отчёт ---------- */

  function topKey(obj, skip) {
    var best = null, bv = 0;
    Object.keys(obj).forEach(function (k) {
      if (k === skip) return;
      if (obj[k] > bv) { bv = obj[k]; best = k; }
    });
    return best === null ? null : { name: best, n: bv };
  }

  function peakHour(hours) {
    var best = -1, bv = 0;
    hours.forEach(function (v, h) { if (v > bv) { bv = v; best = h; } });
    return best < 0 ? null : { h: best, n: bv };
  }

  function observations(A, B) {
    var out = [];
    if (A.vape === 0 && A.dummy === 0) return ['За выбранный период нет отметок.'];
    if (A.vape > 0) {
      var p = peakHour(A.vHours);
      out.push('Пик вейпа: ' + hourRange(p.h) + ', ' + withWord(p.n, W_PUFF) + ' за период.');
      var evening = 0, night = 0;
      for (var h = 0; h < 24; h++) {
        if (h >= 20) evening += A.vHours[h];
        if (h < DAY_START_H) night += A.vHours[h];
      }
      out.push('После 20:00 приходится ' + Math.round(evening / A.vape * 100) + '% затяжек, ночью (00:00–04:00) ' + Math.round(night / A.vape * 100) + '%.');
      var tt = topKey(A.vTrig, NO_TRIGGER);
      if (tt) out.push('Чаще всего вейп идёт с меткой «' + tt.name + '»: ' + withWord(tt.n, W_PUFF) + '.');
      var unl = A.vTrig[NO_TRIGGER] || 0;
      if (unl / A.vape > 0.5) out.push('Больше половины затяжек без метки. С метками анализ триггеров будет точнее.');
      if (A.vapeSessions > 0) out.push('В среднем ' + (A.vape / A.vapeSessions).toFixed(1).replace('.', ',') + ' затяжек за подход, ' + (A.vapeSessions / Math.max(1, A.days)).toFixed(1).replace('.', ',') + ' подходов в день.');
      if (A.gaps.length) {
        var avg = Math.round(sum(A.gaps) / A.gaps.length / 60000);
        out.push('Средняя пауза между подходами вейпа ' + avg + ' мин, самая короткая ' + Math.round(Math.min.apply(null, A.gaps) / 60000) + ' мин.');
      }
    }
    if (A.dummy > 0 && A.vape > 0) {
      out.push('На одну затяжку вейпа приходится ' + (A.dummy / A.vape).toFixed(2).replace('.', ',') + ' потяга пустышки.');
    }
    return out;
  }

  function buildReport(S, stats, plan, key) {
    var st = stats[key] || emptyStats();
    var idx = diffDays(S.startDate, key) + 1;
    var limit = limitForIdx(plan, idx);
    var B = plan.B.value;
    var prev = stats[addDays(key, -1)];
    var L = [];

    L.push('Итоги дня: ' + ruDateFull(key) + ', ' + dayLabel(idx, S.totalDays));
    L.push('');
    var v = 'Вейп: ' + withWord(st.vape, W_PUFF) + ', ' + withWord(st.vapeSessions, W_SESSION) + '.';
    if (limit !== null) v += ' Лимит ' + limit + ', использовано ' + (limit > 0 ? Math.round(st.vape / limit * 100) + '%' : (st.vape > 0 ? 'сверх нуля' : '0%')) + '.';
    else if (idx >= 1) v += ' Лимита нет, идёт замер нормы.';
    L.push(v);
    L.push('Пустышка: ' + withWord(st.dummy, W_PULL) + ', ' + withWord(st.dummySessions, W_SESSION) + '.');

    if (prev) L.push('К предыдущему дню: вейп ' + signed(st.vape - prev.vape) + ', пустышка ' + signed(st.dummy - prev.dummy) + '.');
    if (st.vape > 0 && B > 0) L.push('К исходной норме (' + B + '): ' + signed(Math.round((st.vape / B - 1) * 100)) + '%.');

    if (st.firstVape !== null) L.push('Первая затяжка в ' + hhmm(st.firstVape) + ', последняя в ' + hhmm(st.lastVape) + '.');
    var p = peakHour(st.vHours);
    if (p) {
      var late = 0;
      for (var h = 20; h < 24; h++) late += st.vHours[h];
      L.push('Пик вейпа: ' + hourRange(p.h) + ' (' + withWord(p.n, W_PUFF) + '). После 20:00 приходится ' + Math.round(late / st.vape * 100) + '% затяжек.');
    }
    var trig = Object.keys(st.vTrig).sort(function (a, b) { return st.vTrig[b] - st.vTrig[a]; }).slice(0, 4);
    if (trig.length) L.push('Метки вейпа: ' + trig.map(function (t) { return t + ' ' + st.vTrig[t]; }).join(', ') + '.');
    if (st.gaps.length) {
      L.push('Пауза между подходами: в среднем ' + Math.round(sum(st.gaps) / st.gaps.length / 60000) + ' мин, самая короткая ' + Math.round(Math.min.apply(null, st.gaps) / 60000) + ' мин.');
    }

    var tm = tomorrowLimit(plan, idx, st.vape);
    if (idx >= 1 && tm !== null) L.push('Лимит на следующий день: ' + tm + '.');
    if (idx >= 1 && idx === plan.todayIdx && plan.firstZero !== null) {
      var zeroKey = addDays(S.startDate, plan.firstZero - 1);
      var delay = plan.firstZero - plan.plannedZero;
      L.push('Первый день без вейпа по текущему плану: ' + ruDate(zeroKey) + (delay > 0 ? ' (позже графика на ' + withWord(delay, W_DAY) + ')' : ' (по графику)') + '.');
    }

    var concl = [];
    if (limit !== null) {
      if (st.vape <= limit) concl.push('День в лимите, запас ' + withWord(limit - st.vape, W_PUFF) + '.');
      else concl.push('Лимит превышен на ' + withWord(st.vape - limit, W_PUFF) + ', снижение лимита отложено.');
    }
    if (prev && st.vape < prev.vape && st.dummy > prev.dummy) concl.push('Вейп снизился, пустышка выросла: часть тяги переходит на замену.');
    if (p && st.vape > 0) concl.push('Самое тяжёлое время: ' + hourRange(p.h) + ', пустышку лучше держать под рукой в этот интервал.');
    if (concl.length) { L.push(''); L.push('Вывод: ' + concl.join(' ')); }

    return L.join('\n');
  }

  var api = {
    DAY_START_H: DAY_START_H, SESSION_GAP_MS: SESSION_GAP_MS, STEP_DAYS: STEP_DAYS,
    TRIGGERS: TRIGGERS, NO_TRIGGER: NO_TRIGGER,
    W_PUFF: W_PUFF, W_PULL: W_PULL, W_SESSION: W_SESSION, W_DAY: W_DAY,
    pad: pad, dateKey: dateKey, addDays: addDays, diffDays: diffDays,
    ruDate: ruDate, ruDateFull: ruDateFull, ruWeekday: ruWeekday, dotDate: dotDate, hhmm: hhmm, hourRange: hourRange,
    plural: plural, withWord: withWord, signed: signed, dayLabel: dayLabel,
    defaults: defaults, mergeSettings: mergeSettings,
    emptyStats: emptyStats, dayStats: dayStats, allStats: allStats, sumStats: sumStats,
    stepCount: stepCount, limitAt: limitAt, baselineOf: baselineOf,
    buildPlan: buildPlan, limitForIdx: limitForIdx, tomorrowLimit: tomorrowLimit, paceLimit: paceLimit,
    dayRows: dayRows, weekRows: weekRows,
    topKey: topKey, peakHour: peakHour, observations: observations, buildReport: buildReport
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quit = api;
})(typeof window !== 'undefined' ? window : this);
