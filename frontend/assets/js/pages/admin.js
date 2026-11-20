/**
 * Admin panel (admin.html) – only for the admin account (GET /me → role "admin").
 * Every /admin/* endpoint is also protected in the backend (HTTP 403 for participants).
 *
 * One big network: every participant has an ID (ID 1 … ID N) and the admin decides
 * whom each person sees ("viewer sees target", one direction). Somebody who sees
 * nobody has no Community.
 *
 *  GET  /admin/overview                      settings, connections, participants
 *  PUT  /admin/settings                      { experiment_paused?, community_default? }
 *  PUT  /admin/users/{id}/visibility         { sees: [2, 5] }
 *  PUT  /admin/users/{id}/community          { enabled: bool }
 *  POST /admin/community                     { enabled, user_ids? }  (no ids = everyone)
 *  GET  /admin/export/participants|network   { filename, csv }
 *  POST /admin/import/participants|network   { csv, dry_run } → preview / apply
 */
import { auth, admin } from '../api.js';
import { $, $$, esc, fmt, toast, setBusy, icons, homeFor } from '../ui.js';

/* ------------------------------------------------------------ Guard */
const user = await auth.restore().catch(() => null);
if (!user || user.role !== 'admin') {
  location.replace(homeFor(user));
  await new Promise(() => {}); // stop here while the browser navigates away
}

const state = { data: null, q: '', filter: 'all', sort: 'id', pending: {}, editing: null };
const idLabel = (n) => `ID ${n}`;
const fullName = (u) => `${u.first_name} ${u.last_name}`;

/* ------------------------------------------------------------ Sidebar */
function renderSidebar() {
  const host = $('#sidebar');
  host.setAttribute('aria-label', 'Admin navigation');
  host.innerHTML = `
    <div class="sidebar-top">
      <a class="brand" href="admin.html" aria-label="Activ-Ate admin">${icons.logo}<span class="brand-name">Activ<i>-</i>Ate</span></a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="nav-main" aria-label="Open menu">${icons.menu}</button>
    </div>
    <nav class="nav" id="nav-main">
      <a href="admin.html" aria-current="page">${icons.dashboard}Study control</a>
      <a href="#participants">${icons.community}Participants &amp; network</a>
      <a href="#csv-people">${icons.goals}CSV files</a>
    </nav>
    <div class="sidebar-foot">
      <div class="nav"><button type="button" id="logout-btn">${icons.logout}Log out</button></div>
      <div class="user-card">
        <span class="avatar avatar--me">AD</span>
        <div style="min-width:0"><div class="name">${esc(user.username)}</div><div class="sub">Administrator</div></div>
      </div>
    </div>`;
  const toggle = $('.menu-toggle', host);
  toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', String(host.classList.toggle('open'))));
  $$('#nav-main a', host).forEach((a) => a.addEventListener('click', () => host.classList.remove('open')));
  $('#logout-btn', host).addEventListener('click', async () => { await auth.logout(); location.replace('signin.html'); });
}
renderSidebar();
document.body.classList.add('ready');

