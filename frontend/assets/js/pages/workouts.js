import { workouts, recommendations, me as meApi } from '../api.js';
import { initPage, $, esc, fmt, track, relativeDay, formatDate, todayISO, addDaysISO, toast, setBusy, icons } from '../ui.js';
import { mountWorkoutForm } from '../components/workout-form.js';

await initPage('workouts');
const targets = await meApi.getTargets().catch(() => ({ sports: [] }));

let filter = '';
let selectedWeek = weekStart(todayISO());
let requestId = 0;

function weekStart(date) {
  const day = new Date(date + 'T12:00:00').getDay();
  return addDaysISO(date, -((day + 6) % 7));
}
function setWeek(date) {
  const current = weekStart(todayISO());
  selectedWeek = weekStart(date);
  if (selectedWeek > current) selectedWeek = current;
  $('#week').value = selectedWeek;
  $('#week').max = todayISO();
  $('#next-week').disabled = selectedWeek >= current;
  $('#week-label').textContent = `${selectedWeek === current ? 'This week: ' : 'Week: '}${formatDate(selectedWeek, { day: 'numeric', month: 'short', year: 'numeric' })} – ${formatDate(addDaysISO(selectedWeek, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`;
  $('#by-sport-title').textContent = selectedWeek === current ? 'This week by sport' : 'Selected week by sport';
  refreshWeek();
}
$('#prev-week').addEventListener('click', () => setWeek(addDaysISO(selectedWeek, -7)));
$('#next-week').addEventListener('click', () => setWeek(addDaysISO(selectedWeek, 7)));
$('#week').addEventListener('change', (e) => { if (e.target.value) setWeek(e.target.value); });

async function refreshWeek() {
  const id = ++requestId;
  const start = selectedWeek;
  $('#history').innerHTML = '<div class="skeleton" style="height:120px"></div>';
  $('#kpis').innerHTML = '<div class="skeleton" style="height:90px"></div>';
  $('#by-sport').innerHTML = '<div class="skeleton" style="height:80px"></div>';
  try {
    const [stats, items] = await Promise.all([workouts.stats(8), loadWeekWorkouts(start)]);
    if (id !== requestId) return;
    renderStats(stats, items);
    renderHistory(items);
  } catch (err) { if (id === requestId) toast(err.message, 'error'); }
}
async function loadWeekWorkouts(start) {
  const end = addDaysISO(start, 6);
  let cursor = null;
  const items = [];
  do {
    const page = await workouts.list({ limit: 100, cursor });
    items.push(...page.items.filter((w) => w.performed_on >= start && w.performed_on <= end));
    cursor = page.items.some((w) => w.performed_on < start) ? null : page.next_cursor;
  } while (cursor);
  return items;
}
let weekWorkouts = [];

mountWorkoutForm($('#form-host'), {
  sports: targets.sports || [],
  onSaved: (res) => {
    toast(`${res.workout.sport} · ${res.workout.duration_min} min saved`);
    filter = '';
    refreshWeek(); loadAi();
  },
});
if (location.hash === '#log') $('#wf-sport').focus();

