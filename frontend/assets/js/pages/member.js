import { community } from '../api.js';
import { initPage, $, $$, esc, fmt, toast, setBusy, formatDate, icons } from '../ui.js';

await initPage('community');

const id = new URLSearchParams(location.search).get('id');
if (!id) location.replace('community.html');
const state = { habit: 'exercise', period: 'week' };
const UNIT = { exercise: 'min', sleep: 'h', water: 'L' };
const PERIOD = { week: 'this week', month: 'last 30 days', all: 'all time' };

async function load() {
  try {
    const d = await community.member(id, state.habit, state.period);
    render(d);
  } catch (err) {
    if (err.status === 404) {
      $('#member-head').innerHTML = `<div class="stack"><h1>Member not found</h1><p class="muted">${esc(err.message)}</p><a class="btn" href="community.html" style="align-self:flex-start">Back to Community</a></div>`;
      $$('.cols, .row-between, #member-summary').forEach((el) => { el.hidden = true; });
    } else toast(err.message, 'error');
  }
}

function render(d) {
  const m = d.member;
  document.title = `${m.display_name} · Activ-Ate`;
  $('#member-head').innerHTML = `
    <div class="row" style="gap:16px;flex-wrap:nowrap">
      <span class="avatar avatar--lg" style="background:#FDE1CF;color:#7A3309">${esc(m.initials)}</span>
      <div><h1>${esc(m.display_name)}</h1><p class="lead">In your network · ${m.sports.map(esc).join(', ')}</p></div>
    </div>`;
  const habitName = { exercise: 'Exercise', sleep: 'Sleep', water: 'Water' }[d.habit];
  $('#member-summary').innerHTML = `
    <div class="stack" style="gap:4px"><span class="kpi-label">Joined</span><span class="num" style="font-size:22px">${formatDate(m.joined, { month: 'short', year: 'numeric' })}</span></div>
    <div class="stack" style="gap:4px"><span class="kpi-label">Current streak · ${habitName}</span><span class="num" style="font-size:22px">${m.streak} days</span></div>
    <div class="stack" style="gap:4px"><span class="kpi-label">Network rank · ${habitName}</span><span class="num" style="font-size:22px">#${m.rank}</span></div>
    <div class="stack" style="gap:4px"><span class="kpi-label">Cheers this week</span><span class="num" style="font-size:22px">${d.cheer_count}</span></div>`;

  // Activity log
  $('#log-title').textContent = `Recent activity · ${habitName}`;
  $('#their-target').innerHTML = `${esc(m.display_name)}'s target: <b>${esc(d.targets.member)}</b>`;
  const ex = d.habit === 'exercise';
  $('#log').innerHTML = `<div class="tr th"><span>Date</span><span>${ex ? 'Sport' : 'Total'}</span><span>${ex ? 'Duration' : 'Status'}</span></div>` +
    d.log.map((l) => `<div class="tr"><b>${formatDate(l.date)}</b><span>${ex ? esc(l.label) : `${fmt(l.value, 1)} ${l.unit === 'h' ? 'hours' : 'liters'}`}</span>${ex ? `<span>${l.value} min</span>` : (l.met
      ? `<span class="status-pass"><span class="icon-box" style="width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff">${icons.check}</span>Target met</span>`
      : `<span class="status-fail"><span class="icon-box" style="width:24px;height:24px;border-radius:50%;background:#C2410C;color:#fff">${icons.x}</span>Missed</span>`)}</div>`).join('');

  // Comparison
  $('#compare-title').textContent = `Direct comparison · ${PERIOD[d.period]}`;
  $('#t-them-label').textContent = `${m.display_name}'s target`;
  $('#t-them').textContent = d.targets.member;
  $('#t-me').textContent = d.targets.me;
  $('#name-them').textContent = m.display_name;
  const max = Math.max(d.totals.member, d.totals.me, 1);
  const digits = d.habit === 'exercise' ? 0 : 1;
  $('#compare').innerHTML = `
    <div class="col"><span class="num" style="font-size:20px">${fmt(d.totals.member, digits)} ${UNIT[d.habit]}</span><div class="cbar cbar--them" style="height:${Math.max(4, Math.round((d.totals.member / max) * 190))}px"></div></div>
    <div class="col"><span class="num" style="font-size:20px">${fmt(d.totals.me, digits)} ${UNIT[d.habit]}</span><div class="cbar cbar--me" style="height:${Math.max(4, Math.round((d.totals.me / max) * 190))}px"></div></div>`;
  const diff = d.totals.member - d.totals.me;
  $('#compare-text').textContent = diff > 0 ? `${m.display_name} is ahead by ${fmt(diff, digits)} ${UNIT[d.habit]} (${PERIOD[d.period]}).` : diff < 0 ? `You are ahead by ${fmt(-diff, digits)} ${UNIT[d.habit]} (${PERIOD[d.period]}).` : 'You are exactly level.';

  // Cheer card – the only social action
  const first = m.display_name;
  $('#cheer-card').innerHTML = d.goal_reached
    ? `<h2>${esc(first)} reached the goal</h2><p class="small muted">${esc(first)} hit the ${habitName.toLowerCase()} target this week. ${d.cheered_by_me ? 'You already cheered.' : 'Send a cheer to keep the motivation up.'}</p>
       ${d.can_cheer ? `<button type="button" class="btn btn--primary" id="cheer" style="align-self:flex-start">${icons.clap}Cheer ${esc(first)}</button>` : `<span class="small" style="color:var(--brand);font-weight:700">Cheered ✓ · ${d.cheer_count} cheers</span>`}`
    : `<h2>Cheering</h2><p class="small muted">You can cheer for ${esc(first)} as soon as the ${habitName.toLowerCase()} goal for this week is reached.</p>`;
  const btn = $('#cheer');
  if (btn) btn.addEventListener('click', async () => {
    setBusy(btn, true);
    try { await community.cheer(m.id, d.habit); toast(`You cheered for ${first}`); load(); }
    catch (err) { setBusy(btn, false); toast(err.message, 'error'); }
  });
}

$$('#habits [data-habit]').forEach((b) => b.addEventListener('click', () => {
  state.habit = b.dataset.habit;
  $$('#habits [data-habit]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  load();
}));
$$('#periods [data-period]').forEach((b) => b.addEventListener('click', () => {
  state.period = b.dataset.period;
  $$('#periods [data-period]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  load();
}));
load();