/* ------------------------------------------------------------ Confirm dialog */
function confirmDialog(title, text, okLabel = 'Confirm') {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

/* ------------------------------------------------------------ Load + render */
async function load() {
  try { setData(await admin.overview()); } catch (err) { toast(err.message, 'error'); }
}

function setData(d) {
  state.data = { settings: d.settings, connections: d.connections, users: d.users };
  render();
}

function render() {
  renderKpis();
  renderSettings();
  renderUsers();
}

function renderKpis() {
  const { users, connections } = state.data;
  const done = users.filter((u) => u.onboarding_complete).length;
  const active = users.filter((u) => u.community_active).length;
  const nobody = users.filter((u) => !u.sees.length).length;
  const mutual = users.reduce((n, u) => n + u.sees.filter((t) => users.find((x) => x.participant_no === t)?.sees.includes(u.participant_no)).length, 0) / 2;
  $('#kpis').innerHTML = `
    <div class="kpi"><span class="kpi-label">Registered</span><span class="kpi-value">${users.length}</span><span class="kpi-note">${done} finished onboarding</span></div>
    <div class="kpi"><span class="kpi-label">Connections</span><span class="kpi-value">${connections}</span><span class="kpi-note">“sees” pairs · ${mutual} mutual</span></div>
    <div class="kpi"><span class="kpi-label">Community on</span><span class="kpi-value">${active} <small>/ ${users.length}</small></span></div>
    <div class="kpi"><span class="kpi-label">See nobody</span><span class="kpi-value">${nobody}</span>${nobody ? '<span class="kpi-note kpi-note--warm">Community off automatically</span>' : ''}</div>`;
}

function renderSettings() {
  const s = state.data.settings;
  const running = !s.experiment_paused;
  $('#sw-running').setAttribute('aria-checked', String(running));
  $('#sw-running-label').textContent = running ? 'Running' : 'Paused';
  $('#sw-community').setAttribute('aria-checked', String(s.community_default));
  $('#sw-community-label').textContent = s.community_default ? 'Allowed' : 'Off';
  const pill = $('#status-pill');
  pill.textContent = running ? 'Live – participants use the app' : 'Paused – participants see the waiting page';
  pill.className = `status-pill ${running ? 'status-pill--live' : 'status-pill--paused'}`;
}

/* ------------------------------------------------------------ Participant table */
const byText = (a, b) => String(a || '').localeCompare(String(b || ''), 'de-CH', { sensitivity: 'base' });
const SORTS = {
  id: (a, b) => (a.participant_no ?? 1e9) - (b.participant_no ?? 1e9),
  first: (a, b) => byText(a.first_name, b.first_name) || byText(a.last_name, b.last_name),
  last: (a, b) => byText(a.last_name, b.last_name) || byText(a.first_name, b.first_name),
};
const FILTERS = {
  all: () => true,
  active: (u) => u.community_active,
  inactive: (u) => !u.community_active,
  'sees-nobody': (u) => !u.sees.length,
  unseen: (u) => !u.seen_by.length,
};

function matches(u, q) {
  if (!q) return true;
  const id = String(u.participant_no);
  const idQuery = q.replace(/^id\s*/, '');
  if (/^\d+$/.test(idQuery)) return id === idQuery;
  return `${u.first_name} ${u.last_name} ${u.username} ${u.email}`.toLowerCase().includes(q);
}

function visibleUsers() {
  const [key, dir] = state.sort.split('-');
  const list = state.data.users.slice().sort(SORTS[key] || SORTS.id);
  if (dir === 'desc') list.reverse();
  return list.filter((u) => FILTERS[state.filter](u) && matches(u, state.q));
}

function idList(nums, max = 6) {
  if (!nums.length) return '<span class="muted">nobody</span>';
  const shown = nums.slice(0, max).map((n) => `<span class="id-chip">${n}</span>`).join('');
  return shown + (nums.length > max ? `<span class="small muted"> +${nums.length - max}</span>` : '');
}

function communityCell(u) {
  const sw = `<button type="button" class="switch switch--sm" role="switch" aria-checked="${u.community_enabled}" data-community="${esc(u.id)}" aria-label="Community allowed for ${esc(fullName(u))}"><span class="track-sw"></span><span>${u.community_enabled ? 'Allowed' : 'Off'}</span></button>`;
  const note = u.community_enabled && !u.sees.length ? '<span class="small cell-note">not active – sees nobody</span>' : '';
  return `<span class="stack" style="gap:2px">${sw}${note}</span>`;
}

function renderUsers() {
  const { users } = state.data;
  const rows = visibleUsers();
  const all = rows.length === users.length;
  $('#count-label').textContent = all ? `${users.length} registered` : `${rows.length} of ${users.length} shown`;
  $('#bulk-label').textContent = all ? `Community switch for all ${users.length} participants:` : `Community switch for the ${rows.length} participant(s) shown:`;
  $('#bulk-on').disabled = $('#bulk-off').disabled = !rows.length;
  const head = '<div class="tr th"><span>ID</span><span>Participant</span><span>Age · gender</span><span>Height · weight</span><span>Goals &amp; sports</span><span>Sees</span><span>Seen by</span><span>Community</span></div>';
  if (!rows.length) {
    $('#users').innerHTML = head + `<div class="empty" style="margin:20px">${users.length ? 'No participant matches.' : 'Nobody has registered yet.'}</div>`;
    return;
  }
  $('#users').innerHTML = head + rows.map((u) => `
    <div class="tr" data-row="${esc(u.id)}">
      <span class="id-badge">${u.participant_no ?? '–'}</span>
      <span style="min-width:0"><b class="nowrap">${esc(fullName(u))}</b><br>
        <span class="small muted cell-ellipsis" title="${esc(u.email)}">@${esc(u.username)} · ${esc(u.email)}</span>
        <span class="small muted">${new Date(u.registered_at).toLocaleDateString('de-CH')} · ${u.onboarding_complete ? 'onboarding complete' : '<b>onboarding in progress</b>'}</span></span>
      <span class="small">${u.age}<br><span class="muted">${esc(u.gender)}</span></span>
      <span class="small">${fmt(u.height_cm)} cm<br><span class="muted">${u.weight_kg === null ? '–' : `${fmt(u.weight_kg, u.weight_kg % 1 ? 1 : 0)} kg`}</span></span>
      <span class="small muted cell-clamp" title="${esc([...u.goals, ...u.sports].join(', '))}">${esc(u.goals.join(', ') || '–')}${u.sports.length ? `<br>${esc(u.sports.join(', '))}` : ''}</span>
      <span class="sees-cell">
        <span class="id-list">${idList(u.sees)}</span>
        <button type="button" class="btn btn--small" data-edit="${esc(u.id)}" aria-label="Edit whom ${esc(fullName(u))} sees">Edit</button>
      </span>
      <span class="id-list small">${idList(u.seen_by, 4)}</span>
      ${communityCell(u)}
    </div>`).join('');
}

/* ------------------------------------------------------------ Settings */
async function saveSetting(payload, question) {
  const ok = await confirmDialog(...question);
  if (!ok) { renderSettings(); return; }
  try {
    const { settings } = await admin.saveSettings(payload);
    state.data.settings = settings;
    renderSettings();
    toast('Saved');
  } catch (err) { toast(err.message, 'error'); renderSettings(); }
}

$('#sw-running').addEventListener('click', () => {
  const start = state.data.settings.experiment_paused;
  const nobody = state.data.users.filter((u) => !u.sees.length).length;
  saveSetting({ experiment_paused: !start }, start
    ? ['Start the study?', `All participants who sign in now get the dashboard and can use the app.${nobody ? ` ${nobody} participant(s) see nobody yet and therefore have no Community.` : ''}`, 'Start study']
    : ['Pause the study?', 'Participants immediately lose access to the app and see the waiting page. Registration stays open.', 'Pause study']);
});

$('#sw-community').addEventListener('click', () => {
  const on = state.data.settings.community_default;
  saveSetting({ community_default: !on }, on
    ? ['New participants without Community?', 'People who register from now on will not get the Community, even after you connect them, until you switch it on in their row.', 'Switch off for new']
    : ['Allow Community for new participants?', 'People who register from now on get the Community as soon as you let them see someone.', 'Allow for new']);
});

/* ------------------------------------------------------------ Table events */
$('#search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderUsers(); });
$('#filter').addEventListener('change', (e) => { state.filter = e.target.value; renderUsers(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; renderUsers(); });

$('#users').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) { openSeesDialog(edit.dataset.edit); return; }
  const sw = e.target.closest('[data-community]');
  if (!sw) return;
  const u = state.data.users.find((x) => x.id === sw.dataset.community);
  const next = !u.community_enabled;
  sw.disabled = true;
  try {
    await admin.setCommunity(u.id, next);
    u.community_enabled = next;
    u.community_active = next && u.sees.length > 0;
    toast(next
      ? (u.sees.length ? `Community on for ${fullName(u)}` : `Allowed for ${fullName(u)} – still off until they see someone`)
      : `Community off for ${fullName(u)}`);
    renderKpis(); renderUsers();
  } catch (err) { toast(err.message, 'error'); sw.disabled = false; }
});

