/**
 * Self-contained dashboard page served by the Worker at `/`.
 *
 * Everything (markup, styling, client logic) is inline so there is no build
 * step and no external assets to fetch. The client talks to the same-origin
 * `/api/*` endpoints. A per-request CSP nonce (see index.ts) is applied to the
 * inline <style> and <script> so we can keep a strict Content-Security-Policy.
 *
 * The client script deliberately avoids template literals / escape sequences
 * so it can live safely inside this TypeScript template string.
 */
export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>INWX Bot Dashboard</title>
<link rel="icon" href="data:," />
<style nonce="${nonce}">
*{box-sizing:border-box}
:root{--bg:#f1f5f9;--fg:#0f172a;--muted:#64748b;--card:#fff;--border:#e2e8f0;--primary:#2563eb;--primary-fg:#fff;--err:#dc2626;--chip:#f1f5f9}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--fg:#e2e8f0;--muted:#94a3b8;--card:#0f172a;--border:#1e293b;--chip:#1e293b}}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 20px;border-bottom:1px solid var(--border);background:var(--card)}
header h1{font-size:17px;margin:0}
.meta{display:flex;align-items:center;gap:10px}
main{max-width:980px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.card h2{font-size:15px;margin:0}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row{display:flex;gap:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.tile{background:var(--chip);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.tile .k{font-size:12px;color:var(--muted)}
.tile .v{font-size:18px;font-weight:600;margin-top:2px}
.btn{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--fg);cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}
.btn-ghost{background:transparent}
input,textarea{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{resize:vertical}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.table-wrap{overflow-x:auto}
.muted{color:var(--muted);font-size:13px}
.error{color:var(--err);font-size:13px}
.warn{color:#b45309;font-weight:600}
.danger{color:var(--err);font-weight:600}
.badge{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;font-weight:600}
.badge-skipped{background:var(--chip);color:var(--muted)}
.badge-would_purchase{background:#dbeafe;color:#1e40af}
.badge-purchased{background:#dcfce7;color:#166534}
.badge-purchase_failed{background:#fee2e2;color:#991b1b}
.badge-error{background:#fef3c7;color:#92400e}
.badge-dry{background:#fef3c7;color:#92400e}
.badge-live{background:#dcfce7;color:#166534}
footer{max-width:980px;margin:0 auto;padding:8px 20px 28px;color:var(--muted);font-size:12px}
.mt{margin-top:10px}
[hidden]{display:none !important}
</style>
</head>
<body>
<header>
  <h1>INWX Bot Dashboard</h1>
  <div class="meta">
    <span id="mode" class="badge" hidden></span>
    <button id="logout" class="btn btn-ghost" hidden>Abmelden</button>
  </div>
</header>
<main>
  <section id="login" class="card" hidden>
    <h2>Anmelden</h2>
    <p class="muted">Bitte den Admin-Token eingeben (entspricht dem Secret <code>ADMIN_TOKEN</code>).</p>
    <div class="row">
      <input id="token" type="password" placeholder="Admin-Token" autocomplete="off" />
      <button id="connect" class="btn btn-primary">Verbinden</button>
    </div>
    <p id="login-error" class="error" hidden></p>
  </section>

  <div id="app" hidden>
    <section class="card">
      <div class="card-head">
        <h2>Status</h2>
        <div class="actions">
          <button id="refresh" class="btn">Aktualisieren</button>
          <button id="run" class="btn btn-primary">Jetzt prüfen</button>
        </div>
      </div>
      <div id="status-grid" class="grid"></div>
      <p id="run-msg" class="muted" hidden></p>
      <p id="last-error" class="error" hidden></p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Domain-Liste</h2>
        <span id="domain-count" class="muted"></span>
      </div>
      <textarea id="domains" rows="8" placeholder="eine Domain pro Zeile, z. B. example.de"></textarea>
      <div class="actions mt">
        <button id="save-domains" class="btn btn-primary">Speichern</button>
        <span id="domains-msg" class="muted" hidden></span>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Ergebnisse</h2>
        <button id="download" class="btn">CSV herunterladen</button>
      </div>
      <div class="table-wrap">
        <table id="results">
          <thead><tr><th>Domain</th><th>Verfügbar</th><th>Status</th><th>Detail</th><th>Code</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="results-empty" class="muted" hidden>Noch keine Ergebnisse. Starte eine Prüfung.</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>WHOIS / Domain-Status</h2>
        <div class="actions">
          <span id="whois-time" class="muted"></span>
          <button id="whois-refresh" class="btn">WHOIS aktualisieren</button>
        </div>
      </div>
      <div class="table-wrap">
        <table id="whois">
          <thead><tr><th>Domain</th><th>Status</th><th>Registriert</th><th>Läuft ab</th><th>Zuletzt geändert</th><th>Registrar</th><th>Quelle</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="whois-empty" class="muted" hidden>Noch keine WHOIS-Daten. Klicke „WHOIS aktualisieren".</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Verlauf</h2>
        <span class="muted">letzte Läufe</span>
      </div>
      <div class="table-wrap">
        <table id="history">
          <thead><tr><th>Zeitpunkt</th><th>Geprüft</th><th>verfügbar</th><th>gekauft</th><th>fehlgeschlagen</th><th>Fehler</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p id="history-empty" class="muted" hidden>Noch kein Verlauf.</p>
    </section>
  </div>
</main>
<footer>INWX Bot &middot; Cron-gesteuerter Domain-Check auf Cloudflare Workers</footer>

<script nonce="${nonce}">
(function () {
  var TOKEN_KEY = 'inwx_admin_token';
  function el(id) { return document.getElementById(id); }
  function getToken() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { if (t) { sessionStorage.setItem(TOKEN_KEY, t); } else { sessionStorage.removeItem(TOKEN_KEY); } }
  function clearNode(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }
  function show(node, on) { node.hidden = !on; }
  function fmtTime(iso) { if (!iso) { return 'noch kein Lauf'; } var d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString(); }
  function fmtDate(v) { if (!v) { return '–'; } var d = new Date(v); return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString(); }
  function daysUntil(v) { if (!v) { return null; } var d = new Date(v); if (isNaN(d.getTime())) { return null; } return Math.floor((d.getTime() - Date.now()) / 86400000); }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var k;
    if (opts.headers) { for (k in opts.headers) { headers[k] = opts.headers[k]; } }
    var t = getToken();
    if (t) { headers['authorization'] = 'Bearer ' + t; }
    opts.headers = headers;
    return fetch(path, opts);
  }

  var ACTION_LABELS = { skipped: 'übersprungen', would_purchase: 'verfügbar', purchased: 'gekauft', purchase_failed: 'Kauf fehlgeschlagen', error: 'Fehler' };

  function badge(action) {
    var span = document.createElement('span');
    span.className = 'badge badge-' + action;
    span.textContent = ACTION_LABELS[action] || action;
    return span;
  }

  function tile(key, value) {
    var d = document.createElement('div'); d.className = 'tile';
    var kk = document.createElement('div'); kk.className = 'k'; kk.textContent = key;
    var vv = document.createElement('div'); vv.className = 'v'; vv.textContent = value;
    d.appendChild(kk); d.appendChild(vv);
    return d;
  }

  var lastTimestamp = null;

  function renderStatus(record) {
    var grid = el('status-grid'); clearNode(grid);
    var statuses = (record && record.statuses) || [];
    var counts = {};
    var i;
    for (i = 0; i < statuses.length; i++) { var a = statuses[i].action; counts[a] = (counts[a] || 0) + 1; }
    grid.appendChild(tile('Letzter Lauf', record ? fmtTime(record.timestamp) : 'noch kein Lauf'));
    grid.appendChild(tile('Geprüft', String(statuses.length)));
    grid.appendChild(tile('verfügbar', String(counts['would_purchase'] || 0)));
    grid.appendChild(tile('gekauft', String(counts['purchased'] || 0)));
    grid.appendChild(tile('fehlgeschlagen', String(counts['purchase_failed'] || 0)));
    grid.appendChild(tile('übersprungen', String(counts['skipped'] || 0)));
    grid.appendChild(tile('Fehler', String(counts['error'] || 0)));
    var le = el('last-error');
    if (record && record.error) { le.textContent = 'Fehler beim letzten Lauf: ' + record.error; show(le, true); }
    else { show(le, false); }
  }

  function renderResults(record) {
    var tbody = el('results').querySelector('tbody'); clearNode(tbody);
    var statuses = (record && record.statuses) || [];
    show(el('results-empty'), statuses.length === 0);
    var i;
    for (i = 0; i < statuses.length; i++) {
      var s = statuses[i];
      var tr = document.createElement('tr');
      var c1 = document.createElement('td'); c1.textContent = s.domain; tr.appendChild(c1);
      var c2 = document.createElement('td'); c2.textContent = s.available === true ? 'ja' : (s.available === false ? 'nein' : '–'); tr.appendChild(c2);
      var c3 = document.createElement('td'); c3.appendChild(badge(s.action)); tr.appendChild(c3);
      var c4 = document.createElement('td'); c4.textContent = s.detail || ''; tr.appendChild(c4);
      var c5 = document.createElement('td'); c5.textContent = (s.api_code === null || s.api_code === undefined) ? '' : String(s.api_code); tr.appendChild(c5);
      tbody.appendChild(tr);
    }
  }

  function setMode(dryRun) {
    var m = el('mode');
    if (dryRun) { m.textContent = 'Probelauf — kauft nicht'; m.className = 'badge badge-dry'; }
    else { m.textContent = 'Live — kauft Domains'; m.className = 'badge badge-live'; }
    show(m, true);
  }

  function showApp(on) { show(el('app'), on); show(el('login'), !on); show(el('logout'), on); }

  function loadPublicStatus() {
    return fetch('/api/status').then(function (r) { return r.json(); }).then(function (j) {
      setMode(!!(j && j.dryRun));
      if (j && j.authConfigured === false) {
        var le = el('login-error');
        le.textContent = 'Auf dem Server ist kein ADMIN_TOKEN gesetzt. Bitte mit "wrangler secret put ADMIN_TOKEN" konfigurieren.';
        show(le, true);
        el('connect').disabled = true;
      }
    }).catch(function () {});
  }

  function loadResults() {
    return api('/api/results.json').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (rec) {
      lastTimestamp = (rec && rec.timestamp) ? rec.timestamp : null;
      renderStatus(rec); renderResults(rec);
    });
  }

  function loadDomains() {
    return api('/api/domains').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (j) {
      var list = (j && j.domains) || [];
      el('domains').value = list.join(String.fromCharCode(10));
      el('domain-count').textContent = list.length + ' Domains';
    });
  }

  function renderWhois(rec) {
    var tbody = el('whois').querySelector('tbody'); clearNode(tbody);
    var list = (rec && rec.domains) || [];
    show(el('whois-empty'), list.length === 0);
    if (rec && rec.timestamp) { el('whois-time').textContent = 'Stand: ' + fmtTime(rec.timestamp); }
    var i;
    for (i = 0; i < list.length; i++) {
      var w = list[i];
      var tr = document.createElement('tr');
      var cDomain = document.createElement('td'); cDomain.textContent = w.domain; tr.appendChild(cDomain);
      var cStatus = document.createElement('td');
      if (w.available === true) {
        var b = document.createElement('span'); b.className = 'badge badge-would_purchase'; b.textContent = 'verfügbar'; cStatus.appendChild(b);
      } else if (w.error) {
        cStatus.textContent = w.error; cStatus.className = 'muted';
      } else {
        cStatus.textContent = (w.status && w.status.length) ? w.status.join(', ') : 'registriert';
      }
      tr.appendChild(cStatus);
      var cReg = document.createElement('td'); cReg.textContent = fmtDate(w.registered); tr.appendChild(cReg);
      var cExp = document.createElement('td'); cExp.textContent = fmtDate(w.expires);
      var du = daysUntil(w.expires);
      if (du !== null && du < 0) { cExp.className = 'danger'; }
      else if (du !== null && du <= 30) { cExp.className = 'warn'; }
      tr.appendChild(cExp);
      var cUpd = document.createElement('td'); cUpd.textContent = fmtDate(w.updated); tr.appendChild(cUpd);
      var cRar = document.createElement('td'); cRar.textContent = w.registrar || '–'; tr.appendChild(cRar);
      var cSrc = document.createElement('td'); cSrc.textContent = w.source || '–'; cSrc.className = 'muted'; tr.appendChild(cSrc);
      tbody.appendChild(tr);
    }
  }

  function loadWhois() {
    return api('/api/whois').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (rec) { renderWhois(rec); });
  }

  function addCell(tr, text, cls) {
    var td = document.createElement('td');
    td.textContent = text;
    if (cls) { td.className = cls; }
    tr.appendChild(td);
  }

  function renderHistory(list) {
    var tbody = el('history').querySelector('tbody'); clearNode(tbody);
    list = list || [];
    show(el('history-empty'), list.length === 0);
    var i;
    for (i = 0; i < list.length; i++) {
      var h = list[i];
      var counts = h.counts || {};
      var tr = document.createElement('tr');
      addCell(tr, fmtTime(h.timestamp));
      addCell(tr, String(h.total || 0));
      addCell(tr, String(counts['would_purchase'] || 0));
      addCell(tr, String(counts['purchased'] || 0));
      addCell(tr, String(counts['purchase_failed'] || 0));
      addCell(tr, h.error ? h.error : String(counts['error'] || 0), h.error ? 'error' : '');
      tbody.appendChild(tr);
    }
  }

  function loadHistory() {
    return api('/api/history').then(function (r) {
      if (r.status === 401) { throw { auth: true }; }
      return r.json();
    }).then(function (list) { renderHistory(list); });
  }

  function loadAuthed() {
    return Promise.all([loadDomains(), loadResults(), loadWhois(), loadHistory()]).then(function () {
      showApp(true);
    }).catch(function (e) {
      if (e && e.auth) {
        setToken(''); showApp(false);
        var le = el('login-error'); le.textContent = 'Token ungültig oder nicht autorisiert.'; show(le, true);
      }
    });
  }

  function pollUntilDone(before, attempt) {
    if (attempt > 30) { el('run-msg').textContent = 'Prüfung läuft noch im Hintergrund — bitte später aktualisieren.'; el('run').disabled = false; return; }
    setTimeout(function () {
      api('/api/results.json').then(function (r) { return r.json(); }).then(function (rec) {
        var ts = (rec && rec.timestamp) ? rec.timestamp : null;
        if (ts && ts !== before) {
          lastTimestamp = ts; renderStatus(rec); renderResults(rec); loadHistory();
          el('run-msg').textContent = 'Prüfung abgeschlossen.';
          el('run').disabled = false;
        } else {
          pollUntilDone(before, attempt + 1);
        }
      }).catch(function () { pollUntilDone(before, attempt + 1); });
    }, 2000);
  }

  el('connect').addEventListener('click', function () {
    var t = el('token').value.trim();
    if (!t) { return; }
    setToken(t); show(el('login-error'), false); loadAuthed();
  });
  el('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') { el('connect').click(); } });
  el('logout').addEventListener('click', function () { setToken(''); showApp(false); });
  el('refresh').addEventListener('click', function () { loadResults(); loadHistory(); });

  el('save-domains').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var msg = el('domains-msg'); show(msg, true); msg.textContent = 'Speichere…';
    api('/api/domains', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: el('domains').value })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function (j) { msg.textContent = 'Gespeichert: ' + j.count + ' Domains'; el('domain-count').textContent = j.count + ' Domains'; })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Speichern.'; })
      .then(function () { btn.disabled = false; });
  });

  el('run').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var msg = el('run-msg'); show(msg, true); msg.textContent = 'Prüfung gestartet…';
    var before = lastTimestamp;
    api('/api/run?async=true', { method: 'POST' })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { pollUntilDone(before, 0); })
      .catch(function (e) { msg.textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Konnte Prüfung nicht starten.'; btn.disabled = false; });
  });

  el('download').addEventListener('click', function () {
    api('/api/results.csv').then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.text(); }).then(function (text) {
      var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'inwx-results.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }).catch(function () {});
  });

  function pollWhois(before, attempt) {
    if (attempt > 60) { el('whois-time').textContent = 'WHOIS-Abfrage läuft noch — bitte später aktualisieren.'; el('whois-refresh').disabled = false; return; }
    setTimeout(function () {
      api('/api/whois').then(function (r) { return r.json(); }).then(function (rec) {
        var ts = (rec && rec.timestamp) ? rec.timestamp : null;
        if (ts && ts !== before) {
          renderWhois(rec); el('whois-refresh').disabled = false;
        } else {
          pollWhois(before, attempt + 1);
        }
      }).catch(function () { pollWhois(before, attempt + 1); });
    }, 2500);
  }

  el('whois-refresh').addEventListener('click', function () {
    var btn = this; btn.disabled = true;
    var before = null;
    api('/api/whois').then(function (r) { return r.json(); }).then(function (rec) { before = (rec && rec.timestamp) ? rec.timestamp : null; })
      .then(function () { return api('/api/whois/refresh?async=true', { method: 'POST' }); })
      .then(function (r) { if (r.status === 401) { throw { auth: true }; } return r.json(); })
      .then(function () { el('whois-time').textContent = 'WHOIS-Abfrage läuft…'; pollWhois(before, 0); })
      .catch(function (e) { el('whois-time').textContent = (e && e.auth) ? 'Nicht autorisiert.' : 'Fehler beim Start.'; btn.disabled = false; });
  });

  loadPublicStatus();
  if (getToken()) { loadAuthed(); } else { showApp(false); }
})();
</script>
</body>
</html>`;
}
