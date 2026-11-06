import { dashboard, recommendations, workouts, community, me as meApi } from '../api.js';
import { initPage, $, $$, esc, fmt, pct, track, todayISO, formatDate, relativeDay, toast, setBusy, clearErrors, showError, icons } from '../ui.js';
import { mountWorkoutForm } from '../components/workout-form.js';

const user = await initPage('dashboard');
const hour = new Date().getHours();
$('#greeting').textContent = `${hour < 11 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user.first_name}`;
$('#today-label').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
$('#checkin-date').textContent = 'Today';

/* ----------------------------------------------------------- Render */
function renderKpis(d) {
  const w = d.week || { minutes: 0, target_minutes: 150, sessions_done: 0, sessions_planned: 0 };
  const t = d.today || {};
  $('#kpis').innerHTML = `
    <div class="kpi"><span class="kpi-label">Exercise minutes</span><span class="kpi-value">${fmt(w.minutes)} <small>/ ${fmt(w.target_minutes)}</small></span>${track(w.minutes, w.target_minutes)}</div>
    <div class="kpi"><span class="kpi-label">Sessions this week</span><span class="kpi-value">${w.sessions_done} <small>/ ${w.sessions_planned}</small></span>${track(w.sessions_done, w.sessions_planned)}</div>
    <div class="kpi"><span class="kpi-label">Calories today</span><span class="kpi-value">${fmt(t.kcal)} <small>/ ${fmt(t.kcal_target)}</small></span>${track(t.kcal, t.kcal_target, true)}</div>
    <div class="kpi"><span class="kpi-label">Protein today</span><span class="kpi-value">${fmt(t.protein_g)} <small>/ ${fmt(t.protein_target_g)} g</small></span>${track(t.protein_g, t.protein_target_g, true)}</div>
    <div class="kpi"><span class="kpi-label">Streak</span><span class="kpi-value">${d.streak.current} <small>days</small></span><span class="kpi-note kpi-note--warm">Personal best: ${d.streak.best} days</span></div>`;
  const left = w.sessions_planned - w.sessions_done;
  $('#headline').textContent = left > 0 ? `${left} more session${left > 1 ? 's' : ''} to hit your weekly plan.` : 'All planned sessions done this week – great work!';
}

function renderWeek(days) {
  days = Array.isArray(days) ? days : [];
  const max = Math.max(60, ...days.map((x) => x.minutes || 0));
  const t = todayISO();
  $('#week-chart').innerHTML = `<div class="bars" style="grid-template-columns:repeat(7,minmax(0,1fr))">${days.map((x) => {
    const isToday = x.date === t; const v = x.minutes;
    const h = v ? Math.max(6, Math.round((v / max) * 140)) : 4;
    return `<div class="bar-col"><span class="bar-val">${v === null ? '–' : v}</span><div class="bar${isToday ? ' bar--today' : ''}${!v ? ' bar--empty' : ''}" style="height:${h}px" title="${v ?? 0} min"></div><span class="bar-lbl">${isToday ? 'Today' : formatDate(x.date, { weekday: 'short' })}</span></div>`;
  }).join('')}</div>`;
}

function renderGoals(list) {
  $('#goal-list').innerHTML = list.length ? list.map((g) => `
    <div class="stack" style="gap:8px">
      <div class="row-between small"><b>${esc(g.label)}</b><span class="muted" style="font-weight:600">${g.done} / ${g.target} ${esc(g.unit)}${g.done >= g.target ? ' ✓' : ''}</span></div>
      ${track(g.done, g.target, g.kind === 'nutrition')}
    </div>`).join('') : '<div class="empty">No goals yet. <a href="goals.html">Set your goals</a></div>';
}

function workoutRow(w) {
  const cardio = !!w.distance_km || /run|cycl|swim|walk|hik|row/i.test(w.sport);
  return `<div class="list-row">
    <span class="icon-box${cardio ? ' icon-box--warm' : ''}">${cardio ? icons.run : icons.dumbbell}</span>
    <span class="grow"><span class="title">${esc(w.sport)}${w.title ? ' – ' + esc(w.title) : ''}</span><br><span class="meta">${relativeDay(w.performed_on)} · ${w.duration_min} min${w.distance_km ? ' · ' + fmt(w.distance_km, 1) + ' km' : ''} · ${esc(w.intensity)}</span></span>
    <span class="num nowrap">${fmt(w.kcal)} kcal</span></div>`;
}
function renderRecent(list) {
  $('#recent').innerHTML = list.length ? list.map(workoutRow).join('') : '<div class="empty">No workouts yet – log your first one!</div>';
}

function renderNetwork(rows, note) {
  $('#network-top').innerHTML = rows.map((r) => `
    <div class="row" style="padding:8px;border-radius:10px;${r.is_me ? 'background:var(--brand-tint)' : ''}">
      <span class="num" style="width:20px;color:var(--ink-2)">${r.rank}</span>
      <span class="avatar${r.is_me ? ' avatar--me' : ''}">${esc(r.initials)}</span>
      ${r.is_me ? '<b class="grow">You</b>' : `<a class="grow" style="font-weight:600;color:var(--ink)" href="member.html?id=${encodeURIComponent(r.member_id)}">${esc(r.display_name)}</a>`}
      <span class="num">${fmt(r.value)} min</span>
    </div>`).join('');
  $('#network-note').textContent = note;
}