async function bulkCommunity(enabled) {
  const rows = visibleUsers();
  const all = rows.length === state.data.users.length;
  const who = all ? `all ${rows.length} participants` : `the ${rows.length} participant(s) currently shown`;
  const ok = await confirmDialog(enabled ? 'Allow the Community?' : 'Switch the Community off?',
    enabled ? `Allow the Community for ${who}. People who see nobody still have no Community until you connect them.`
      : `Switch the Community off for ${who}. Their connections are kept.`, enabled ? 'Allow' : 'Switch off');
  if (!ok) return;
  try {
    const r = await admin.setCommunityMany(enabled, all ? undefined : rows.map((u) => u.id));
    setData(r);
    toast(r.message);
  } catch (err) { toast(err.message, 'error'); }
}
$('#bulk-on').addEventListener('click', () => bulkCommunity(true));
$('#bulk-off').addEventListener('click', () => bulkCommunity(false));

/* ------------------------------------------------------------ "Whom does X see?" dialog */
function openSeesDialog(userId) {
  const u = state.data.users.find((x) => x.id === userId);
  state.editing = { user: u, sees: new Set(u.sees) };
  $('#sees-title').textContent = `Whom does ${idLabel(u.participant_no)} · ${fullName(u)} see?`;
  $('#sees-search').value = '';
  renderSeesList();
  $('#sees-dialog').showModal();
  $('#sees-search').focus();
}

