/**
 * Community: members are assigned automatically to a network (no friend requests, no messaging).
 * The only social action is a "cheer" for a member who reached their goal.
 */
import { community } from '../api.js';
import { initPage, $, $$, esc, fmt, pct, toast, setBusy, formatDate, todayISO, addDaysISO, icons } from '../ui.js';

await initPage('community');

const state = { habit: 'exercise', sort: 'rank', q: '', data: null };
const monday = (() => { const d = new Date(); const back = (d.getDay() + 6) % 7; return addDaysISO(todayISO(), -back); })();
$('#week-label').textContent = `This week · ${formatDate(monday, { day: 'numeric', month: 'short' })} – ${formatDate(addDaysISO(monday, 6), { day: 'numeric', month: 'short' })}`;

const UNIT = { exercise: 'min', sleep: 'h', water: 'L' };
const TITLE = { exercise: 'Exercise minutes', sleep: 'Sleep', water: 'Water' };
const val = (v, h) => `${fmt(v, h === 'exercise' ? 0 : 1)} ${UNIT[h]}`;

/* ----------------------------------------------------------- Network card */
community.network().then((n) => {
  $('#network-expl').textContent = n.explanation;
  $('#network-criteria').innerHTML = n.criteria.map((c) => `<span class="chip" style="cursor:default">${esc(c.label)}: ${esc(c.value)}</span>`).join('') +
    `<span class="chip" style="cursor:default">${n.member_count} members</span>`;
}).catch(() => {});

/* ----------------------------------------------------------- Leaderboard */
async function load() {
  $('#board').innerHTML = '<div class="skeleton" style="height:300px;margin:0 24px 16px"></div>';
  try {
    state.data = await community.leaderboard(state.habit, 'week');
    render();
  } catch (err) { toast(err.message, 'error'); }
  loadInsights();
}

function render() {
  const d = state.data; const h = state.habit; const s = d.summary;
  $('#summary').innerHTML = `
    <div class="kpi"><span class="kpi-label">Your rank</span><span class="kpi-value">#${s.my_rank} <small>of ${s.member_count}</small></span></div>
    <div class="kpi"><span class="kpi-label">Top streak</span><span class="kpi-value">${s.top_streak.days} days <small>· ${esc(s.top_streak.display_name)}</small></span></div>
    <div class="kpi"><span class="kpi-label">Gap to #1</span><span class="kpi-value">${s.gap_to_first ? `${fmt(s.gap_to_first, h === 'water' ? 1 : 0)} <small>${esc(s.gap_unit)}</small>` : 'You lead!'}</span></div>`;
  $('#table-title').textContent = `Habit comparison · ${TITLE[h]}`;
  $('#target-label').textContent = h === 'exercise' ? 'Progress = minutes vs. each member\'s weekly target' : `Progress = this week vs. daily target × days so far`;

  let rows = d.rows.slice();
  if (state.sort === 'streak') rows.sort((a, b) => b.streak - a.streak);
  if (state.sort === 'improved') rows.sort((a, b) => b.change_pct - a.change_pct);
  if (state.sort === 'active') rows = rows.filter((r) => r.active_today || r.is_me);
  if (state.sort === 'goal') rows = rows.filter((r) => r.goal_reached || r.is_me);
  if (state.q) rows = rows.filter((r) => r.is_me || r.display_name.toLowerCase().includes(state.q));

  const head = `<div class="tr th"><span>Rank</span><span>Member</span><span>Progress to target</span><span>${h === 'exercise' ? 'This week' : h === 'sleep' ? 'Hours this week' : 'Liters this week'}</span><span>Streak</span><span>vs. You</span><span>Cheer</span></div>`;
  $('#board').innerHTML = head + rows.map((r) => {
    const vs = r.is_me ? '–' : (h === 'sleep' ? `${r.vs_me > 0 ? '+' : ''}${r.vs_me} days` : `${r.vs_me > 0 ? '+' : ''}${fmt(r.vs_me, h === 'exercise' ? 0 : 1)} ${UNIT[h]}`);
    const vsColor = r.is_me ? 'var(--ink-2)' : r.vs_me > 0 ? 'var(--orange-ink)' : 'var(--brand)';
    let cheer = '';
    if (r.is_me) cheer = r.goal_reached ? `<span class="small" style="color:var(--brand);font-weight:600">${r.cheer_count} cheers</span>` : '';
    else if (r.can_cheer) cheer = `<button type="button" class="btn btn--small" data-cheer="${esc(r.member_id)}">${icons.clap}Cheer</button>`;
    else if (r.cheered_by_me) cheer = `<span class="small" style="color:var(--brand);font-weight:600">Cheered ✓</span>`;
    else cheer = `<span class="small muted" title="Cheering opens once the goal is reached">–</span>`;
    return `<div class="tr${r.is_me ? ' is-me' : ''}">
      <span class="rank">${r.rank}</span>
      <span class="row" style="gap:10px;flex-wrap:nowrap;min-width:0">
        <span class="avatar${r.is_me ? ' avatar--me' : ''}" style="width:32px;height:32px;font-size:12px">${esc(r.initials)}</span>
        ${r.is_me ? '<b>You</b>' : `<a href="member.html?id=${encodeURIComponent(r.member_id)}" style="font-weight:600;color:var(--ink)">${esc(r.display_name)}</a>`}
        ${r.active_today ? '<span class="dot-active" title="Active today"></span>' : ''}
        ${r.goal_reached ? '<span class="tag tag--brand" title="Goal reached">Goal ✓</span>' : ''}
      </span>
      <span><div class="track track--thick${r.is_me ? '' : ' track--warm'}" style="max-width:160px"><span style="width:${pct(r.value, r.target)}%"></span></div></span>
      <b>${val(r.value, h)}${state.sort === 'improved' ? ` <span class="small muted">(${r.change_pct > 0 ? '+' : ''}${r.change_pct} %)</span>` : ''}</b>
      <span>${r.streak} days</span>
      <span style="font-weight:600;color:${vsColor}">${vs}</span>
      <span>${cheer}</span>
    </div>`;
  }).join('') + (rows.length <= 1 && state.q ? `<p class="muted" style="padding:16px 24px">No member matches “${esc(state.q)}”.</p>` : '');
}