function feedRow(f) {
  return `<div class="row" style="align-items:flex-start;flex-wrap:nowrap">
    <span class="avatar" style="width:32px;height:32px;font-size:12px">${esc(f.initials)}</span>
    <div class="stack grow" style="gap:6px"><span class="small"><b>${esc(f.display_name)}</b> ${esc(f.text)}</span>
      ${f.can_cheer
        ? `<button type="button" class="btn btn--small" style="align-self:flex-start" data-cheer="${esc(f.member_id)}" data-habit="${esc(f.habit)}">${icons.clap}Cheer</button>`
        : `<span class="small" style="color:var(--brand);font-weight:600">${f.cheered_by_me ? 'You cheered ✓' : ''} ${f.cheer_count ? `· ${f.cheer_count} cheers` : ''}</span>`}
    </div></div>`;
}
function renderFeed(items) {
  $('#feed').innerHTML = items.length ? items.map(feedRow).join('') : '<div class="empty">No achievements in your network yet this week.</div>';
}
$('#feed').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cheer]');
  if (!b) return;
  setBusy(b, true);
  try {
    const res = await community.cheer(b.dataset.cheer, b.dataset.habit);
    b.outerHTML = `<span class="small" style="color:var(--brand);font-weight:600">You cheered ✓ · ${res.cheer_count} cheers</span>`;
  } catch (err) { setBusy(b, false); toast(err.message, 'error'); }
});

/* ----------------------------------------------------------- AI card */
async function loadAi() {
  const host = $('#ai-daily');
  try {
    const r = await recommendations.daily();
    host.innerHTML = `
      <div class="stack" style="gap:6px"><span class="ai-tag">Workout</span><p class="muted" style="line-height:1.55">${esc(r.workout)}</p></div>
      <div class="stack" style="gap:6px"><span class="ai-tag ai-tag--warm">Nutrition</span><p class="muted" style="line-height:1.55">${esc(r.nutrition)}</p></div>
      <div class="row">
        ${r.suggested_session ? '<button type="button" class="btn btn--mint" id="add-plan">Add to my plan</button>' : ''}
        <a class="btn btn--ghost-dark" href="coach.html">Ask AI Coach</a>
      </div>`;
    const add = $('#add-plan');
    if (add) add.addEventListener('click', async () => {
      const s = r.suggested_session;
      setBusy(add, true);
      try {
        await workouts.create({ sport: s.sport, sport_id: s.sport_id, performed_on: s.date, duration_min: s.duration_min, intensity: 'medium', status: 'planned', title: 'Suggested by AI Coach' });
        add.outerHTML = '<span class="small" style="color:var(--mint);font-weight:700">Added to your plan ✓</span>';
        toast(`${s.sport} added to ${formatDate(s.date, { weekday: 'long' })}`);
      } catch (err) { setBusy(add, false); toast(err.message, 'error'); }
    });
  } catch (err) {
    host.innerHTML = `<p class="muted">Advice is not available right now. ${esc(err.message)}</p>`;
  }
}

/* ----------------------------------------------------------- Check-in */
const checkin = $('#checkin');
$$('[data-water]', checkin).forEach((b) => b.addEventListener('click', () => {
  const cur = Number(checkin.water_l.value || 0);
  checkin.water_l.value = Math.round((cur + Number(b.dataset.water)) * 100) / 100;
}));
checkin.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(checkin);
  const btn = $('[type="submit"]', checkin);
  setBusy(btn, true);
  try {
    await dashboard.saveDailyLog({ date: todayISO(), sleep_hours: checkin.sleep_hours.value === '' ? null : Number(checkin.sleep_hours.value), water_l: checkin.water_l.value === '' ? null : Number(checkin.water_l.value) });
    toast('Check-in saved');
    load();
  } catch (err) { showError(checkin, err); } finally { setBusy(btn, false); }
});

/* ----------------------------------------------------------- Workout dialog */
const dialog = $('#workout-dialog');
const targets = await meApi.getTargets().catch(() => ({ sports: user.sports || [] }));
const wf = mountWorkoutForm($('#workout-form-host'), {
  sports: targets.sports || [],
  onCancel: () => dialog.close(),
  onSaved: (res) => {
    dialog.close();
    toast(`${res.workout.sport} · ${res.workout.duration_min} min saved`);
    load();
  },
});
$('#open-workout').addEventListener('click', () => { dialog.showModal(); wf.focus(); });
$('#close-workout').addEventListener('click', () => dialog.close());

/* ----------------------------------------------------------- Load */
async function load() {
  try {
    const d = await dashboard.get(todayISO());
    renderKpis(d); renderWeek(d.days); renderGoals(d.goal_progress); renderRecent(d.recent_workouts);
    renderNetwork(d.network_top, d.network_note); renderFeed(d.feed);
    if (d.today.sleep_hours !== null && document.activeElement !== checkin.sleep_hours) checkin.sleep_hours.value = d.today.sleep_hours;
    if (d.today.water_l !== null && document.activeElement !== checkin.water_l) checkin.water_l.value = d.today.water_l;
  } catch (err) { toast(err.message, 'error'); }
}
load();
loadAi();