function seesCandidates() {
  const q = $('#sees-search').value.trim().toLowerCase();
  return state.data.users
    .filter((x) => x.id !== state.editing.user.id && x.participant_no != null && matches(x, q))
    .sort(SORTS.id);
}

function renderSeesList() {
  const { user: u, sees } = state.editing;
  const list = seesCandidates();
  $('#sees-list').innerHTML = list.length ? list.map((x) => {
    const back = x.sees.includes(u.participant_no);
    return `<label class="sees-option">
      <input type="checkbox" value="${x.participant_no}" ${sees.has(x.participant_no) ? 'checked' : ''}>
      <span class="id-badge">${x.participant_no}</span>
      <span class="grow" style="min-width:0"><b>${esc(fullName(x))}</b> <span class="small muted">@${esc(x.username)}</span></span>
      ${back ? `<span class="tag" title="${esc(fullName(x))} already sees ${idLabel(u.participant_no)}">sees ${idLabel(u.participant_no)}</span>` : ''}
    </label>`;
  }).join('') : '<p class="small muted">No participant matches.</p>';
  $('#sees-count').textContent = sees.size ? `${idLabel(u.participant_no)} sees ${sees.size} participant(s)` : `${idLabel(u.participant_no)} sees nobody → Community off`;
}

$('#sees-search').addEventListener('input', renderSeesList);
$('#sees-list').addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const n = Number(e.target.value);
  if (e.target.checked) state.editing.sees.add(n); else state.editing.sees.delete(n);
  renderSeesList();
});
$('#sees-all').addEventListener('click', () => { seesCandidates().forEach((x) => state.editing.sees.add(x.participant_no)); renderSeesList(); });
$('#sees-none').addEventListener('click', () => { seesCandidates().forEach((x) => state.editing.sees.delete(x.participant_no)); renderSeesList(); });
$('#sees-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const { user: u, sees } = state.editing;
  setBusy(btn, true, 'Saving…');
  try {
    setData(await admin.setVisibility(u.id, [...sees].sort((a, b) => a - b)));
    $('#sees-dialog').close();
    toast(sees.size ? `${idLabel(u.participant_no)} now sees ${sees.size} participant(s)` : `${idLabel(u.participant_no)} sees nobody now`);
  } catch (err) { toast(err.message, 'error'); }
  finally { setBusy(btn, false); }
});

/* ------------------------------------------------------------ CSV download */
const CSV = {
  participants: { exportFn: admin.exportParticipants, importFn: admin.importParticipants, label: 'Participant data' },
  network: { exportFn: admin.exportNetwork, importFn: admin.importNetwork, label: 'Network' },
};

$$('[data-download]').forEach((btn) => btn.addEventListener('click', async () => {
  setBusy(btn, true, 'Preparing…');
  try {
    const { filename, csv } = await CSV[btn.dataset.download].exportFn();
    // BOM so Excel recognises UTF-8 (umlauts in names).
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) { toast(err.message, 'error'); }
  finally { setBusy(btn, false); }
}));

/* ------------------------------------------------------------ CSV upload + preview */
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  // Excel saves CSV as UTF-8 or as Windows-1252 depending on the chosen format.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

const show = (v) => (v === true ? 'on' : v === false ? 'off' : v === null || v === undefined || v === '' ? '–' : String(v));
const FIELD_LABEL = { first_name: 'first name', last_name: 'last name', email: 'email', gender: 'gender', date_of_birth: 'date of birth', height_cm: 'height', weight_kg: 'weight', community: 'community' };

function list(items, render, max = 200) {
  return `<ul class="small change-list">${items.slice(0, max).map(render).join('')}${items.length > max ? `<li>… and ${items.length - max} more</li>` : ''}</ul>`;
}

function errorBox(r) {
  return `<div class="form-error"><b>${esc(r.message || 'The file has errors.')}</b>
    <ul class="small">${r.errors.slice(0, 25).map((x) => `<li>${typeof x === 'string' ? esc(x) : `Row ${esc(x.row)}: ${esc(x.message)}`}</li>`).join('')}${r.errors.length > 25 ? `<li>… and ${r.errors.length - 25} more</li>` : ''}</ul></div>`;
}