/* ----------------------------------------------------------- Stats */
function renderStats(s, items) {
  weekWorkouts = items;
  const done = items.filter((x) => x.status === 'done');
  const weeks = Array.isArray(s.weeks) ? s.weeks : [];
  const w = { ...(s.week || { target_minutes: s.target_minutes || 150, sessions_planned: 0 }), minutes: done.reduce((sum, x) => sum + Number(x.duration_min || 0), 0), sessions_done: done.length };
  const strength = (Array.isArray(s.goal_progress) ? s.goal_progress : []).map((g) => ({ ...g, done: done.filter((x) => x.sport.toLowerCase() === g.label.split(' · ')[0].toLowerCase()).length }));
  const sportMinutes = new Map();
  done.forEach((x) => sportMinutes.set(x.sport, (sportMinutes.get(x.sport) || 0) + Number(x.duration_min || 0)));
  const bySport = [...sportMinutes].map(([sport, minutes]) => ({ sport, minutes })).sort((a, b) => b.minutes - a.minutes);
  const personalBests = Array.isArray(s.personal_bests) ? s.personal_bests : [];
  $('#kpis').innerHTML = `
    <div class="kpi"><span class="kpi-label">Minutes in selected week</span><span class="kpi-value">${fmt(w.minutes)} <small>/ ${fmt(w.target_minutes)}</small></span>${track(w.minutes, w.target_minutes)}</div>
    <div class="kpi"><span class="kpi-label">Sessions in selected week</span><span class="kpi-value">${w.sessions_done} <small>/ ${w.sessions_planned}</small></span>${track(w.sessions_done, w.sessions_planned)}</div>
    ${strength.slice(0, 2).map((g) => `<div class="kpi"><span class="kpi-label">${esc(g.label.split(' · ')[0])} goal</span><span class="kpi-value">${g.done} <small>/ ${g.target} sessions</small></span>${track(g.done, g.target)}</div>`).join('')}`;

  const target = Number(s.target_minutes || w.target_minutes || 150);
  const max = Math.max(target * 1.15, ...weeks.map((x) => Number(x.minutes) || 0), 1);
  const H = 160;
  $('#target-label').textContent = `Target ${fmt(target)} min`;
  $('#weeks-chart').innerHTML = `<div class="bars" style="grid-template-columns:repeat(${weeks.length || 1},minmax(0,1fr));height:${H + 50}px">
    <div class="target-line" style="bottom:${Math.round((target / max) * H) + 24}px"></div>
    ${weeks.map((x, i) => {
      const minutes = Number(x.minutes) || 0;
      const last = i === weeks.length - 1;
      return `<div class="bar-col"><span class="bar-val">${minutes}</span><div class="bar${last ? ' bar--hl' : ''}" style="height:${Math.max(4, Math.round((minutes / max) * H))}px" title="Week of ${formatDate(x.week_start)}: ${minutes} min"></div><span class="bar-lbl">${last ? 'Now' : formatDate(x.week_start, { day: 'numeric', month: 'short' })}</span></div>`;
    }).join('')}</div>`;
  const prev = weeks.slice(-5, -1).reduce((a, x) => a + (Number(x.minutes) || 0), 0) / 4;
  const prev2 = weeks.slice(0, 4).reduce((a, x) => a + (Number(x.minutes) || 0), 0) / 4;
  $('#weeks-note').textContent = prev2 ? `Average of the last 4 full weeks: ${Math.round(prev)} min (${prev >= prev2 ? '+' : ''}${Math.round(((prev - prev2) / prev2) * 100)} % vs. the 4 weeks before).` : '';

  const maxS = Math.max(1, ...bySport.map((x) => Number(x.minutes) || 0));
  $('#by-sport').innerHTML = bySport.length ? bySport.map((x, i) => `
    <div class="stack" style="gap:6px"><div class="row-between small"><b>${esc(x.sport)}</b><span class="muted">${x.minutes} min</span></div>
    <div class="track track--thick${i ? ' track--warm' : ''}"><span style="width:${Math.round((x.minutes / maxS) * 100)}%"></span></div></div>`).join('') : '<div class="empty">Nothing logged in this week.</div>';

  $('#pbs').innerHTML = personalBests.length ? personalBests.map((p) => `
    <div class="row-between small" style="padding:8px 0;border-bottom:1px solid var(--line-2)"><span>${esc(p.label)}<br><span class="muted">${esc(p.detail || '')}</span></span><span class="num" style="font-size:15px">${esc(p.value)}</span></div>`).join('') : '<div class="empty">Log workouts to see your records.</div>';

  // Filter chips from the user's own sports + sports in this week's data
  const names = [...new Set([...(targets.sports || []).map((x) => x.name), ...items.map((x) => x.sport)])];
  $('#filters').innerHTML = [['', 'All'], ...names.map((n) => [n, n])].map(([v, l]) => `<button type="button" class="chip btn--small" style="min-height:36px" data-f="${esc(v)}" aria-pressed="${v === filter}">${esc(l)}</button>`).join('');
}
$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  filter = b.dataset.f;
  $('#filters').querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderHistory(weekWorkouts);
});

/* ----------------------------------------------------------- History */
function row(w) {
  const cardio = !!w.distance_km || /run|cycl|swim|walk|hik|row/i.test(w.sport);
  return `<div class="list-row" data-id="${esc(w.id)}">
    <span class="icon-box${cardio ? ' icon-box--warm' : ''}">${cardio ? icons.run : icons.dumbbell}</span>
    <span class="grow"><span class="title">${esc(w.sport)}${w.title ? ' – ' + esc(w.title) : ''}</span>${w.status === 'planned' ? ' <span class="tag tag--warm">Planned</span>' : ''}<br>
      <span class="meta">${relativeDay(w.performed_on)} · ${w.duration_min} min${w.distance_km ? ' · ' + fmt(w.distance_km, 1) + ' km' : ''} · ${esc(w.intensity)}${w.notes ? ' · ' + esc(w.notes) : ''}</span></span>
    <span class="num nowrap">${fmt(w.kcal)} kcal</span>
    ${w.status === 'planned' ? `<button type="button" class="btn btn--small" data-done="${esc(w.id)}">Mark done</button>` : ''}
    <button type="button" class="btn btn--icon btn--small" data-del="${esc(w.id)}" aria-label="Delete workout">${icons.trash}</button>
  </div>`;
}
function renderHistory(items) {
  const visible = filter ? items.filter((w) => w.sport.toLowerCase() === filter.toLowerCase()) : items;
  $('#history').innerHTML = visible.map(row).join('') || '<div class="empty">No workouts found for this week.</div>';
  $('#load-more').hidden = true;
}
$('#history').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const done = e.target.closest('[data-done]');
  if (del) {
    if (!confirm('Delete this workout?')) return;
    setBusy(del, true);
    try { await workouts.remove(del.dataset.del); toast('Workout deleted'); refreshWeek(); }
    catch (err) { setBusy(del, false); toast(err.message, 'error'); }
  }
  if (done) {
    setBusy(done, true);
    try { await workouts.update(done.dataset.done, { status: 'done' }); toast('Marked as done'); refreshWeek(); }
    catch (err) { setBusy(done, false); toast(err.message, 'error'); }
  }
});

/* ----------------------------------------------------------- AI */
async function loadAi() {
  try {
    const r = await recommendations.workout();
    $('#ai-workout').innerHTML = `<p class="muted" style="line-height:1.55">${esc(r.text)}</p>
      ${(r.tips || []).map((t) => `<div class="row small muted" style="flex-wrap:nowrap;align-items:flex-start"><span style="color:var(--mint);font-weight:700">•</span>${esc(t)}</div>`).join('')}`;
  } catch (err) { $('#ai-workout').innerHTML = `<p class="muted">Insight not available right now.</p>`; }
}

setWeek(todayISO());
loadAi();