$('#board').addEventListener('click', (e) => cheer(e, () => load()));
async function cheer(e, after) {
  const b = e.target.closest('[data-cheer]');
  if (!b) return;
  setBusy(b, true);
  try {
    await community.cheer(b.dataset.cheer, b.dataset.habit || state.habit);
    toast('Cheer sent');
    after();
  } catch (err) { setBusy(b, false); toast(err.message, 'error'); }
}

$$('#habits [data-habit]').forEach((b) => b.addEventListener('click', () => {
  state.habit = b.dataset.habit;
  $$('#habits [data-habit]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  load();
}));
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
$('#search').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); if (state.data) render(); });

/* ----------------------------------------------------------- Insights & feed */
async function loadInsights() {
  try {
    const r = await community.insights(state.habit);
    $('#insights').innerHTML = r.items.map((i) => `
      <div class="stack" style="gap:10px;padding:14px;border-radius:12px;background:var(--side-2)">
        <p class="small" style="line-height:1.5;color:#D3DED9">${esc(i.text)}</p>
        ${i.action === 'cheer' ? `<button type="button" class="btn btn--mint btn--small" style="align-self:flex-start" data-cheer="${esc(i.member_id)}">${icons.clap}Send a cheer</button>` : ''}
      </div>`).join('');
  } catch { $('#insights').innerHTML = '<p class="muted small">Insights not available right now.</p>'; }
}
$('#insights').addEventListener('click', (e) => cheer(e, () => load()));

async function loadFeed() {
  try {
    const { items } = await community.feed(8);
    $('#feed').innerHTML = items.length ? items.map((f) => `
      <div class="row" style="flex-wrap:nowrap;align-items:flex-start">
        <span class="avatar" style="width:32px;height:32px;font-size:12px">${esc(f.initials)}</span>
        <div class="stack grow" style="gap:6px"><span class="small"><a href="member.html?id=${encodeURIComponent(f.member_id)}" style="font-weight:700;color:var(--ink)">${esc(f.display_name)}</a> ${esc(f.text)}</span>
          ${f.can_cheer ? `<button type="button" class="btn btn--small" style="align-self:flex-start" data-cheer="${esc(f.member_id)}" data-habit="${esc(f.habit)}">${icons.clap}Cheer</button>` : `<span class="small" style="color:var(--brand);font-weight:600">${f.cheered_by_me ? 'You cheered ✓ · ' : ''}${f.cheer_count} cheers</span>`}
        </div></div>`).join('') : '<div class="empty">No achievements yet this week.</div>';
  } catch { /* ignore */ }
}
$('#feed').addEventListener('click', (e) => cheer(e, () => { loadFeed(); load(); }));

load();
loadFeed();