function previewParticipants(r) {
  const changes = r.changes || [];
  const notes = [`${changes.length} participant(s) changed`, `${r.unchanged} unchanged`, r.not_in_file ? `${r.not_in_file} not in the file (kept)` : ''].filter(Boolean).join(' · ');
  const body = changes.length ? list(changes, (c) => `<li><b>${idLabel(c.participant_no)} · ${esc(c.name)}</b>: ${Object.entries(c.fields).map(([k, v]) => `${FIELD_LABEL[k] || k} ${esc(show(v.from))} → <b>${esc(show(v.to))}</b>`).join(', ')}</li>`) : '<p class="small">The file contains no changes.</p>';
  return { notes, body, hasChanges: changes.length > 0 };
}

function previewNetwork(r) {
  const pair = (p) => `<li>${idLabel(p.viewer)} <span class="muted">${esc(p.viewer_name)}</span> → sees ${idLabel(p.target)} <span class="muted">${esc(p.target_name)}</span></li>`;
  const notes = [`${r.pairs} connection(s) in the file`, `${r.mutual} mutual`, `${r.added.length} new`, `${r.removed.length} removed`, `${r.unchanged} unchanged`].join(' · ');
  let body = '';
  if (r.added.length) body += `<h4>New</h4>${list(r.added, pair)}`;
  if (r.removed.length) body += `<h4>Removed</h4>${list(r.removed, pair)}`;
  if (!r.added.length && !r.removed.length) body += '<p class="small">The network stays the same.</p>';
  if (r.sees_nobody.length) body += `<div class="info">After the upload <b>${r.sees_nobody.length}</b> participant(s) see nobody and have no Community: ${esc(r.sees_nobody.map(idLabel).join(', '))}</div>`;
  if (r.warnings?.length) body += `<p class="small muted">${r.warnings.map((w) => `Row ${w.row}: ${esc(w.message)}`).join('<br>')}</p>`;
  return { notes, body, hasChanges: r.added.length > 0 || r.removed.length > 0 };
}

function renderPreview(kind, r, applied = false) {
  const box = $(`[data-preview="${kind}"]`);
  box.hidden = false;
  if (r.errors?.length) { box.innerHTML = errorBox(r); return; }
  const p = kind === 'network' ? previewNetwork(r) : previewParticipants(r);
  if (applied) { box.innerHTML = `<div class="info"><b>Upload saved.</b> ${esc(p.notes)}</div>`; return; }
  box.innerHTML = `
    <div class="import-box">
      <h3>Preview – nothing has been saved yet</h3>
      <p class="small muted">${esc(p.notes)}</p>
      ${p.body}
      <div class="row">
        ${p.hasChanges ? `<button type="button" class="btn btn--primary" data-apply="${kind}">Save changes</button>` : ''}
        <button type="button" class="btn" data-cancel="${kind}">${p.hasChanges ? 'Cancel' : 'Close'}</button>
      </div>
    </div>`;
}

$$('[data-upload]').forEach((input) => input.addEventListener('change', async (e) => {
  const kind = input.dataset.upload;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  $(`[data-file-name="${kind}"]`).textContent = file.name;
  try {
    state.pending[kind] = await readFileText(file);
    renderPreview(kind, await CSV[kind].importFn(state.pending[kind], true));
  } catch (err) {
    if (err.body?.errors) renderPreview(kind, err.body);
    else { $(`[data-preview="${kind}"]`).hidden = true; toast(err.message, 'error'); }
  }
}));

$$('[data-preview]').forEach((box) => box.addEventListener('click', async (e) => {
  const kind = box.dataset.preview;
  if (e.target.closest('[data-cancel]')) {
    state.pending[kind] = null; box.hidden = true; $(`[data-file-name="${kind}"]`).textContent = '';
    return;
  }
  const btn = e.target.closest('[data-apply]');
  if (!btn) return;
  setBusy(btn, true, 'Saving…');
  try {
    const r = await CSV[kind].importFn(state.pending[kind], false);
    state.pending[kind] = null;
    renderPreview(kind, r, true);
    toast(`${CSV[kind].label} saved`);
    try { setData(await admin.overview()); }
    catch { toast('Changes were saved, but the overview could not be refreshed. Reload the page.', 'error'); }
  } catch (err) {
    setBusy(btn, false);
    if (err.body?.errors) renderPreview(kind, err.body); else toast(err.message, 'error');
  }
}));

$('#refresh').addEventListener('click', load);
load();
