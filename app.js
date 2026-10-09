(function () {
  'use strict';

  /* ============ 配置 ============ */
  var INDICES = [
    { code: '883900', name: '昨日涨停表现', tag: '打板赚钱效应' },
    { code: '883918', name: '昨日炸板股', tag: '炸板亏钱效应' }
  ];
  var BASE = 'https://d.10jqka.com.cn';
  var REFRESH_SEC = 60;

  var charts = {};
  var left = REFRESH_SEC;
  var busy = false;

  /* ============ 工具 ============ */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function fixed(v, d) { var n = num(v); return n === null ? '--' : n.toFixed(d == null ? 2 : d); }
  function cls(v) { var n = num(v); return n === null ? 'flat' : (n > 0 ? 'up' : (n < 0 ? 'down' : 'flat')); }
  function sign(v) { var n = num(v); return n === null ? '' : (n > 0 ? '+' : ''); }
  function fmtAmt(v) {
    var n = num(v);
    if (n === null) return '--';
    var a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (a >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
    return n.toFixed(0);
  }
  function hhmm(s) { s = String(s); return s.length === 4 ? s.slice(0, 2) + ':' + s.slice(2) : s; }
  function dshort(s) { s = String(s); return s.length === 8 ? s.slice(4, 6) + '-' + s.slice(6, 8) : s; }
  function dstr(s) { s = String(s); return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function setText(id, txt) { var e = document.getElementById(id); if (e) e.textContent = txt; }
  function dirColor(k) { return k === 'up' ? '#d93025' : (k === 'down' ? '#0f9d58' : '#8a9099'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function marketPhase() {
    var d = new Date();
    var day = d.getDay();
    if (day === 0 || day === 6) return '周末休市';
    var m = d.getHours() * 60 + d.getMinutes();
    if (m < 570) return '盘前';
    if (m <= 690) return '盘中 · 早盘';
    if (m < 780) return '午间休市';
    if (m <= 900) return '盘中 · 午盘';
    return '盘后';
  }

  /* ============ JSONP ============ */
  function jsonp(url, cbName, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var done = false;
      var t = null;
      function cleanup() {
        if (t) { clearTimeout(t); t = null; }
        try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cbName] = function (data) {
        if (done) return;
        done = true; cleanup(); resolve(data);
      };
      script.onerror = function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('网络错误'));
      };
      t = setTimeout(function () {
        if (done) return;
        done = true; cleanup(); reject(new Error('超时'));
      }, timeoutMs || 12000);
      script.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      document.head.appendChild(script);
    });
  }

  function jsonpRetry(url, cbName, retries) {
    return jsonp(url, cbName).catch(function (e) {
      if (retries > 0) {
        return sleep(600).then(function () { return jsonpRetry(url, cbName, retries - 1); });
      }
      throw e;
    });
  }

  /* ============ 骨架 ============ */
  function statCell(label, id) {
    return '<div><span>' + label + '</span><b id="' + id + '">--</b></div>';
  }

  function buildCards() {
    var html = '';
    INDICES.forEach(function (idx) {
      var c = idx.code;
      html +=
        '<section class="card" id="card-' + c + '">' +
          '<div class="head">' +
            '<div class="name">' + idx.name + '<span class="code">' + c + '</span></div>' +
            '<div class="tag">' + idx.tag + '</div>' +
          '</div>' +
          '<div class="quote">' +
            '<div class="px flat" id="px-' + c + '">--</div>' +
            '<div class="chg flat" id="chg-' + c + '">--</div>' +
          '</div>' +
          '<div class="stats">' +
            statCell('今开', 'open-' + c) + statCell('最高', 'high-' + c) +
            statCell('最低', 'low-' + c) + statCell('昨收', 'pre-' + c) +
            statCell('成交额', 'amt-' + c) + statCell('成交量', 'vol-' + c) +
            statCell('换手率', 'turn-' + c) + statCell('量比', 'vr-' + c) +
          '</div>' +
          '<div class="chart-title">当日分时走势</div>' +
          '<div class="chart" id="tc-' + c + '"></div>' +
          '<div class="chart-title">近 60 个交易日收盘</div>' +
          '<div class="chart" id="kc-' + c + '"></div>' +
          '<div class="err-inline" id="errc-' + c + '"></div>' +
        '</section>';
    });
    document.getElementById('grid').innerHTML = html;
  }

  /* ============ 图表 ============ */
  function getChart(id) {
    if (!charts[id]) {
      var dom = document.getElementById(id);
      if (!dom) return null;
      charts[id] = echarts.init(dom);
      window.addEventListener('resize', function () { charts[id].resize(); });
    }
    return charts[id];
  }

  function baseTooltip(unit) {
    return {
      trigger: 'axis',
      backgroundColor: 'rgba(255,255,255,.97)',
      borderColor: '#e8eaed',
      borderWidth: 1,
      textStyle: { color: '#1f2329', fontSize: 12 },
      formatter: function (ps) {
        if (!ps || !ps.length) return '';
        var it = ps[0];
        var v = it.data == null ? '--' : Number(it.data).toFixed(3);
        return it.axisValue + '<br/>' + unit + ' ' + v;
      }
    };
  }

  function drawTimeSeries(code, rows, pre, color) {
    var xs = [], ys = [];
    rows.forEach(function (r) {
      var p = r.split(',');
      if (p.length < 2 || !p[1]) return;
      xs.push(hhmm(p[0]));
      ys.push(num(p[1]));
    });
    var c = getChart('tc-' + code);
    if (!c) return;
    var step = xs.length ? Math.max(0, Math.ceil(xs.length / 6) - 1) : 0;
    c.setOption({
      animation: false,
      grid: { left: 58, right: 16, top: 18, bottom: 26 },
      tooltip: baseTooltip('指数'),
      xAxis: {
        type: 'category', data: xs, boundaryGap: false,
        axisLine: { lineStyle: { color: '#dfe2e7' } },
        axisTick: { show: false },
        axisLabel: { color: '#9aa1ab', fontSize: 10, interval: step }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#9aa1ab', fontSize: 10 },
        splitLine: { lineStyle: { color: '#f1f2f4' } }
      },
      series: [{
        type: 'line', data: ys, symbol: 'none', smooth: false,
        lineStyle: { width: 1.6, color: color },
        areaStyle: { color: color, opacity: 0.08 },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#b9bec6', type: 'dashed', width: 1 },
          label: { show: false },
          data: [{ yAxis: num(pre) }]
        }
      }]
    }, true);
  }

  function drawDailySeries(code, rows) {
    var ds = [], cs = [];
    rows.forEach(function (r) {
      var p = r.split(',');
      if (p.length < 5 || !p[4]) return;
      ds.push(dshort(p[0]));
      cs.push(num(p[4]));
    });
    var c = getChart('kc-' + code);
    if (!c) return;
    var step = ds.length ? Math.max(0, Math.ceil(ds.length / 6) - 1) : 0;
    c.setOption({
      animation: false,
      grid: { left: 58, right: 16, top: 18, bottom: 26 },
      tooltip: baseTooltip('收盘'),
      xAxis: {
        type: 'category', data: ds, boundaryGap: false,
        axisLine: { lineStyle: { color: '#dfe2e7' } },
        axisTick: { show: false },
        axisLabel: { color: '#9aa1ab', fontSize: 10, interval: step }
      },
      yAxis: {
        type: 'value', scale: true,
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: '#9aa1ab', fontSize: 10 },
        splitLine: { lineStyle: { color: '#f1f2f4' } }
      },
      series: [{
        type: 'line', data: cs, symbol: 'none', smooth: false,
        lineStyle: { width: 1.5, color: '#4b5563' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(75,85,99,.18)' },
              { offset: 1, color: 'rgba(75,85,99,.01)' }
            ]
          }
        }
      }]
    }, true);
  }

  /* ============ 渲染 ============ */
  function render(idx, head, line, timePack) {
    var code = idx.code;
    var items = (head && head.items) ? head.items : {};

    var price = num(items['10']);
    var pre = num(items['6']);
    var chg = num(items['264648']);
    var pct = num(items['199112']);
    var k = cls(pct);

    var px = document.getElementById('px-' + code);
    if (px) { px.textContent = fixed(price, 3); px.className = 'px ' + k; }

    var ch = document.getElementById('chg-' + code);
    if (ch) {
      ch.textContent = sign(chg) + fixed(chg, 3) + '   ' + sign(pct) + fixed(pct, 2) + '%';
      ch.className = 'chg ' + k;
    }

    setText('open-' + code, fixed(items['7'], 3));
    setText('high-' + code, fixed(items['8'], 3));
    setText('low-' + code, fixed(items['9'], 3));
    setText('pre-' + code, fixed(pre, 3));
    setText('amt-' + code, fmtAmt(items['19']));
    setText('vol-' + code, fmtAmt(items['13']));
    setText('turn-' + code, fixed(items['1968584'], 2) + '%');
    setText('vr-' + code, fixed(items['526792'], 2));

    var pack = (timePack && timePack['48_' + code]) ? timePack['48_' + code] : null;
    var rows = (pack && pack.data) ? pack.data.split(';') : [];
    drawTimeSeries(code, rows, pre, dirColor(k));

    var lineRows = (line && line.data) ? line.data.split(';') : [];
    drawDailySeries(code, lineRows.slice(-60));
  }

  /* ============ 加载 ============ */
  function soft(promise, assign) {
    return promise.then(function (d) { assign(d); return true; }).catch(function () { return false; });
  }

  function loadOne(idx) {
    var c = idx.code;
    var errEl = document.getElementById('errc-' + c);
    if (errEl) errEl.textContent = '';
    var head = null, line = null, tp = null, okCount = 0;
    var U = BASE + '/';
    return soft(jsonpRetry(U + 'v2/realhead/48_' + c + '/last.js', 'quotebridge_v2_realhead_48_' + c + '_last', 1),
      function (d) { head = d; okCount++; })
      .then(function () {
        return soft(jsonpRetry(U + 'v6/line/48_' + c + '/01/last.js', 'quotebridge_v6_line_48_' + c + '_01_last', 1),
          function (d) { line = d; okCount++; });
      })
      .then(function () {
        return soft(jsonpRetry(U + 'v6/time/48_' + c + '/last.js', 'quotebridge_v6_time_48_' + c + '_last', 1),
          function (d) { tp = d; okCount++; });
      })
      .then(function () {
        if (okCount === 0) {
          if (errEl) errEl.textContent = '数据获取失败，将在下一轮自动重试。';
          return { ok: false };
        }
        if (okCount < 3 && errEl) errEl.textContent = '部分接口请求失败，已展示可用数据，下一轮自动重试。';
        render(idx, head, line, tp);
        var pack = (tp && tp['48_' + c]) ? tp['48_' + c] : null;
        return { ok: true, dataDate: pack ? pack.date : null, trading: pack ? pack.isTrading : 0 };
      });
  }

  function updateStatus(res) {
    var dot = document.getElementById('liveDot');
    var anyOk = res.some(function (x) { return x.ok; });
    var dd = null, trading = 0;
    res.forEach(function (x) {
      if (x.dataDate) dd = x.dataDate;
      if (x.trading) trading = x.trading;
    });
    if (dot) dot.className = 'dot' + (anyOk ? ' on' : ' err');
    setText('liveText', anyOk ? (trading ? '已连接 · 盘中实时刷新' : '已连接 · 自动刷新中') : '连接异常 · 重试中');
    if (anyOk) setText('quoteTime', dd ? dstr(dd) : '--');
  }

  function refreshAll() {
    if (busy) return;
    busy = true;
    var dot = document.getElementById('liveDot');
    if (dot) dot.className = 'dot';
    setText('liveText', '正在请求数据…');

    var res = [];
    var chain = Promise.resolve();
    INDICES.forEach(function (idx, i) {
      chain = chain
        .then(function () { return loadOne(idx).then(function (r) { res.push(r); }); })
        .then(function () { return i < INDICES.length - 1 ? sleep(350) : null; });
    });
    chain.then(function () {
      busy = false;
      left = REFRESH_SEC;
      updateStatus(res);
    });
  }

  function tick() {
    var now = new Date();
    setText('localTime', pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds()) + ' · ' + marketPhase());
    left -= 1;
    if (left <= 0) {
      setText('countdown', '—');
      refreshAll();
    } else {
      setText('countdown', left);
    }
  }

  /* ============ 启动 ============ */
  buildCards();
  refreshAll();
  setInterval(tick, 1000);
})();
