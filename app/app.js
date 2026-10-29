/*
  Watts365 Places Toolbox - application
    Version: v1.0
    Date: 29/10/2026
    Author: Rob Watts (UC Rob) | watts365.com

  ES5 only: mshta renders with the IE11 engine. Talks to engine\PlacesToolbox.Engine.ps1
  through job files in %LOCALAPPDATA%\Watts365\PlacesToolbox\Sessions\<session>.
*/
(function () {
  'use strict';

  var VERSION = '1.0';
  var fso = new ActiveXObject('Scripting.FileSystemObject');
  var sh = new ActiveXObject('WScript.Shell');

  /* ================= Utilities ================= */

  function env(n) { return sh.ExpandEnvironmentStrings('%' + n + '%'); }
  function $(id) { return document.getElementById(id); }
  function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function trim(s) { return s == null ? '' : String(s).replace(/^\s+|\s+$/g, ''); }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function stripBom(s) { return s && s.charCodeAt(0) === 0xFEFF ? s.substr(1) : s; }
  function psq(s) { return "'" + String(s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&') + "'"; }
  function closest(el, sel) {
    while (el && el.nodeType === 1) {
      var m = el.matches || el.msMatchesSelector;
      if (m.call(el, sel)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '-' + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
  }
  function clock(d) { return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2); }
  function secs(ms) { return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'; }
  function b64ps(script) {
    // -EncodedCommand wants base64 of UTF-16LE
    var bin = '';
    for (var i = 0; i < script.length; i++) { var c = script.charCodeAt(i); bin += String.fromCharCode(c & 255, c >> 8); }
    return window.btoa(bin);
  }
  function find(list, key, val) { for (var i = 0; i < list.length; i++) if (list[i][key] === val) return list[i]; return null; }
  function getCI(obj, name) {
    if (!obj) return undefined;
    var l = name.toLowerCase();
    for (var k in obj) if (obj.hasOwnProperty(k) && k.toLowerCase() === l) return obj[k];
    return undefined;
  }
  function copyText(t) { try { window.clipboardData.setData('Text', t); toast('Copied to clipboard'); } catch (e) { toast('Copy failed'); } }
  function openPath(p) { try { sh.Run('"' + p + '"', 1, false); } catch (e) { toast('Could not open ' + p); } }
  function openFolder(p) { try { mkdirs(p); sh.Run('explorer.exe "' + p + '"', 1, false); } catch (e) { toast('Could not open ' + p); } }
  function openUrl(u) { try { sh.Run('"' + u + '"', 1, false); } catch (e) { } }

  /* ================= Files ================= */

  function rootFolder() {
    var p = decodeURIComponent(String(document.location.href).split('?')[0].split('#')[0]);
    p = p.replace(/^file:\/*/i, '').replace(/\//g, '\\');
    if (!/^[A-Za-z]:/.test(p)) p = '\\\\' + p;
    return fso.GetParentFolderName(p);
  }
  var ROOT = rootFolder();
  var DATA = env('LOCALAPPDATA') + '\\Watts365\\PlacesToolbox';

  function mkdirs(p) { if (!p || fso.FolderExists(p)) return; mkdirs(fso.GetParentFolderName(p)); fso.CreateFolder(p); }
  function readText(p, offset) {
    try {
      if (!fso.FileExists(p)) return null;
      var f = fso.OpenTextFile(p, 1, false, -1);
      if (offset) { try { f.Skip(offset); } catch (e) { f.Close(); return ''; } }
      var t = f.AtEndOfStream ? '' : f.ReadAll();
      f.Close();
      return t;
    } catch (e) { return null; }
  }
  function writeText(p, t) { var f = fso.CreateTextFile(p, true, true); f.Write(t); f.Close(); }
  function del(p) { try { if (fso.FileExists(p)) fso.DeleteFile(p, true); } catch (e) { } }
  function touch(p) { try { writeText(p, String(new Date().getTime())); } catch (e) { } }

  /* ================= State & settings ================= */

  var S = {
    settings: null, session: null, pwsh: null,
    engine: { state: 'stopped' },
    jobs: [], seq: 0,
    status: null, statusPending: false,
    index: null, byId: {}, kids: {}, indexPending: false,
    devices: null,
    view: { kind: 'home' }, form: null,
    resJob: null, resSort: null, resDesc: false,
    explorerOpen: {}, explorerSel: null, consoleHistory: [],
    dockTab: 'log'
  };

  function defaults() {
    var docs = sh.SpecialFolders('MyDocuments') || (env('USERPROFILE') + '\\Documents');
    return { outputFolder: docs + '\\Watts365 Places Toolbox', showEngine: false, useConhost: true, disableWAM: false, dockHeight: 300, maxRows: 5000 };
  }
  function loadSettings() {
    var d = defaults(), s = {};
    try { s = JSON.parse(stripBom(readText(DATA + '\\settings.json') || '{}')); } catch (e) { s = {}; }
    for (var k in d) if (!(k in s)) s[k] = d[k];
    S.settings = s;
  }
  function saveSettings() { try { mkdirs(DATA); writeText(DATA + '\\settings.json', JSON.stringify(S.settings)); } catch (e) { } }

  /* ================= Engine ================= */

  // Double-clicking a .hta runs the 32-bit SysWOW64\mshta.exe, where System32 is redirected to SysWOW64
  // (which has no conhost.exe) and %ProgramFiles% is the x86 folder. Sysnative reaches the real System32.
  function sysExe(name) {
    var win = env('windir');
    return (fso.FolderExists(win + '\\Sysnative') ? win + '\\Sysnative\\' : win + '\\System32\\') + name;
  }

  function findPwsh() {
    var pf64 = env('ProgramW6432').indexOf('%') < 0 ? env('ProgramW6432') : env('ProgramFiles');
    var c = [pf64 + '\\PowerShell\\7\\pwsh.exe', pf64 + '\\PowerShell\\7-preview\\pwsh.exe', env('ProgramFiles') + '\\PowerShell\\7\\pwsh.exe', env('LOCALAPPDATA') + '\\Microsoft\\WindowsApps\\pwsh.exe'];
    var parts = env('PATH').split(';');
    for (var i = 0; i < parts.length; i++) if (trim(parts[i])) c.push(trim(parts[i]).replace(/\\$/, '') + '\\pwsh.exe');
    for (var j = 0; j < c.length; j++) { try { if (fso.FileExists(c[j])) return c[j]; } catch (e) { } }
    return null;
  }

  function cleanSessions() {
    try {
      var root = fso.GetFolder(DATA + '\\Sessions'), e = new Enumerator(root.SubFolders);
      for (; !e.atEnd(); e.moveNext()) { try { fso.DeleteFolder(e.item().Path, true); } catch (x) { } }
    } catch (x2) { }
  }

  function startEngine() {
    S.pwsh = findPwsh();
    if (!S.pwsh) { S.engine = { state: 'missing' }; renderChips(); renderDockStatus(); if (S.view.kind === 'home') renderView(); return; }
    mkdirs(DATA + '\\Sessions');
    cleanSessions();
    S.session = DATA + '\\Sessions\\' + stamp() + '-' + Math.floor(Math.random() * 9000 + 1000);
    mkdirs(S.session + '\\queue'); mkdirs(S.session + '\\out');
    touch(S.session + '\\ui.alive');
    var args = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + ROOT + '\\engine\\PlacesToolbox.Engine.ps1" -SessionPath "' + S.session + '" -ToolboxRoot "' + ROOT + '"';
    var direct = '"' + S.pwsh + '" ' + args, style = S.settings.showEngine ? 1 : 7, launched = false, err = '';
    S.engine = { state: 'starting', since: new Date().getTime() };
    if (S.settings.useConhost && fso.FileExists(sysExe('conhost.exe'))) {
      try { sh.Run('"' + sysExe('conhost.exe') + '" ' + direct, style, false); launched = true; }
      catch (e) { err = e.message; logLine('warn', 'Classic console launch failed (' + e.message + '), starting PowerShell directly.'); }
    }
    if (!launched) {
      try { sh.Run(direct, style, false); launched = true; }
      catch (e2) { err = e2.message; }
    }
    if (!launched) {
      S.engine = { state: 'failed', error: 'Could not start ' + S.pwsh + ': ' + err };
      logLine('err', S.engine.error);
      renderChips(); renderDockStatus(); if (S.view.kind === 'home') renderView();
      return;
    }
    logLine('sys', 'Starting PowerShell engine (' + S.pwsh + ')');
    renderChips(); renderDockStatus();
    var t = setInterval(function () {
      var info = readText(S.session + '\\engine.json'), j = null;
      if (info) { try { j = JSON.parse(stripBom(info)); } catch (e) { j = null; } }
      if (j) {
        clearInterval(t);
        S.engine = { state: 'ready', pid: j.pid, ps: j.psVersion };
        var v = String(j.psVersion).split('.');
        if (+v[0] < 7 || (+v[0] === 7 && +v[1] < 4)) logLine('warn', 'PowerShell ' + j.psVersion + ' detected. The MicrosoftPlaces module needs 7.4.0 or later.');
        logLine('ok', 'Engine ready · PowerShell ' + j.psVersion + ' · PID ' + j.pid);
        renderChips(); renderDockStatus();
        refreshStatus();
        if (S.view.kind === 'home') renderView();
      } else if (new Date().getTime() - S.engine.since > 45000) {
        clearInterval(t);
        S.engine = { state: 'failed', error: 'The engine did not start within 45 seconds.' };
        logLine('err', S.engine.error + ' Turn on "Show engine window" in Settings and restart to see why.');
        renderChips(); renderDockStatus();
        if (S.view.kind === 'home') renderView();
      }
    }, 400);
  }

  function killEngine() {
    if (S.session) touch(S.session + '\\stop');
    if (S.engine.pid) { try { sh.Run('"' + sysExe('taskkill.exe') + '" /PID ' + S.engine.pid + ' /T /F', 0, true); } catch (e) { } }
    for (var i = 0; i < S.jobs.length; i++) {
      var j = S.jobs[i];
      if (j.status === 'queued' || j.status === 'running') { j.status = 'error'; j.message = 'Engine restarted'; }
    }
    S.engine = { state: 'stopped' };
    S.status = null; S.index = null; S.devices = null;
  }

  function restartEngine() {
    confirmModal('Restart the PowerShell engine?', 'This stops anything running and signs you out of Places, Exchange and Graph. Use it if a command is stuck or after updating a module.', 'Restart', false, function () {
      killEngine(); logLine('warn', 'Engine stopped.'); renderHistory(); startEngine();
    });
  }

  function showEngineWindow() {
    if (!S.engine.pid) return;
    var ps = "Add-Type -Name W -Namespace T -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);'\n" +
      '$h = (Get-Process -Id ' + S.engine.pid + ').MainWindowHandle; [T.W]::ShowWindow($h, 9) | Out-Null; [T.W]::SetForegroundWindow($h) | Out-Null';
    try { sh.Run('"' + sysExe('WindowsPowerShell\\v1.0\\powershell.exe') + '" -NoProfile -WindowStyle Hidden -EncodedCommand ' + b64ps(ps), 0, false); } catch (e) { }
  }

  /* ================= Jobs ================= */

  function firstLine(s) { var l = String(s).split('\n'); return trim(l[l.length - 1]).substr(0, 90); }

  function submit(script, o) {
    o = o || {};
    if (S.engine.state !== 'ready') { toast('The PowerShell engine is not ready yet.'); return null; }
    var id = 'j' + pad(++S.seq, 6);
    var job = { id: id, label: o.label || firstLine(script), script: script, quiet: !!o.quiet, status: 'queued', offset: 0,
                queued: new Date(), onDone: o.onDone, after: o.after, results: null, count: 0, progress: null };
    try { mkdirs(S.settings.outputFolder); } catch (e) { }
    var q = S.session + '\\queue\\' + id;
    writeText(q + '.ps1', script);
    writeText(q + '.tmp', JSON.stringify({ label: job.label, quiet: job.quiet, maxRows: o.maxRows || S.settings.maxRows, outputFolder: S.settings.outputFolder }));
    fso.MoveFile(q + '.tmp', q + '.ready');
    S.jobs.push(job);
    if (!job.quiet) { setDockTab('log'); renderHistory(); }
    renderDockStatus();
    return job;
  }

  function currentJob() {
    for (var i = 0; i < S.jobs.length; i++) if (S.jobs[i].status === 'queued' || S.jobs[i].status === 'running') return S.jobs[i];
    return null;
  }

  function readLog(job, path, final) {
    var t = readText(path, job.offset);
    if (!t) return;
    var cut = final ? t.length : t.lastIndexOf('\n') + 1;
    if (cut <= 0) return;
    var chunk = t.substr(0, cut);
    job.offset += chunk.length;
    var lines = stripBom(chunk).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === '') continue;
      var bar = lines[i].indexOf('|');
      var lvl = bar > 0 ? lines[i].substr(0, bar) : 'host', txt = bar > 0 ? lines[i].substr(bar + 1) : lines[i];
      if (job.quiet && lvl !== 'err') continue;
      logLine(lvl, txt);
    }
  }

  function poll() {
    var job = currentJob();
    if (!job || S.engine.state !== 'ready') return;
    var out = S.session + '\\out\\' + job.id;
    if (fso.FileExists(out + '.log')) {
      if (job.status === 'queued') { job.status = 'running'; job.started = new Date(); renderHistory(); }
      readLog(job, out + '.log', false);
    }
    var pr = readText(out + '.progress');
    if (pr) { var p = stripBom(pr).split('|'); job.progress = { cur: +p[0], tot: +p[1], text: p.slice(2).join('|') }; }
    var dn = readText(out + '.done'), d = null;
    if (dn) { try { d = JSON.parse(stripBom(dn)); } catch (e) { d = null; } }
    if (d) { readLog(job, out + '.log', true); finishJob(job, d, out); }
    renderDockStatus();
  }

  function finishJob(job, d, out) {
    job.status = d.status; job.ms = d.ms; job.count = d.count; job.errors = d.errors; job.message = d.message;
    var rj = readText(out + '.json');
    if (rj) { try { job.results = JSON.parse(stripBom(rj)); if (!(job.results instanceof Array)) job.results = [job.results]; } catch (e) { job.results = null; } }
    var ext = ['.log', '.progress', '.json', '.done', '.cancel'];
    for (var i = 0; i < ext.length; i++) del(out + ext[i]);
    if (!job.quiet) {
      var words = { ok: 'Done', warn: 'Done with ' + d.errors + ' error(s)', error: 'Failed', cancelled: 'Cancelled' };
      logLine('done', (words[d.status] || d.status) + ' in ' + secs(d.ms) + (d.count ? ' · ' + d.count + ' result(s), see Results' : ''));
      if (job.results && job.results.length) showResults(job, d.status === 'ok');
      renderHistory();
    }
    if (job.onDone) { try { job.onDone(job); } catch (e) { } }
    if (job.after === 'status') refreshStatus();
    if (job.after === 'index' && S.index) loadIndex();
    renderDockStatus();
  }

  function cancelJob() {
    var j = currentJob();
    if (!j) return;
    if (j.status === 'queued') { del(S.session + '\\queue\\' + j.id + '.ready'); j.status = 'cancelled'; renderHistory(); renderDockStatus(); return; }
    touch(S.session + '\\out\\' + j.id + '.cancel');
    logLine('warn', 'Cancel requested. Recipes stop at the next row; a single cmdlet cannot be interrupted (use Restart engine if it is stuck).');
  }

  /* ================= Status, index, devices ================= */

  function refreshStatus() {
    if (S.statusPending) return;
    S.statusPending = true;
    var j = submit('Get-TbxStatus', { quiet: true, label: 'Status', onDone: function (job) {
      S.statusPending = false;
      if (job.results && job.results[0]) S.status = job.results[0];
      renderChips();
      if (S.view.kind === 'home' || S.view.kind === 'cmdlet' || S.view.kind === 'recipe') renderView(true);
    } });
    if (!j) S.statusPending = false;
  }

  function loadIndex(cb) {
    if (S.indexPending) return;
    S.indexPending = true;
    logLine('muted', 'Loading places for pickers and the explorer…');
    var j = submit('Get-TbxPlaceIndex', { quiet: true, label: 'Load places', maxRows: 500000, onDone: function (job) {
      S.indexPending = false;
      if (job.status === 'ok' || job.status === 'warn') {
        S.index = job.results || [];
        S.byId = {}; S.kids = {};
        for (var i = 0; i < S.index.length; i++) {
          var p = S.index[i];
          S.byId[p.PlaceId] = p;
          var k = p.ParentId || '';
          (S.kids[k] = S.kids[k] || []).push(p);
        }
        logLine('muted', 'Loaded ' + S.index.length + ' place(s).');
      } else logLine('err', 'Could not load places: ' + (job.message || 'see errors above') + '. Are you connected to Microsoft Places?');
      if (cb) cb();
      if (S.view.kind === 'explorer') renderView();
      if (S.picker) renderPickerList();
    } });
    if (!j) S.indexPending = false;
  }

  function pathOf(p) {
    var names = [], cur = p && S.byId[p.ParentId], n = 0;
    while (cur && n++ < 5) { names.unshift(cur.DisplayName); cur = S.byId[cur.ParentId]; }
    return names.join(' › ');
  }

  /* ================= Log & dock ================= */

  function logLine(level, text) {
    var log = $('log');
    if (!log) return;
    var pane = $('logPane'), atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 30;
    var div = document.createElement('div');
    div.className = 'l-' + level;
    div.innerText = (level === 'sys' ? clock(new Date()) + '  ' : '') + text;
    log.appendChild(div);
    while (log.childNodes.length > 5000) log.removeChild(log.firstChild);
    if (atEnd) pane.scrollTop = pane.scrollHeight;
  }

  function setDockTab(t) {
    S.dockTab = t;
    var tabs = document.querySelectorAll('.dTab');
    for (var i = 0; i < tabs.length; i++) tabs[i].className = 'dTab' + (tabs[i].getAttribute('data-tab') === t ? ' active' : '');
    $('logPane').className = 'dPane' + (t === 'log' ? '' : ' hidden');
    $('results').className = 'dPane' + (t === 'results' ? '' : ' hidden');
    $('history').className = 'dPane' + (t === 'history' ? '' : ' hidden');
  }

  function renderDockStatus() {
    var st = $('dockStatus'), bar = $('progress'), cancel = $('btnCancel'), hint = $('hint');
    var job = currentJob(), txt = '';
    if (S.engine.state === 'starting') txt = 'Starting PowerShell engine…';
    else if (S.engine.state === 'missing') txt = 'PowerShell 7 not found. See Home.';
    else if (S.engine.state === 'failed') txt = 'Engine failed to start. See Home.';
    else if (S.engine.state === 'stopped') txt = 'Engine stopped.';
    else if (job && !job.quiet) {
      var el = job.started ? Math.round((new Date() - job.started) / 1000) : 0;
      txt = (job.status === 'queued' ? 'Queued: ' : 'Running: ') + job.label + (job.started ? ' · ' + el + 's' : '');
      if (job.progress && job.progress.tot) txt += ' · ' + job.progress.cur + '/' + job.progress.tot + (job.progress.text ? ' ' + job.progress.text : '');
    } else if (job) txt = 'Working…';
    else txt = 'Ready · PowerShell ' + (S.engine.ps || '');
    st.innerText = txt;
    var pct = job && job.progress && job.progress.tot ? Math.min(100, Math.round(job.progress.cur * 100 / job.progress.tot)) : 0;
    bar.className = job && !job.quiet ? '' : 'hidden';
    bar.firstChild.style.width = (job && !job.progress ? 100 : pct) + '%';
    bar.firstChild.style.opacity = job && !job.progress ? '.35' : '1';
    cancel.className = 'dBtn stop' + (job && !job.quiet ? '' : ' hidden');
    var waiting = job && !job.quiet && job.started && (new Date() - job.started) > 15000 && !job.progress;
    hint.className = 'hint' + (waiting ? '' : ' hidden');
  }

  function renderHistory() {
    var h = [], any = false;
    for (var i = S.jobs.length - 1; i >= 0; i--) {
      var j = S.jobs[i];
      if (j.quiet) continue;
      any = true;
      h.push('<div class="hRow" data-act="historyOpen" data-id="' + j.id + '"><span class="when">' + clock(j.queued) + '</span><span class="lab">' + esc(j.label) +
        '</span><span class="st st-' + j.status + '">' + j.status + (j.count ? ' · ' + j.count : '') + '</span></div>');
    }
    $('history').innerHTML = any ? h.join('') : '<div class="muted" style="padding:14px">Nothing run yet this session.</div>';
  }

  /* ================= Results grid ================= */

  function flat(v) {
    if (v == null) return '';
    if (typeof v === 'object') { var s = JSON.stringify(v); return s.length > 400 ? s.substr(0, 400) + '…' : s; }
    return String(v);
  }

  function showResults(job, focus) {
    S.resJob = job; S.resSort = null; S.resDesc = false;
    $('resFilter').value = '';
    renderResults();
    if (focus !== false) setDockTab('results');
  }

  function resColumns(rows) {
    var cols = [], seen = {};
    for (var i = 0; i < rows.length && i < 300; i++) {
      var r = rows[i];
      if (r === null || typeof r !== 'object') { if (!seen.Value) { seen.Value = 1; cols.push('Value'); } continue; }
      for (var k in r) if (r.hasOwnProperty(k) && !seen[k]) { seen[k] = 1; cols.push(k); }
    }
    return cols;
  }

  function resRows() {
    var job = S.resJob, f = trim($('resFilter').value).toLowerCase();
    if (!job || !job.results) return { cols: [], rows: [] };
    var rows = [], cols = resColumns(job.results);
    for (var i = 0; i < job.results.length; i++) {
      var r = job.results[i], o = (r === null || typeof r !== 'object') ? { Value: r } : r, cells = [];
      for (var c = 0; c < cols.length; c++) cells.push(flat(o[cols[c]]));
      if (f && cells.join('\u0001').toLowerCase().indexOf(f) < 0) continue;
      rows.push(cells);
    }
    if (S.resSort !== null) {
      var si = S.resSort, dir = S.resDesc ? -1 : 1;
      rows.sort(function (a, b) {
        var x = a[si], y = b[si], nx = parseFloat(x), ny = parseFloat(y);
        if (!isNaN(nx) && !isNaN(ny) && String(nx) === x && String(ny) === y) return (nx - ny) * dir;
        return x.toLowerCase() < y.toLowerCase() ? -dir : x.toLowerCase() > y.toLowerCase() ? dir : 0;
      });
    }
    return { cols: cols, rows: rows };
  }

  function renderResults() {
    var job = S.resJob, holder = $('resTable');
    if (!job || !job.results || !job.results.length) {
      $('resInfo').innerText = '';
      holder.innerHTML = '<div class="muted" style="padding:14px">Commands that return objects show them here.</div>';
      return;
    }
    var d = resRows(), max = 1000, h = ['<table class="grid"><thead><tr>'];
    for (var c = 0; c < d.cols.length; c++) h.push('<th data-act="sort" data-col="' + c + '">' + esc(d.cols[c]) + (S.resSort === c ? (S.resDesc ? ' ▼' : ' ▲') : '') + '</th>');
    h.push('</tr></thead><tbody>');
    for (var i = 0; i < d.rows.length && i < max; i++) {
      h.push('<tr>');
      for (var k = 0; k < d.rows[i].length; k++) h.push('<td title="' + esc(d.rows[i][k]) + '">' + esc(d.rows[i][k]) + '</td>');
      h.push('</tr>');
    }
    h.push('</tbody></table>');
    holder.innerHTML = h.join('');
    var info = d.rows.length + ' row(s)' + (d.rows.length > max ? ', showing first ' + max : '') + ' · ' + job.label;
    if (job.count > job.results.length) info += ' · ' + job.count + ' returned, first ' + job.results.length + ' shown (Export CSV includes all)';
    $('resInfo').innerText = info;
  }

  function copyResults() {
    var d = resRows();
    if (!d.cols.length) return;
    var t = [d.cols.join('\t')];
    for (var i = 0; i < d.rows.length; i++) t.push(d.rows[i].join('\t').replace(/[\r\n]+/g, ' '));
    copyText(t.join('\r\n'));
  }

  function exportResults() {
    if (!S.resJob) return;
    submit('Export-TbxResults -JobId ' + psq(S.resJob.id), { label: 'Export results to CSV' });
  }

  /* ================= Header chips ================= */

  function chip(id, label, cls, title) {
    return '<button class="chip" data-act="chip" data-id="' + id + '" title="' + esc(title || '') + '"><span class="dot ' + cls + '"></span>' + esc(label) + '</button>';
  }

  function renderChips() {
    var e = S.engine.state, st = S.status || {};
    var engineCls = e === 'ready' ? 'on' : e === 'starting' ? 'busy' : 'bad';
    var h = chip('engine', 'Engine', engineCls, e === 'ready' ? 'PowerShell ' + S.engine.ps : e);
    h += chip('places', 'Places', st.Places ? 'on' : '', st.Places ? 'Connected to Microsoft Places' : 'Not connected: click to connect');
    h += chip('exchange', 'Exchange', st.Exchange ? 'on' : '', st.Exchange ? 'Connected as ' + st.ExchangeAccount : 'Not connected: click to connect');
    h += chip('graph', 'Graph', st.Graph ? 'on' : '', st.Graph ? 'Connected as ' + st.GraphAccount : 'Not connected: click to connect');
    $('chips').innerHTML = h;
  }

  function connect(what, scopes) {
    if (what === 'places') submit('Connect-TbxPlaces', { label: 'Connect to Microsoft Places', after: 'status' });
    if (what === 'exchange') submit('Connect-TbxExchange' + (S.settings.disableWAM ? ' -DisableWAM' : ''), { label: 'Connect to Exchange Online', after: 'status' });
    if (what === 'graph') {
      var sc = scopes || ['User.Read.All', 'Directory.Read.All', 'Organization.Read.All'];
      var q = []; for (var i = 0; i < sc.length; i++) q.push(psq(sc[i]));
      submit('Connect-TbxGraph -Scopes ' + q.join(', '), { label: 'Connect to Microsoft Graph', after: 'status' });
    }
  }

  /* ================= Navigation ================= */

  function renderNav() {
    var q = trim($('navSearch').value).toLowerCase(), h = [];
    function item(kind, id, html, text) {
      if (q && text.toLowerCase().indexOf(q) < 0) return '';
      var active = S.view.kind === kind && (S.view.id || '') === (id || '');
      return '<div class="navItem' + (active ? ' active' : '') + '" data-act="nav" data-kind="' + kind + '" data-id="' + esc(id || '') + '" title="' + esc(text) + '">' + html + '</div>';
    }
    function group(label, items) { var s = items.join(''); if (s) h.push('<div class="navGroup">' + esc(label) + '</div>' + s); }

    group('Toolbox', [item('home', '', 'Home', 'Home setup status'), item('explorer', '', 'Places explorer', 'Places explorer tree'), item('console', '', 'PowerShell console', 'PowerShell console')]);
    var groups = [], by = {}, i;
    for (i = 0; i < RECIPES.length; i++) { var r = RECIPES[i]; if (!by['r' + r.group]) { by['r' + r.group] = []; groups.push(['r', r.group]); } by['r' + r.group].push(item('recipe', r.id, esc(r.title), r.title + ' ' + r.synopsis + ' ' + (r.fn || ''))); }
    for (i = 0; i < groups.length; i++) group('Recipes · ' + groups[i][1], by['r' + groups[i][1]]);
    groups = [];
    for (i = 0; i < CMDLETS.length; i++) { var c = CMDLETS[i]; if (!by['c' + c.group]) { by['c' + c.group] = []; groups.push(['c', c.group]); } by['c' + c.group].push(item('cmdlet', c.id, '<span class="cm">' + esc(c.id) + '</span>' + (c.danger ? '<span class="warnTag">●</span>' : ''), c.id + ' ' + c.synopsis)); }
    for (i = 0; i < groups.length; i++) group('Cmdlets · ' + groups[i][1], by['c' + groups[i][1]]);
    $('navList').innerHTML = h.join('') || '<div class="muted small" style="padding:14px 18px">No matches.</div>';
  }

  function go(kind, id, prefill) {
    S.view = { kind: kind, id: id };
    S.form = null;
    if (kind === 'cmdlet' || kind === 'recipe') {
      var def = find(kind === 'cmdlet' ? CMDLETS : RECIPES, 'id', id);
      if (!def) return go('home');
      var values = {}, p;
      for (var i = 0; i < def.params.length; i++) { p = def.params[i]; if (p.def != null) values[p.n] = p.t === 'switch' ? (p.def ? 'true' : '') : String(p.def); }
      if (prefill && prefill.values) for (var k in prefill.values) values[k] = prefill.values[k];
      S.form = { def: def, kind: kind, set: (prefill && prefill.set) || (def.sets ? def.sets[0] : null), values: values, labels: (prefill && prefill.labels) || {} };
    }
    renderNav();
    renderView();
    $('view').scrollTop = 0;
  }

  /* ================= Views ================= */

  function renderView(soft) {
    var v = S.view, html = '';
    if (soft && S.form) { renderNotices(); return; }
    if (v.kind === 'home') html = homeHtml();
    else if (v.kind === 'cmdlet' || v.kind === 'recipe') html = formPageHtml();
    else if (v.kind === 'console') html = consoleHtml();
    else if (v.kind === 'explorer') html = explorerHtml();
    $('view').innerHTML = html;
    if (S.form) { renderNotices(); syncShow(); regenerate(); }
    if (v.kind === 'console') { var ci = $('consoleIn'); if (ci) ci.focus(); }
  }

  /* ---------- Home ---------- */

  function homeHtml() {
    var e = S.engine, st = S.status || {}, mods = st.Modules || {}, h = [];
    h.push('<div class="eyebrow">Places Toolbox · v' + VERSION + '</div><h1>Microsoft Places, without the typing.</h1>');
    h.push('<p class="lead">Every Microsoft Places PowerShell cmdlet as a form, plus recipes for the bulk jobs: whole sites from CSV, desk modes, reports, maps and calendar policy. Every command is previewed before it runs, so you can see (and copy) exactly what it does.</p>');

    if (e.state === 'missing') {
      h.push('<div class="note danger"><b>PowerShell 7 was not found.</b> The MicrosoftPlaces module needs PowerShell 7.4 or later. Install it, then choose Retry.<br>' +
        '<code>winget install --id Microsoft.PowerShell --source winget</code> &nbsp; <a data-act="url" data-url="https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows">Install guide</a>' +
        '<div style="margin-top:8px"><button class="btn" data-act="retryEngine">Retry</button></div></div>');
    }

    if (e.state === 'failed') {
      h.push('<div class="note danger"><b>The PowerShell engine did not start.</b> ' + esc(e.error || '') +
        '<br>Tick "Start the engine window visible" in Settings below, then Restart, to see any PowerShell error.' +
        '<div style="margin-top:8px"><button class="btn" data-act="retryEngine">Try again</button></div></div>');
    }

    h.push('<div class="cards">');
    // Setup
    h.push('<div class="card"><h3>Setup</h3><ul class="check-list">');
    var psOk = e.state === 'ready';
    h.push('<li><span class="nm">PowerShell 7 engine</span><span class="st ' + (psOk ? 'ok' : 'bad') + '">' + (psOk ? e.ps : e.state) + '</span>' +
      (psOk ? '<button class="btn small ghost" data-act="engineWindow">Show window</button>' : '') + '<button class="btn small ghost" data-act="restartEngine">Restart</button></li>');
    for (var i = 0; i < MODULES.length; i++) {
      var m = MODULES[i], ver = mods[m.n];
      h.push('<li><span class="nm"><span class="mono small">' + esc(m.n) + '</span><br><span class="muted small">' + esc(m.why) + '</span></span><span class="st ' + (ver ? 'ok' : (m.need ? 'bad' : '')) + '">' +
        (S.status ? (ver || 'not installed') : '…') + '</span><button class="btn small ' + (ver ? 'ghost' : '') + '" data-act="install" data-mod="' + m.n + '"' + (psOk ? '' : ' disabled') + '>' + (ver ? 'Update' : 'Install') + '</button></li>');
    }
    h.push('</ul></div>');

    // Connections
    h.push('<div class="card"><h3>Connections</h3><ul class="check-list">');
    var conns = [['places', 'Microsoft Places', st.Places, 'All Places cmdlets and most recipes'], ['exchange', 'Exchange Online', st.Exchange, st.ExchangeAccount || 'Calendar processing and room lists'], ['graph', 'Microsoft Graph', st.Graph, st.GraphAccount || 'Licence check and service plans']];
    for (var c = 0; c < conns.length; c++) {
      h.push('<li><span class="nm">' + conns[c][1] + '<br><span class="muted small">' + esc(conns[c][3]) + '</span></span><span class="st ' + (conns[c][2] ? 'ok' : '') + '">' + (conns[c][2] ? 'connected' : 'not connected') + '</span>' +
        '<button class="btn small' + (conns[c][2] ? ' ghost' : '') + '" data-act="connect" data-what="' + conns[c][0] + '"' + (psOk ? '' : ' disabled') + '>' + (conns[c][2] ? 'Reconnect' : 'Connect') + '</button></li>');
    }
    h.push('</ul><div style="margin-top:10px"><button class="btn small ghost" data-act="refreshStatus"' + (psOk ? '' : ' disabled') + '>Refresh status</button>' +
      (st.Places ? '<button class="btn small ghost" data-act="disconnectPlaces">Disconnect Places</button>' : '') + '</div>');
    h.push('<p class="muted small">Sign-in opens in your browser (Places and Graph) or a Microsoft sign-in window (Exchange). If nothing appears, choose Show window on the engine.</p></div>');

    // Settings
    var s = S.settings;
    h.push('<div class="card"><h3>Settings</h3>');
    h.push('<div class="small muted">Output folder (reports, exports, templates and logs)</div><div class="inRow" style="margin:4px 0 10px"><input class="in" id="setOut" value="' + esc(s.outputFolder) + '"><button class="btn small ghost" data-act="browseOut">Browse</button><button class="btn small ghost" data-act="openOut">Open</button></div>');
    h.push('<label class="check"><input type="checkbox" data-set="showEngine"' + (s.showEngine ? ' checked' : '') + '>Start the engine window visible (applies on restart)</label><br>');
    h.push('<label class="check"><input type="checkbox" data-set="useConhost"' + (s.useConhost ? ' checked' : '') + '>Host the engine in a classic console, not Windows Terminal</label><br>');
    h.push('<label class="check"><input type="checkbox" data-set="disableWAM"' + (s.disableWAM ? ' checked' : '') + '>Exchange: sign in through the browser (-DisableWAM)</label>');
    h.push('<p class="muted small">Session log: <a data-act="openLogs">' + esc(s.outputFolder) + '\\Logs</a></p></div>');
    h.push('</div>');

    // Quick tiles
    h.push('<h2>Jump in</h2><div class="tiles">');
    var tiles = [['recipe', 'deskreport', 'Desk status report', 'Every desk, its location and mode, as CSV and HTML.'],
                 ['recipe', 'hierarchy', 'Build a site from CSV', 'Buildings, floors, sections, rooms and desks in one go.'],
                 ['cmdlet', 'New-Place', 'New-Place', 'Create a single building, floor, section, room or desk.'],
                 ['explorer', '', 'Places explorer', 'Browse your hierarchy and act on any place.'],
                 ['cmdlet', 'Initialize-Places', 'Initialize-Places', 'Let Places infer buildings from your room lists.'],
                 ['console', '', 'PowerShell console', 'Run anything in the connected session.']];
    for (var t = 0; t < tiles.length; t++) h.push('<div class="tile" data-act="nav" data-kind="' + tiles[t][0] + '" data-id="' + tiles[t][1] + '"><div class="t">' + tiles[t][2] + '</div><div class="d">' + tiles[t][3] + '</div></div>');
    h.push('</div>');

    h.push('<p class="muted small" style="margin-top:26px">An independent community tool from <a data-act="url" data-url="https://watts365.com">watts365.com</a>. It is not made, endorsed or supported by Microsoft. Views are my own. ' +
      'Cmdlet reference: <a data-act="url" data-url="' + DOCS + 'get-placev3">Microsoft Places PowerShell on Microsoft Learn</a>.</p>');
    return h.join('');
  }

  /* ---------- Cmdlet / recipe form ---------- */

  var TYPE_LABEL = { str: 'String', int: 'Int32', bool: 'Boolean', 'switch': 'Switch', 'enum': 'String', file: 'Path', folder: 'Folder', place: 'Place', device: 'Device Id', mode: 'Mode', list: 'String[]', lines: 'String[]', links: 'ResourceLink[]', sensors: 'Sensor[]', scope: 'Scope string', date: 'yyyy-MM-dd' };

  function visibleParams(f) {
    var out = [];
    for (var i = 0; i < f.def.params.length; i++) {
      var p = f.def.params[i];
      if (p.sets && f.set && p.sets.indexOf(f.set) < 0) continue;
      out.push(p);
    }
    return out;
  }

  function formPageHtml() {
    var f = S.form, d = f.def, h = [];
    var isCmd = f.kind === 'cmdlet';
    h.push('<div class="pageHead"><div class="grow"><div class="eyebrow">' + (isCmd ? 'Cmdlet · ' : 'Recipe · ') + esc(d.group) + '</div>');
    h.push(isCmd ? '<h1 class="cmd">' + esc(d.id) + '</h1>' : '<h1>' + esc(d.title) + '</h1>');
    h.push('<p class="lead">' + esc(d.synopsis) + '</p></div><div class="actions">');
    if (isCmd) h.push('<button class="btn small ghost" data-act="url" data-url="' + DOCS + d.id.toLowerCase() + '">Docs</button>');
    if (d.template) h.push('<button class="btn small ghost" data-act="template" data-file="' + d.template + '">Open CSV template</button>');
    h.push('</div></div>');
    h.push('<div id="notices"></div>');
    if (d.columns) h.push('<div class="note"><b>CSV columns:</b> <span class="mono small">' + esc(d.columns) + '</span></div>');
    if (d.notes) for (var n = 0; n < d.notes.length; n++) h.push('<div class="note">' + esc(d.notes[n]) + '</div>');
    if (d.danger) h.push('<div class="note danger"><b>Careful:</b> ' + esc(d.danger) + '</div>');
    if (d.dry) h.push('<div class="note warn">' + DRY + '</div>');

    if (d.external) {
      h.push('<div class="card" style="max-width:920px"><h3>Run Initialize-Places</h3><p class="muted small">Opens PowerShell 7, imports the module, signs you in and starts the menu, working in <span class="mono">' + esc(S.settings.outputFolder) + '</span>.</p>' +
        '<button class="btn" data-act="initPlaces">Open Initialize-Places window</button><button class="btn ghost" data-act="openOut">Open output folder</button></div>');
      return h.join('');
    }

    if (d.sets) {
      h.push('<div class="setTabs"><span class="lbl">' + (d.setParam === 'Kind' ? 'Place type' : '-' + d.setParam) + '</span>');
      for (var s = 0; s < d.sets.length; s++) h.push('<span class="setTab' + (d.sets[s] === f.set ? ' active' : '') + '" data-act="set" data-set="' + d.sets[s] + '">' + d.sets[s] + '</span>');
      h.push('</div>');
    }
    h.push('<div class="form" id="form">');
    var ps = visibleParams(f);
    if (!ps.length && !d.raw) h.push('<p class="muted">No parameters.</p>');
    for (var i = 0; i < ps.length; i++) h.push(fieldHtml(ps[i], f));
    h.push('</div>');

    h.push('<div class="preview"><div class="head"><div class="eyebrow">Command preview · editable</div><button class="linkBtn" data-act="copyCmd">Copy</button><button class="linkBtn" data-act="resetCmd">Reset</button></div>' +
      '<textarea id="cmdText" spellcheck="false"></textarea>' +
      '<div class="runBar">' + (d.dry ? '<button class="btn ghost" data-act="run" data-dry="1">Dry run</button>' : '') +
      '<button class="btn' + (d.danger ? ' danger' : '') + '" data-act="run">Run</button><span class="msg" id="formMsg"></span></div></div>');
    return h.join('');
  }

  function renderNotices() {
    var n = $('notices');
    if (!n || !S.form) return;
    var d = S.form.def, st = S.status, h = [];
    var need = d.requires || (S.form.kind === 'cmdlet' && d.id !== 'Connect-MicrosoftPlaces' && d.id !== 'Disconnect-MicrosoftPlaces' && !d.external ? 'places' : null);
    if (S.engine.state !== 'ready') h.push('<div class="note warn">The PowerShell engine is not running. See Home.</div>');
    else if (st && need === 'places' && !st.Places) h.push('<div class="note warn">Not connected to Microsoft Places. <a data-act="connect" data-what="places">Connect now</a></div>');
    else if (st && need === 'exchange' && !st.Exchange) h.push('<div class="note warn">This recipe needs Exchange Online. <a data-act="connect" data-what="exchange">Connect to Exchange</a></div>');
    else if (st && need === 'graph' && (!st.Graph || (d.graphScopes && !hasScopes(st.GraphScopes, d.graphScopes))))
      h.push('<div class="note warn">This recipe needs Microsoft Graph' + (d.graphScopes ? ' with ' + d.graphScopes.join(', ') : '') + '. <a data-act="connect" data-what="graph"' + (d.graphScopes ? ' data-scopes="' + d.graphScopes.join(',') + '"' : '') + '>Connect to Graph</a></div>');
    n.innerHTML = h.join('');
  }

  function hasScopes(have, want) {
    have = ' ' + (have || '').toLowerCase() + ' ';
    for (var i = 0; i < want.length; i++) if (have.indexOf(' ' + want[i].toLowerCase() + ' ') < 0) return false;
    return true;
  }

  function sub(p, f, k) { var v = f.values[p.n]; return v && typeof v === 'object' ? (v[k] || '') : ''; }

  function fieldHtml(p, f) {
    var v = f.values[p.n], sv = typeof v === 'string' ? v : '', a = ' data-p="' + p.n + '"', ctl = '', i;
    var ph = p.ph ? ' placeholder="' + esc(p.ph) + '"' : '';
    switch (p.t) {
      case 'str': case 'int': case 'list':
        ctl = '<input class="in"' + a + ' value="' + esc(sv) + '"' + ph + '>'; break;
      case 'date':
        ctl = '<input class="in"' + a + ' value="' + esc(sv) + '" placeholder="yyyy-MM-dd" style="width:180px">'; break;
      case 'enum':
        ctl = '<select class="in"' + a + ' style="width:auto;min-width:220px"><option value="">' + (p.req ? 'Choose…' : '(not set)') + '</option>';
        for (i = 0; i < p.v.length; i++) ctl += '<option' + (sv === p.v[i] ? ' selected' : '') + '>' + esc(p.v[i]) + '</option>';
        ctl += '</select>'; break;
      case 'bool':
        ctl = '<select class="in"' + a + ' style="width:auto;min-width:160px"><option value="">(not set)</option><option' + (sv === '$true' ? ' selected' : '') + '>$true</option><option' + (sv === '$false' ? ' selected' : '') + '>$false</option></select>'; break;
      case 'switch':
        ctl = '<label class="check"><input type="checkbox"' + a + (sv ? ' checked' : '') + '>Include -' + esc(p.n) + '</label>'; break;
      case 'file':
        ctl = '<div class="inRow"><input class="in"' + a + ' value="' + esc(sv) + '" placeholder="Full path to the .' + (p.ext || '*') + ' file"><button class="btn small ghost" data-act="browseFile" data-for="' + p.n + '" data-ext="' + (p.ext || '') + '">Browse</button></div>'; break;
      case 'folder':
        ctl = '<div class="inRow"><input class="in"' + a + ' value="' + esc(sv) + '" placeholder="Folder path"><button class="btn small ghost" data-act="browseFolder" data-for="' + p.n + '">Browse</button></div>'; break;
      case 'place':
        ctl = '<div class="inRow"><input class="in"' + a + ' value="' + esc(sv) + '" placeholder="PlaceId, name or email"><button class="btn small ghost" data-act="pick" data-for="' + p.n + '">Pick…</button></div>' +
          '<div class="placeName" id="pn_' + p.n + '">' + esc(f.labels[p.n] || '') + '</div>'; break;
      case 'device':
        ctl = '<div class="inRow"><input class="in"' + a + ' value="' + esc(sv) + '" placeholder="Device GUID"><button class="btn small ghost" data-act="pickDevice" data-for="' + p.n + '">Pick…</button>' +
          (f.def.prefill === 'device' ? '<button class="btn small ghost" data-act="prefillDevice">Load current values</button>' : '') + '</div>'; break;
      case 'lines': case 'links': case 'sensors':
        var tph = p.t === 'links' ? 'Intranet | https://intranet.contoso.com | Url' : p.t === 'sensors' ? 'badge\noccupancy, sensor-02' : (p.ph || '');
        ctl = '<textarea class="in" rows="4"' + a + ' placeholder="' + esc(tph) + '">' + esc(sv) + '</textarea>';
        if (p.t === 'sensors') p.help = p.help || 'One sensor per line: type (badge or occupancy), then an optional SensorId after a comma.';
        break;
      case 'mode':
        var nm = sub(p, f, 'Name'), opts = f.set === 'Workspace' ? ['Reservable', 'DropIn', 'Unavailable'] : ['Reservable', 'DropIn', 'Assigned', 'Unavailable'];
        ctl = '<select class="in"' + a + ' data-k="Name" style="width:auto;min-width:200px"><option value="">(not set)</option>';
        for (i = 0; i < opts.length; i++) ctl += '<option' + (nm === opts[i] ? ' selected' : '') + '>' + opts[i] + '</option>';
        ctl += '</select><div class="sub">' +
          '<div data-show="' + p.n + '.Name=Unavailable"><label>Reason</label><select class="in"' + a + ' data-k="Reason"><option' + (sub(p, f, 'Reason') === 'Maintenance' ? '' : ' selected') + '>New</option><option' + (sub(p, f, 'Reason') === 'Maintenance' ? ' selected' : '') + '>Maintenance</option></select></div>' +
          '<div data-show="' + p.n + '.Name=Assigned"><label>AssignedPersonEmailAddress</label><input class="in"' + a + ' data-k="Email" value="' + esc(sub(p, f, 'Email')) + '" placeholder="alex@contoso.com"></div>' +
          '<div data-show="' + p.n + '.Name=Assigned"><label>or AssignedPersonId</label><input class="in"' + a + ' data-k="PersonId" value="' + esc(sub(p, f, 'PersonId')) + '" placeholder="Entra object ID"></div></div>';
        p.help = 'Reservable and DropIn create or link a mailbox. Assigned needs a person. Unavailable takes a reason (New or Maintenance). Leave unset to keep the default.';
        break;
      case 'scope':
        var dv = sub(p, f, 'Default');
        ctl = '<select class="in"' + a + ' data-k="Default" style="width:auto;min-width:200px"><option value="">(leave unchanged)</option><option value="true"' + (dv === 'true' ? ' selected' : '') + '>Default: on</option><option value="false"' + (dv === 'false' ? ' selected' : '') + '>Default: off</option></select>';
        if (p.oid) ctl += '<div class="sub"><div><label>Group exceptions: one per line, &lt;group OID&gt;@&lt;tenant ID&gt;:true|false</label><textarea class="in" rows="3"' + a + ' data-k="Oids" placeholder="53612aff-a481-41c1-970b-2ca512e6ae53@00000000-0000-0000-0000-000000000000:true">' + esc(sub(p, f, 'Oids')) + '</textarea></div></div>';
        p.help = p.help || SCOPE_HELP;
        break;
    }
    return '<div class="field"><div class="fl"><span class="pn">-' + esc(p.n) + '</span>' + (p.req ? '<span class="req">*</span>' : '') +
      '<span class="ty">' + TYPE_LABEL[p.t] + '</span></div><div class="fc">' + ctl + (p.help ? '<div class="help">' + esc(p.help) + '</div>' : '') + '</div></div>';
  }

  function collect() {
    var f = S.form, form = $('form');
    if (!f || !form) return;
    var els = form.querySelectorAll('[data-p]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], p = el.getAttribute('data-p'), k = el.getAttribute('data-k');
      var val = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value;
      if (k) { if (!f.values[p] || typeof f.values[p] !== 'object') f.values[p] = {}; f.values[p][k] = val; }
      else f.values[p] = val;
    }
  }

  function syncShow() {
    var f = S.form, els = document.querySelectorAll('[data-show]');
    for (var i = 0; i < els.length; i++) {
      var rule = els[i].getAttribute('data-show').split('='), path = rule[0].split('.'), want = rule[1].split(',');
      var v = f.values[path[0]], cur = v && typeof v === 'object' ? v[path[1]] : v;
      els[i].className = want.indexOf(cur || '') >= 0 ? '' : 'hidden';
    }
  }

  function splitLines(s) { var out = [], l = String(s || '').split(/\r?\n/); for (var i = 0; i < l.length; i++) if (trim(l[i])) out.push(trim(l[i])); return out; }

  // Returns the argument text for one parameter, null to omit, or throws a message
  function argFor(p, v, pre, set) {
    var s = typeof v === 'string' ? trim(v) : '', i, parts, out;
    switch (p.t) {
      case 'switch': return v ? true : null;
      case 'int': if (!s) return null; if (!/^-?\d+$/.test(s)) throw '-' + p.n + ' must be a whole number.'; return s;
      case 'bool': return s || null;
      case 'date': if (!s) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw '-' + p.n + ' must be yyyy-MM-dd.'; return psq(s);
      case 'list':
        if (!s) return null;
        parts = s.split(','); out = [];
        for (i = 0; i < parts.length; i++) if (trim(parts[i])) out.push(psq(trim(parts[i])));
        return out.join(', ');
      case 'lines':
        parts = splitLines(v); if (!parts.length) return null;
        out = []; for (i = 0; i < parts.length; i++) out.push(psq(parts[i]));
        return '@(' + out.join(', ') + ')';
      case 'links':
        parts = splitLines(v); if (!parts.length) return null;
        out = [];
        for (i = 0; i < parts.length; i++) {
          var b = parts[i].split('|');
          if (b.length < 2) throw 'ResourceLinks line ' + (i + 1) + ' needs at least "name | value".';
          out.push('@{name=' + psq(trim(b[0])) + '; value=' + psq(trim(b[1])) + '; type=' + psq(trim(b[2] || 'Url')) + '}');
        }
        return '@(' + out.join(', ') + ')';
      case 'sensors':
        parts = splitLines(v); if (!parts.length) return null;
        out = [];
        for (i = 0; i < parts.length; i++) {
          var sp = parts[i].split(','), ty = trim(sp[0]).toLowerCase();
          if (ty !== 'badge' && ty !== 'occupancy') throw 'Sensor line ' + (i + 1) + ': type must be badge or occupancy.';
          out.push('(New-Object MicrosoftPlaces.PlacesDevices.Sensor -Property @{SensorType=' + psq(ty) + (trim(sp[1]) ? '; SensorId=' + psq(trim(sp[1])) : '') + '})');
        }
        return '@(' + out.join(', ') + ')';
      case 'mode':
        var m = v && typeof v === 'object' ? v : {};
        if (!m.Name) return null;
        if (m.Name === 'Reservable' || m.Name === 'DropIn') return "@{Name='" + m.Name + "'}";
        pre.push("$mode = @{ Name = '" + m.Name + "'; Metadata = [System.Collections.Generic.Dictionary[string,object]]::new() }");
        if (m.Name === 'Unavailable') pre.push("$mode.Metadata.Add('Reason', " + psq(m.Reason || 'New') + ')');
        if (m.Name === 'Assigned') {
          if (trim(m.Email)) pre.push("$mode.Metadata.Add('AssignedPersonEmailAddress', " + psq(trim(m.Email)) + ')');
          else if (trim(m.PersonId)) pre.push("$mode.Metadata.Add('AssignedPersonId', " + psq(trim(m.PersonId)) + ')');
          else throw 'An Assigned desk needs an AssignedPersonEmailAddress or AssignedPersonId.';
        }
        return '$mode';
      case 'scope':
        var sc = v && typeof v === 'object' ? v : {};
        var oids = splitLines(sc.Oids);
        if (!sc.Default && !oids.length) return null;
        if (!sc.Default) throw '-' + p.n + ': choose a default (on or off) when adding group exceptions.';
        var str = 'Default:' + sc.Default;
        if (oids.length > 20) throw '-' + p.n + ': a maximum of 20 OIDs is supported.';
        for (i = 0; i < oids.length; i++) {
          if (!/^[^@\s]+@[^:\s]+:(true|false)$/i.test(oids[i])) throw '-' + p.n + ' line ' + (i + 1) + ' should look like <OID>@<TenantID>:true';
          str += ',OID:' + oids[i].replace(/^OID:/i, '');
        }
        return psq(str);
      default:
        return s ? psq(s) : null;
    }
  }

  function isEmpty(p, v) {
    if (v == null || v === '') return true;
    if (typeof v === 'object') { for (var k in v) if (trim(v[k])) return false; return true; }
    return !trim(v);
  }

  function buildCommand() {
    var f = S.form, d = f.def;
    if (d.raw) return { text: d.build(f) };
    var pre = [], args = [], ps = visibleParams(f);
    if (d.setParam && d.setEmit !== false) args.push('-' + d.setParam + ' ' + f.set);
    try {
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i], v = f.values[p.n];
        if (p.req && isEmpty(p, v)) throw '-' + p.n + ' is required.';
        var a = argFor(p, v, pre, f.set);
        if (a === null) continue;
        args.push('-' + (p.emit || p.n) + (a === true ? '' : ' ' + a));
      }
      if (d.validate) {
        var simple = {};
        for (var j = 0; j < ps.length; j++) simple[ps[j].n] = isEmpty(ps[j], f.values[ps[j].n]) ? '' : 'x';
        var msg = d.validate(simple);
        if (msg) throw msg;
      }
    } catch (e) {
      return { text: (pre.length ? pre.join('\n') + '\n' : '') + (d.fn || d.id) + (args.length ? ' ' + args.join(' ') : ''), error: typeof e === 'string' ? e : e.message };
    }
    return { text: (pre.length ? pre.join('\n') + '\n' : '') + (d.fn || d.id) + (args.length ? ' ' + args.join(' ') : '') };
  }

  function regenerate() {
    var r = buildCommand(), t = $('cmdText');
    if (!t) return;
    t.value = r.text;
    $('formMsg').innerText = r.error || '';
    S.form.error = r.error;
  }

  function runForm(dry) {
    var f = S.form;
    collect();
    var r = buildCommand();
    if (r.error) { $('formMsg').innerText = r.error; return; }
    var text = trim($('cmdText').value);
    if (!text) return;
    if (dry) text += ' -DryRun';
    var label = (f.kind === 'cmdlet' ? f.def.id : f.def.title) + (dry ? ' (dry run)' : '');
    var exec = function () { submit(text, { label: label, after: dry ? null : f.def.after }); };
    if (f.def.danger && !dry) confirmModal('Run ' + (f.kind === 'cmdlet' ? f.def.id : f.def.title) + '?', f.def.danger, 'Run', true, exec, text);
    else exec();
  }

  /* ---------- Pickers ---------- */

  function chooseValue(p, mode) {
    if (mode === 'email') return p.Email || p.PlaceId;
    if (mode === 'auto') return (p.Type === 'Room' || p.Type === 'Space') && p.Email ? p.Email : p.PlaceId;
    return p.PlaceId;
  }

  function openPicker(paramName) {
    var f = S.form, p = find(f.def.params, 'n', paramName);
    var types = p.pick.types || (p.pick.bySet && p.pick.bySet[f.set]) || [];
    S.picker = { kind: 'place', param: p, types: types, filter: '' };
    showModal('Pick ' + (types.join(' or ') || 'a place').toLowerCase(),
      '<input class="in" id="pickSearch" placeholder="Search by name, email or path"><div id="pickList" style="margin-top:8px"></div>',
      [{ label: 'Reload places', cls: 'ghost', act: 'pickReload' }, { label: 'Close', cls: 'ghost', act: 'closeModal' }]);
    renderPickerList();
    $('pickSearch').focus();
  }

  function openDevicePicker(paramName) {
    S.picker = { kind: 'device', param: { n: paramName }, filter: '' };
    showModal('Pick a place device', '<input class="in" id="pickSearch" placeholder="Search devices"><div id="pickList" style="margin-top:8px"></div>',
      [{ label: 'Reload devices', cls: 'ghost', act: 'pickReload' }, { label: 'Close', cls: 'ghost', act: 'closeModal' }]);
    if (!S.devices) loadDevices(); else renderPickerList();
  }

  function loadDevices() {
    $('pickList').innerHTML = '<p class="muted">Loading devices…</p>';
    submit('Get-PlaceDevice -Top 1000', { quiet: true, label: 'Load devices', onDone: function (job) {
      S.devices = job.results || [];
      if (S.picker) renderPickerList();
    } });
  }

  function renderPickerList() {
    var pk = S.picker, list = $('pickList');
    if (!pk || !list) return;
    var q = trim($('pickSearch').value).toLowerCase(), h = [], n = 0, total = 0, i;
    if (pk.kind === 'device') {
      if (!S.devices) { list.innerHTML = '<p class="muted">Loading devices…</p>'; return; }
      for (i = 0; i < S.devices.length; i++) {
        var dv = S.devices[i], id = getCI(dv, 'Id'), txt = [getCI(dv, 'DisplayName'), getCI(dv, 'DeviceId'), getCI(dv, 'Manufacturer'), id].join(' ');
        if (q && txt.toLowerCase().indexOf(q) < 0) continue;
        h.push('<div class="pickRow" data-act="pickDev" data-val="' + esc(id) + '"><span class="ty">' + esc(getCI(dv, 'Manufacturer')) + '</span>' + esc(getCI(dv, 'DisplayName') || getCI(dv, 'DeviceId')) +
          '<div class="p mono">' + esc(getCI(dv, 'DeviceId')) + ' · ' + esc(id) + '</div></div>');
      }
      list.innerHTML = h.join('') || '<p class="muted">No devices found.</p>';
      return;
    }
    if (!S.index) {
      list.innerHTML = S.indexPending ? '<p class="muted">Loading places…</p>' :
        '<p class="muted">Places have not been loaded yet. This needs a Microsoft Places connection.</p><button class="btn" data-act="pickReload">Load places</button>';
      return;
    }
    var rows = [];
    for (i = 0; i < S.index.length; i++) {
      var p = S.index[i];
      if (pk.types.length && pk.types.indexOf(p.Type) < 0) continue;
      var path = pathOf(p);
      if (q && (p.DisplayName + ' ' + (p.Email || '') + ' ' + path + ' ' + p.PlaceId).toLowerCase().indexOf(q) < 0) continue;
      rows.push([path + ' › ' + p.DisplayName, p, path]);
    }
    rows.sort(function (a, b) { return a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1; });
    total = rows.length;
    for (i = 0; i < rows.length && n < 400; i++, n++) {
      var r = rows[i][1];
      h.push('<div class="pickRow" data-act="pickPlace" data-id="' + esc(r.PlaceId) + '"><span class="ty">' + esc(r.Type) + '</span>' + esc(r.DisplayName) +
        '<div class="p">' + esc(rows[i][2] || '(top level)') + (r.Email ? ' · ' + esc(r.Email) : '') + '</div></div>');
    }
    if (total > n) h.push('<p class="muted small">Showing ' + n + ' of ' + total + '. Search to narrow it down.</p>');
    list.innerHTML = h.join('') || '<p class="muted">No matching places.</p>';
  }

  function pickPlace(id) {
    var pk = S.picker, p = S.byId[id], f = S.form;
    if (!p || !f) return;
    var val = chooseValue(p, pk.param.pick.value);
    var input = document.querySelector('#form [data-p="' + pk.param.n + '"]');
    if (input) input.value = val;
    f.labels[pk.param.n] = (pathOf(p) ? pathOf(p) + ' › ' : '') + p.DisplayName + ' (' + p.Type + ')';
    var lab = $('pn_' + pk.param.n); if (lab) lab.innerText = f.labels[pk.param.n];
    closeModal(); collect(); regenerate();
  }

  function prefillDevice() {
    collect();
    var id = trim(S.form.values.Id);
    if (!id) { $('formMsg').innerText = 'Pick a device first.'; return; }
    submit('Get-PlaceDevice -Id ' + psq(id), { quiet: true, label: 'Load device', onDone: function (job) {
      var d = job.results && job.results[0];
      if (!d) { logLine('err', 'Device ' + id + ' not found.'); return; }
      var f = S.form, keys = ['DeviceId', 'DisplayName', 'Description', 'MACAddress', 'Manufacturer', 'IPV4Address', 'IPV6Address', 'PlaceId', 'Tags'];
      for (var i = 0; i < keys.length; i++) {
        var v = getCI(d, keys[i]);
        if (v != null) f.values[keys[i]] = v instanceof Array ? v.join(', ') : String(v);
      }
      var sensors = getCI(d, 'Sensors'), lines = [];
      if (sensors) for (var s = 0; s < sensors.length; s++) lines.push(String(getCI(sensors[s], 'SensorType') || '').toLowerCase() + (getCI(sensors[s], 'SensorId') ? ', ' + getCI(sensors[s], 'SensorId') : ''));
      f.values.Sensors = lines.join('\n');
      renderView();
      toast('Loaded current device values');
    } });
  }

  /* ---------- File & folder browsing ---------- */

  function browseFile(forName, ext) {
    var holder = $('fileHolder');
    holder.innerHTML = '<input type="file" id="filePick"' + (ext ? ' accept=".' + ext + '"' : '') + '>';
    var fp = $('filePick');
    fp.onchange = function () {
      var val = fp.value;
      if (val) {
        var input = document.querySelector('#form [data-p="' + forName + '"]');
        if (input) { input.value = val; collect(); regenerate(); }
      }
    };
    fp.click();
  }

  function browseFolder(title, start) {
    try {
      var sa = new ActiveXObject('Shell.Application');
      var f = sa.BrowseForFolder(0, title || 'Choose a folder', 0x0041 | 0x0010, start || 0);
      return f ? f.Self.Path : null;
    } catch (e) { return null; }
  }

  function openTemplate(file) {
    var src = ROOT + '\\templates\\' + file, dir = S.settings.outputFolder + '\\Templates', dst = dir + '\\' + file;
    try {
      mkdirs(dir);
      if (!fso.FileExists(dst)) fso.CopyFile(src, dst, false);
      openPath(dst);
      toast('Template: ' + dst);
    } catch (e) { toast('Could not open template: ' + e.message); }
  }

  function openInitializePlaces() {
    if (!S.pwsh) S.pwsh = findPwsh();
    if (!S.pwsh) { toast('PowerShell 7 not found'); return; }
    var out = S.settings.outputFolder;
    mkdirs(out);
    var ps = "$Host.UI.RawUI.WindowTitle = 'Initialize-Places | Watts365 Places Toolbox'\n" +
      'Set-Location -LiteralPath ' + psq(out) + '\n' +
      "Write-Host 'Initialize-Places' -ForegroundColor Cyan\n" +
      "Write-Host ('Working folder: ' + (Get-Location)) -ForegroundColor DarkGray\n" +
      "Write-Host 'Sign in using the browser window that opens.' -ForegroundColor DarkGray\n" +
      'Import-Module MicrosoftPlaces\nConnect-MicrosoftPlaces\nInitialize-Places';
    try { sh.Run('"' + S.pwsh + '" -NoLogo -NoExit -ExecutionPolicy Bypass -EncodedCommand ' + b64ps(ps), 1, false); }
    catch (e) { toast('Could not start PowerShell: ' + e.message); }
  }

  /* ---------- Console ---------- */

  function consoleHtml() {
    var h = ['<div class="eyebrow">Toolbox · Console</div><h1>PowerShell console</h1>',
      '<p class="lead">Runs in the same connected session as everything else. Variables persist between runs, and <span class="mono">$Last</span> holds the previous command\'s results.</p>',
      '<textarea id="consoleIn" spellcheck="false" placeholder="Get-PlaceV3 -Type Building | Select-Object DisplayName, PlaceId">' + esc(S.consoleDraft || '') + '</textarea>',
      '<div class="runBar"><button class="btn" data-act="consoleRun">Run</button><span class="muted small">Ctrl+Enter to run. Commands that prompt for input will wait in the engine window.</span></div>'];
    if (S.consoleHistory.length) {
      h.push('<h2>Recent</h2>');
      for (var i = S.consoleHistory.length - 1; i >= 0 && i >= S.consoleHistory.length - 15; i--)
        h.push('<div class="pickRow mono small" data-act="consoleLoad" data-i="' + i + '">' + esc(S.consoleHistory[i]) + '</div>');
    }
    h.push('<h2>Handy</h2><div class="small muted">');
    var tips = ['Get-Command -Module MicrosoftPlaces', 'Get-PlaceV3 -Type Building | Select-Object DisplayName, PlaceId, City', 'Get-PlaceV3 -Type Desk | Group-Object { $_.Mode.Name } | Select-Object Name, Count', 'Get-Help New-Place -Full', '$Last | Format-List *'];
    for (var t = 0; t < tips.length; t++) h.push('<div class="pickRow mono" data-act="consoleTip" data-cmd="' + esc(tips[t]) + '">' + esc(tips[t]) + '</div>');
    h.push('</div>');
    return h.join('');
  }

  function consoleRun() {
    var t = trim($('consoleIn').value);
    if (!t) return;
    if (S.consoleHistory[S.consoleHistory.length - 1] !== t) S.consoleHistory.push(t);
    S.consoleDraft = t;
    submit(t, { label: firstLine(t) });
  }

  /* ---------- Explorer ---------- */

  var TYPE_ORDER = { Building: 0, Floor: 1, Section: 2, Room: 3, Space: 4, Desk: 5 };
  var CHILD_TYPE = { Building: 'Floor', Floor: 'Section', Section: 'Desk' };

  function sortedKids(id) {
    var k = (S.kids[id] || []).slice();
    k.sort(function (a, b) { var t = TYPE_ORDER[a.Type] - TYPE_ORDER[b.Type]; return t || (a.DisplayName.toLowerCase() < b.DisplayName.toLowerCase() ? -1 : 1); });
    return k;
  }

  function explorerHtml() {
    var h = ['<div class="pageHead"><div class="grow"><div class="eyebrow">Toolbox · Explorer</div><h1>Places explorer</h1><p class="lead">Your buildings, floors, sections, rooms, workspaces and desks. Select a place to see it and act on it.</p></div>',
      '<div class="actions"><button class="btn ghost" data-act="loadIndex">' + (S.index ? 'Refresh' : 'Load places') + '</button></div></div>'];
    if (!S.index) {
      h.push('<div class="note">' + (S.indexPending ? 'Loading places…' : 'Load your places to browse them. This needs a Microsoft Places connection.') + '</div>');
      return h.join('');
    }
    var counts = {};
    for (var i = 0; i < S.index.length; i++) counts[S.index[i].Type] = (counts[S.index[i].Type] || 0) + 1;
    var sum = [];
    for (var t in TYPE_ORDER) if (counts[t]) sum.push(counts[t] + ' ' + (t === 'Space' ? 'workspace' : t.toLowerCase()) + (counts[t] === 1 ? '' : 's'));
    h.push('<p class="muted small">' + sum.join(' · ') + '</p>');
    h.push('<div class="explorer"><div class="tree">' + treeHtml() + '</div><div class="detail">' + detailHtml() + '</div></div>');
    return h.join('');
  }

  function treeHtml() {
    var h = [];
    function walk(p, depth) {
      var kids = sortedKids(p.PlaceId), open = S.explorerOpen[p.PlaceId];
      h.push('<div class="tnode' + (S.explorerSel === p.PlaceId ? ' sel' : '') + '" data-act="tnode" data-id="' + esc(p.PlaceId) + '" style="padding-left:' + (10 + depth * 16) + 'px">' +
        '<span class="tw" data-act="ttoggle" data-id="' + esc(p.PlaceId) + '">' + (kids.length ? (open ? '▼' : '▶') : '') + '</span>' + esc(p.DisplayName) + '<span class="ty">' + (p.Type === 'Space' ? 'workspace' : p.Type) + (kids.length ? ' · ' + kids.length : '') + '</span></div>');
      if (open) for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    var tops = sortedKids(''), orphans = [];
    for (var id in S.kids) if (id && !S.byId[id]) orphans = orphans.concat(S.kids[id]);
    for (var i = 0; i < tops.length; i++) walk(tops[i], 0);
    for (var o = 0; o < orphans.length; o++) walk(orphans[o], 0);
    return h.join('') || '<p class="muted" style="padding:10px">No places found.</p>';
  }

  function detailHtml() {
    var p = S.explorerSel && S.byId[S.explorerSel];
    if (!p) return '<div class="card"><p class="muted">Select a place.</p></div>';
    var h = ['<div class="card"><div class="eyebrow">' + (p.Type === 'Space' ? 'Workspace' : p.Type) + '</div><h2 style="margin-top:0">' + esc(p.DisplayName) + '</h2><table class="kv">'];
    var rows = [['Path', pathOf(p) || '(top level)'], ['PlaceId', p.PlaceId], ['Email', p.Email], ['Mode', p.Mode], ['Capacity', p.Capacity], ['Has map', p.Type === 'Building' ? (p.HasMap ? 'Yes' : 'No') : '']];
    for (var i = 0; i < rows.length; i++) if (rows[i][1] !== '' && rows[i][1] != null) h.push('<tr><td class="k">' + rows[i][0] + '</td><td class="v">' + esc(rows[i][1]) + '</td></tr>');
    h.push('</table><div style="margin-top:14px">');
    h.push('<button class="btn small" data-act="exGet">Full details</button>');
    h.push('<button class="btn small ghost" data-act="exEdit">Edit (Set-PlaceV3)</button>');
    if (CHILD_TYPE[p.Type]) h.push('<button class="btn small ghost" data-act="exNew">New ' + CHILD_TYPE[p.Type].toLowerCase() + ' here</button>');
    if (p.Type === 'Building' || p.Type === 'Floor' || p.Type === 'Section') h.push('<button class="btn small ghost" data-act="exBelow">Everything below</button>');
    if (p.Type === 'Building') h.push('<button class="btn small ghost" data-act="exMap">Upload map</button>');
    h.push('<button class="btn small ghost" data-act="exCopy">Copy PlaceId</button>');
    h.push('<button class="btn small danger" data-act="exRemove">Remove…</button></div></div>');
    return h.join('');
  }

  function explorerAction(act) {
    var p = S.byId[S.explorerSel];
    if (!p) return;
    var kind = p.Type === 'Space' ? 'Workspace' : p.Type, label = (pathOf(p) ? pathOf(p) + ' › ' : '') + p.DisplayName + ' (' + p.Type + ')';
    if (act === 'exGet') submit('Get-PlaceV3 -Identity ' + psq(chooseValue(p, 'auto')), { label: 'Get-PlaceV3 ' + p.DisplayName });
    if (act === 'exBelow') submit('Get-PlaceV3 -AncestorId ' + psq(p.PlaceId), { label: 'Everything below ' + p.DisplayName });
    if (act === 'exCopy') copyText(p.PlaceId);
    if (act === 'exEdit') go('cmdlet', 'Set-PlaceV3', { set: kind, values: { Identity: chooseValue(p, 'auto') }, labels: { Identity: label } });
    if (act === 'exRemove') go('cmdlet', 'Remove-Place', { values: { Identity: p.PlaceId }, labels: { Identity: label } });
    if (act === 'exNew') go('cmdlet', 'New-Place', { set: CHILD_TYPE[p.Type], values: { ParentId: p.PlaceId, Mode: CHILD_TYPE[p.Type] === 'Desk' ? { Name: 'Reservable' } : undefined }, labels: { ParentId: label } });
    if (act === 'exMap') go('recipe', 'mapupload', { values: { BuildingId: p.PlaceId }, labels: { BuildingId: label } });
  }

  /* ================= Modal & toast ================= */

  function showModal(title, body, buttons) {
    var b = [];
    for (var i = 0; i < buttons.length; i++) b.push('<button class="btn ' + (buttons[i].cls || '') + '" data-act="' + buttons[i].act + '">' + esc(buttons[i].label) + '</button>');
    $('modal').innerHTML = '<div class="mHead"><h3>' + esc(title) + '</h3></div><div class="mBody">' + body + '</div><div class="mFoot">' + b.join('') + '</div>';
    $('modal').className = ''; $('modalBack').className = '';
  }
  function closeModal() { $('modal').className = 'hidden'; $('modalBack').className = 'hidden'; S.picker = null; S.confirmFn = null; }
  function confirmModal(title, text, okLabel, danger, fn, cmd) {
    S.confirmFn = fn;
    showModal(title, '<p>' + esc(text) + '</p>' + (cmd ? '<pre class="mono small" style="background:#0E171D;color:#E6EDF0;padding:10px 12px;border-radius:8px;white-space:pre-wrap">' + esc(cmd) + '</pre>' : ''),
      [{ label: 'Cancel', cls: 'ghost', act: 'closeModal' }, { label: okLabel, cls: danger ? 'danger' : '', act: 'confirmOk' }]);
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.innerText = msg; t.className = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'hidden'; }, 2800);
  }

  /* ================= Events ================= */

  function onClick(e) {
    e = e || window.event;
    var el = closest(e.target || e.srcElement, '[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    switch (act) {
      case 'nav': go(el.getAttribute('data-kind'), id || null); break;
      case 'chip':
        if (id === 'engine') go('home');
        else if (S.status && S.status[id === 'places' ? 'Places' : id === 'exchange' ? 'Exchange' : 'Graph']) go('home');
        else connect(id);
        break;
      case 'connect': connect(el.getAttribute('data-what'), el.getAttribute('data-scopes') ? el.getAttribute('data-scopes').split(',') : null); break;
      case 'refreshStatus': refreshStatus(); break;
      case 'disconnectPlaces': submit('Disconnect-TbxPlaces', { label: 'Disconnect from Microsoft Places', after: 'status' }); break;
      case 'install': submit('Install-TbxModule -Name ' + psq(el.getAttribute('data-mod')), { label: 'Install ' + el.getAttribute('data-mod'), after: 'status' }); break;
      case 'retryEngine': startEngine(); renderView(); break;
      case 'restartEngine': restartEngine(); break;
      case 'engineWindow': showEngineWindow(); break;
      case 'browseOut':
        var bf = browseFolder('Choose the toolbox output folder');
        if (bf) { S.settings.outputFolder = bf; saveSettings(); renderView(); }
        break;
      case 'openOut': openFolder(S.settings.outputFolder); break;
      case 'openLogs': openFolder(S.settings.outputFolder + '\\Logs'); break;
      case 'url': openUrl(el.getAttribute('data-url')); break;
      case 'template': openTemplate(el.getAttribute('data-file')); break;
      case 'initPlaces': openInitializePlaces(); break;
      case 'set': collect(); S.form.set = el.getAttribute('data-set'); renderView(); break;
      case 'run': runForm(el.getAttribute('data-dry') === '1'); break;
      case 'copyCmd': copyText($('cmdText').value); break;
      case 'resetCmd': collect(); regenerate(); break;
      case 'browseFile': browseFile(el.getAttribute('data-for'), el.getAttribute('data-ext')); break;
      case 'browseFolder':
        var fo = browseFolder('Choose a folder');
        if (fo) { var inp = document.querySelector('#form [data-p="' + el.getAttribute('data-for') + '"]'); if (inp) { inp.value = fo; collect(); regenerate(); } }
        break;
      case 'pick': collect(); openPicker(el.getAttribute('data-for')); break;
      case 'pickDevice': collect(); openDevicePicker(el.getAttribute('data-for')); break;
      case 'pickPlace': pickPlace(id); break;
      case 'pickDev':
        var di = document.querySelector('#form [data-p="' + S.picker.param.n + '"]');
        if (di) di.value = el.getAttribute('data-val');
        closeModal(); collect(); regenerate();
        break;
      case 'pickReload': if (S.picker && S.picker.kind === 'device') { S.devices = null; loadDevices(); } else { loadIndex(); renderPickerList(); } break;
      case 'prefillDevice': prefillDevice(); break;
      case 'closeModal': closeModal(); break;
      case 'confirmOk': var fn = S.confirmFn; closeModal(); if (fn) fn(); break;
      case 'consoleRun': consoleRun(); break;
      case 'consoleLoad': $('consoleIn').value = S.consoleHistory[+el.getAttribute('data-i')]; $('consoleIn').focus(); break;
      case 'consoleTip': $('consoleIn').value = el.getAttribute('data-cmd'); $('consoleIn').focus(); break;
      case 'loadIndex': loadIndex(); renderView(); break;
      case 'ttoggle':
        S.explorerOpen[id] = !S.explorerOpen[id];
        if (e.stopPropagation) e.stopPropagation();
        renderView();
        return;
      case 'tnode': S.explorerSel = id; if (!S.explorerOpen[id]) S.explorerOpen[id] = true; renderView(); break;
      case 'exGet': case 'exBelow': case 'exCopy': case 'exEdit': case 'exRemove': case 'exNew': case 'exMap': explorerAction(act); break;
      case 'dtab': setDockTab(el.getAttribute('data-tab')); break;
      case 'cancel': cancelJob(); break;
      case 'clearLog': $('log').innerHTML = ''; break;
      case 'sort':
        var c = +el.getAttribute('data-col');
        if (S.resSort === c) S.resDesc = !S.resDesc; else { S.resSort = c; S.resDesc = false; }
        renderResults();
        break;
      case 'copyResults': copyResults(); break;
      case 'exportResults': exportResults(); break;
      case 'historyOpen':
        var job = find(S.jobs, 'id', id);
        if (!job) break;
        if (job.results && job.results.length) showResults(job);
        else { S.consoleDraft = job.script; go('console'); }
        break;
    }
  }

  function onFieldChange(e) {
    e = e || window.event;
    var t = e.target || e.srcElement;
    if (t.getAttribute && t.getAttribute('data-set')) {
      S.settings[t.getAttribute('data-set')] = t.checked; saveSettings(); return;
    }
    if (t.id === 'setOut') { S.settings.outputFolder = trim(t.value); saveSettings(); return; }
    if (t.id === 'navSearch') { renderNav(); return; }
    if (t.id === 'pickSearch') { renderPickerList(); return; }
    if (t.id === 'resFilter') { renderResults(); return; }
    if (t.id === 'consoleIn') { S.consoleDraft = t.value; return; }
    if (S.form && t.getAttribute && t.getAttribute('data-p')) {
      collect(); syncShow(); regenerate();
      if (t.getAttribute('data-k') === 'Name') { syncShow(); }
    }
  }

  function onKeyDown(e) {
    e = e || window.event;
    var t = e.target || e.srcElement;
    if (e.keyCode === 13 && e.ctrlKey && t.id === 'consoleIn') { consoleRun(); return false; }
    if (e.keyCode === 27 && $('modal').className !== 'hidden') closeModal();
    if (e.keyCode === 116) { if (e.preventDefault) e.preventDefault(); return false; } // F5 would reload and orphan the engine
  }

  function initSplitter() {
    var sp = $('splitter'), dock = $('dock'), dragging = false;
    dock.style.height = S.settings.dockHeight + 'px';
    sp.onmousedown = function () { dragging = true; document.body.style.cursor = 'row-resize'; return false; };
    document.onmousemove = function (e) {
      if (!dragging) return;
      e = e || window.event;
      var h = document.documentElement.clientHeight - e.clientY - 3;
      h = Math.max(120, Math.min(document.documentElement.clientHeight - 260, h));
      dock.style.height = h + 'px';
    };
    document.onmouseup = function () {
      if (!dragging) return;
      dragging = false; document.body.style.cursor = '';
      S.settings.dockHeight = parseInt(dock.style.height, 10); saveSettings();
    };
  }

  /* ================= Boot ================= */

  function boot() {
    try {
      var w = Math.min(1520, screen.availWidth), h = Math.min(980, screen.availHeight);
      window.resizeTo(w, h); window.moveTo(Math.max(0, (screen.availWidth - w) / 2), Math.max(0, (screen.availHeight - h) / 2));
    } catch (e) { }
    loadSettings();
    document.onclick = onClick;
    document.onkeyup = onFieldChange;
    document.onchange = onFieldChange;
    document.onkeydown = onKeyDown;
    initSplitter();
    renderNav();
    renderChips();
    renderHistory();
    renderResults();
    go('home');
    startEngine();
    setInterval(poll, 250);
    setInterval(function () { if (S.session) touch(S.session + '\\ui.alive'); renderDockStatus(); }, 5000);
    window.onunload = function () { if (S.session) touch(S.session + '\\stop'); if (currentJob() && S.engine.pid) { try { sh.Run('"' + sysExe('taskkill.exe') + '" /PID ' + S.engine.pid + ' /T /F', 0, false); } catch (e) { } } };
  }

  window.onload = boot;
})();
