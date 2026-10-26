// Mobile approval inbox, served at GET /inbox. A thin client of the API:
// the page holds no data itself; it calls /api/approvals with the API key the
// user types once (kept in that phone's localStorage). Plain HTML, no build step.
export const INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>DS Flow inbox</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --ok:#1f7a3a; --no:#a12a2a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --card:#1c1c1c; --fg:#eee; --muted:#999; --line:#333; --ok:#3fae63; --no:#d65a5a; } }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.4 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid var(--line); }
  h1 { font-size:18px; margin:0; }
  main { padding:12px 16px 40px; max-width:600px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:12px; }
  .title { font-weight:600; margin-bottom:4px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:10px; }
  .detail { white-space:pre-wrap; margin-bottom:12px; font-size:14px; }
  .row { display:flex; gap:10px; }
  button { flex:1; font:inherit; padding:14px; border-radius:8px; border:0; color:#fff; cursor:pointer; }
  .ok { background:var(--ok); } .no { background:var(--no); }
  .link { background:none; color:var(--muted); flex:none; padding:4px; font-size:14px; text-decoration:underline; }
  input { width:100%; font:inherit; padding:12px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); margin:8px 0; }
  .empty, .msg { color:var(--muted); text-align:center; padding:30px 0; }
  button:disabled { opacity:.5; }
</style>
</head>
<body>
<header><h1>DS Flow inbox</h1><button class="link" id="out" hidden>Log out</button></header>
<main id="main"><p class="msg">Loading…</p></main>
<script>
const KEY = 'dsflow-api-key';
const main = document.getElementById('main');
const out = document.getElementById('out');
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch {} },
  clear() { try { localStorage.removeItem(KEY); } catch {} },
};
let key = store.get();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const when = (iso) => new Date(iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day:'numeric', month:'short', hour:'numeric', minute:'2-digit' });

async function api(path, method = 'GET') {
  const res = await fetch(path, { method, headers: { 'x-api-key': key } });
  if (res.status === 401) { store.clear(); key = null; login('That key did not work.'); throw new Error('unauthorised'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function login(msg = '') {
  out.hidden = true;
  main.innerHTML = '<div class="card"><div class="title">Enter the DS Flow API key</div>' +
    '<div class="meta">Once per phone. It stays on this device.</div>' +
    (msg ? '<div class="meta" style="color:var(--no)">' + esc(msg) + '</div>' : '') +
    '<form id="f"><input id="k" type="password" autocomplete="current-password" required>' +
    '<div class="row"><button class="ok">Save</button></div></form></div>';
  document.getElementById('f').onsubmit = (e) => { e.preventDefault(); key = document.getElementById('k').value.trim(); store.set(key); load(); };
}

async function load() {
  if (!key) return login();
  out.hidden = false;
  let rows;
  try { rows = await api('/api/approvals'); } catch (e) { if (key) main.innerHTML = '<p class="msg">Could not load: ' + esc(e.message) + '</p>'; return; }
  if (!rows.length) { main.innerHTML = '<p class="empty">Nothing waiting. ✓</p>'; return; }
  main.innerHTML = rows.map((a) =>
    '<div class="card" data-id="' + esc(a.id) + '"><div class="title">' + esc(a.title || 'Approval needed') + '</div>' +
    '<div class="meta">' + esc(a.flowId) + ' · ' + esc(when(a.createdAt)) + '</div>' +
    (a.detail ? '<div class="detail">' + esc(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail, null, 2)) + '</div>' : '') +
    '<div class="row"><button class="ok" data-d="approve">Approve</button><button class="no" data-d="reject">Reject</button></div></div>'
  ).join('');
}

main.onclick = async (e) => {
  const d = e.target.dataset?.d;
  if (!d) return;
  const card = e.target.closest('.card');
  if (d === 'reject' && !confirm('Reject this?')) return;
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try { await api('/api/approvals/' + encodeURIComponent(card.dataset.id) + '/' + d, 'POST'); load(); }
  catch (err) { card.querySelectorAll('button').forEach((b) => (b.disabled = false)); if (key) alert('Failed: ' + err.message); }
};
out.onclick = () => { store.clear(); key = null; login(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && key) load(); });
load();
</script>
</body>
</html>
`;
