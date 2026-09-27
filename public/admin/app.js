'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n ?? '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function token() {
  try {
    return sessionStorage.getItem('adminToken') || '';
  } catch {
    return '';
  }
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function table(rows, cols) {
  if (!rows.length) return '<p class="muted">Nothing yet.</p>';
  const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'n' : ''}">${c.html ? c.html(r) : esc(c.get(r))}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function bars(rows, key, val) {
  const max = Math.max(1, ...rows.map((r) => r[val]));
  return table(rows, [
    { label: key, get: (r) => r[key] ?? '(unclassified)' },
    { label: 'Books', num: true, get: (r) => fmt(r[val]) },
    { label: '', html: (r) => `<div class="bar" style="width:${Math.round((r[val] / max) * 100)}%"></div>` },
  ]);
}

async function load() {
  $('status').textContent = 'Loading…';
  try {
    const s = await api('/api/admin/stats');
    const last = s.last_import;
    const ls = (last && last.stats) || {};
    const tiles = [
      ['Books in catalog', s.books],
      ['Editions', s.editions],
      ['Books imported (last run)', ls.inserted],
      ['Books updated (last run)', ls.updated],
      ['Books failed / quarantined (last run)', (ls.failed ?? 0) + (ls.invalid ?? 0), 'bad'],
      ['Duplicates found (last run)', ls.duplicates, 'warn'],
      ['Missing images', s.books_missing_images, 'warn'],
      ['Missing prices', s.books_missing_prices, 'warn'],
      ['Missing ISBN', s.books_missing_isbn, 'warn'],
      ['Unclassified', s.books_unclassified, 'warn'],
      ['Dedupe candidates', s.dedupe_candidates_pending],
      ['Quality errors', s.quality_errors, 'bad'],
    ];
    $('tiles').innerHTML = tiles.map(([k, v, cls]) => `<div class="tile ${cls || ''}"><div class="v">${fmt(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

    $('lastImport').innerHTML = last
      ? table(
          [
            ['Job', last.job_id],
            ['Status', last.status + (s.import_running ? ` (running: ${s.import_running})` : '')],
            ['Started', last.started_at],
            ['Completed', last.completed_at || '—'],
            ['Fetched', fmt(ls.fetched)],
            ['Valid', fmt(ls.valid)],
            ['Duplicates', fmt(ls.duplicates)],
            ['Invalid', fmt(ls.invalid)],
            ['Inserted', fmt(ls.inserted)],
            ['Updated', fmt(ls.updated)],
          ],
          [
            { label: 'Import result', get: (r) => r[0] },
            { label: '', get: (r) => r[1] },
          ],
        )
      : '<p class="muted">No imports yet.</p>';

    $('sources').innerHTML = bars(s.source_distribution, 'source', 'books');
    $('categories').innerHTML = bars(s.category_distribution, 'category', 'books');
    $('providers').innerHTML = table(s.providers, [
      { label: 'Provider', get: (p) => p.name },
      { label: 'Enabled', get: (p) => (p.enabled ? 'yes' : 'no') },
      { label: 'Note', get: (p) => p.reason || '' },
    ]);
    $('jobs').innerHTML = table(s.recent_jobs, [
      { label: 'Started', get: (j) => j.started_at },
      { label: 'Kind', get: (j) => j.kind },
      { label: 'Status', get: (j) => j.status },
      { label: 'Inserted', num: true, get: (j) => fmt(j.stats.inserted) },
      { label: 'Updated', num: true, get: (j) => fmt(j.stats.updated) },
      { label: 'Invalid', num: true, get: (j) => fmt(j.stats.invalid) },
      { label: 'Error', get: (j) => j.error || '' },
    ]);
    const q = await api('/api/admin/quality-errors?limit=25');
    $('quality').innerHTML = table(q.items, [
      { label: 'Severity', html: (r) => `<span class="${r.severity === 'error' ? 'err' : 'muted'}">${esc(r.severity)}</span>` },
      { label: 'Code', get: (r) => r.code },
      { label: 'Title', get: (r) => r.title },
      { label: 'Message', get: (r) => r.message },
      { label: 'Stage', get: (r) => r.stage },
    ]);
    $('status').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('status').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

$('tokenForm').addEventListener('submit', (e) => {
  e.preventDefault();
  try {
    sessionStorage.setItem('adminToken', $('token').value);
  } catch {
    /* storage unavailable */
  }
  load();
});
$('refresh').addEventListener('click', load);
$('syncForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/catalog/import', { method: 'POST', body: JSON.stringify({ target: Number($('target').value) }) });
    $('actionOut').textContent = `Started job ${r.job_id}`;
    setTimeout(load, 1500);
  } catch (err) {
    $('actionOut').textContent = err.message;
  }
});
$('isbnForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('actionOut').textContent = 'Importing…';
  try {
    const r = await api('/api/catalog/import/isbn', { method: 'POST', body: JSON.stringify({ isbn: $('isbn').value }) });
    $('actionOut').textContent = `${r.status}: ${r.book ? r.book.title : ''} (${r.sources.join(', ')})`;
    load();
  } catch (err) {
    $('actionOut').textContent = err.message;
  }
});
load();
