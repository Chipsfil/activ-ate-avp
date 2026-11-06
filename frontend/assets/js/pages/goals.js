/**
 * Goals: everything is edited locally, then saved with one PUT /me/targets.
 * The goal check (POST /goals/check) is rule-based on the backend and called debounced.
 */
import { me as meApi } from '../api.js';
import { initPage, $, esc, fmt, track, debounce, toast, setBusy, todayISO } from '../ui.js';
import { sportCombobox } from '../components/sport-combobox.js';

await initPage('goals');

const GOALS = [
  { id: 'lose_weight', label: 'Lose weight', desc: 'Calorie deficit + more activity' },
  { id: 'gain_muscle', label: 'Gain muscle', desc: 'Strength training + protein' },
  { id: 'improve_stamina', label: 'Improve stamina', desc: 'Endurance training' },
];
const NUT = {
  calories: { label: 'Calories', unit: 'kcal', verb: 'Eat about', def: 2200 },
  protein: { label: 'Protein', unit: 'g', verb: 'Eat', def: 120 },
  water: { label: 'Water', unit: 'L', verb: 'Drink', def: 2 },
  carbs: { label: 'Carbohydrates', unit: 'g', verb: 'Eat', def: 280 },
  fat: { label: 'Fat', unit: 'g', verb: 'Eat', def: 70 },
  fiber: { label: 'Fiber', unit: 'g', verb: 'Eat', def: 30 },
  sugar: { label: 'Added sugar', unit: 'g', verb: 'Max.', def: 35 },
};

let s = null;          // working copy
let dirty = false;
const saveBtn = $('#save');
function markDirty() { dirty = true; saveBtn.disabled = false; saveBtn.textContent = 'Save changes'; check(); }
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ----------------------------------------------------------- Render */
function renderMain() {
  $('#main-goals').innerHTML = GOALS.map((g) => `
    <button type="button" class="goal-card" data-goal="${g.id}" aria-pressed="${s.goals.includes(g.id)}">
      <span class="t">${g.label}<span class="check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg></span></span>
      <span class="d">${g.desc}</span></button>`).join('');
}
function renderSports() {
  $('#sport-chips').innerHTML = s.sports.map((x, i) => `<span class="chip chip--removable">${esc(x.name)}<button type="button" data-rm-sport="${i}" aria-label="Remove ${esc(x.name)}">×</button></span>`).join('') || '<span class="small muted">No sports yet.</span>';
}
const freq = (n) => (n === 7 ? 'every day' : `${n} ${n === 1 ? 'time' : 'times'} a week`);
function renderActs() {
  $('#acts').innerHTML = s.activity_goals.map((g, i) => `
    <div class="goal-row">
      <span class="grow" style="min-width:180px"><b>${esc(g.sport)}</b><br><span class="small muted">${g.minutes_per_session} min, ${freq(g.sessions_per_week)} · ${g.minutes_per_session * g.sessions_per_week} min/week</span></span>
      <span class="stepper small muted">Min <button type="button" data-a="${i}" data-k="m" data-d="-5" aria-label="Less minutes">−</button><output>${g.minutes_per_session}</output><button type="button" data-a="${i}" data-k="m" data-d="5" aria-label="More minutes">+</button></span>
      <span class="stepper small muted">×/week <button type="button" data-a="${i}" data-k="t" data-d="-1" aria-label="Fewer times">−</button><output>${g.sessions_per_week}</output><button type="button" data-a="${i}" data-k="t" data-d="1" aria-label="More times">+</button></span>
      <button type="button" class="btn btn--icon btn--small" data-rm-act="${i}" aria-label="Remove goal">×</button>
    </div>`).join('') || '<div class="empty">No activity goals.</div>';
  const mins = s.activity_goals.reduce((a, g) => a + g.minutes_per_session * g.sessions_per_week, 0);
  const ses = s.activity_goals.reduce((a, g) => a + g.sessions_per_week, 0);
  $('#weekly-total').textContent = `${ses} sessions · ${mins} min / week`;
}
function renderNuts() {
  const rows = s.nutrition_goals.map((n, i) => `
    <div class="goal-row">
      <span class="grow"><b>${NUT[n.nutrient].verb} ${esc(n.amount)} ${NUT[n.nutrient].unit}${n.nutrient === 'calories' ? '' : ' ' + NUT[n.nutrient].label.toLowerCase()} every day</b></span>
      <label class="row small muted" style="gap:6px"><span class="sr-only">${NUT[n.nutrient].label} amount</span><input class="input" type="number" min="0" step="0.1" value="${esc(n.amount)}" data-nut="${i}" style="width:100px;min-height:40px">${NUT[n.nutrient].unit}</label>
      <button type="button" class="btn btn--icon btn--small" data-rm-nut="${i}" aria-label="Remove goal">×</button>
    </div>`);
  $('#nuts').innerHTML = rows.join('');
  const missing = Object.keys(NUT).filter((k) => !s.nutrition_goals.some((n) => n.nutrient === k));
  $('#nut-add').innerHTML = missing.length ? `<span class="small muted" style="align-self:center;font-weight:600">Add:</span>${missing.map((k) => `<button type="button" class="chip" style="border-style:dashed;color:var(--brand)" data-add-nut="${k}">+ ${NUT[k].label}</button>`).join('')}` : '';
}
function renderWeight() {
  const start = s.weight_goal?.start_kg ?? s.current_weight_kg;
  const cur = Number($('#cur-kg').value) || s.current_weight_kg;
  const target = Number($('#target-kg').value);
  $('#w-start').textContent = `Start ${fmt(start, 1)} kg`;
  if (!target) { $('#w-phrase').textContent = 'No weight goal'; $('#w-track').innerHTML = ''; $('#w-rate').textContent = 'Leave the target empty to only track activity.'; return; }
  const diff = Math.round((target - cur) * 10) / 10;
  $('#w-phrase').textContent = diff === 0 ? `Maintain ${fmt(cur, 1)} kg` : `${diff > 0 ? 'Gain' : 'Lose'} ${fmt(Math.abs(diff), 1)} kg → ${fmt(target, 1)} kg`;
  const done = target === start ? 1 : (cur - start) / (target - start);
  $('#w-track').innerHTML = track(Math.max(0, Math.min(1, done)) * 100, 100, true, true);
  const date = $('#target-date').value;
  const weeks = date ? Math.max(1, Math.round((new Date(date) - new Date(todayISO())) / (7 * 864e5))) : null;
  $('#w-rate').textContent = `${Math.round(Math.max(0, Math.min(1, done)) * 100)} % of the way${weeks ? ` · ${weeks} weeks left` : ''}`;
}
function renderAll() { renderMain(); renderSports(); renderActs(); renderNuts(); renderWeight(); }

/* ----------------------------------------------------------- Events */
$('#main-goals').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goal]'); if (!b) return;
  const g = b.dataset.goal;
  s.goals = s.goals.includes(g) ? s.goals.filter((x) => x !== g) : [...s.goals, g];
  renderMain(); markDirty();
});
$('#sport-chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm-sport]'); if (!b) return;
  s.sports.splice(Number(b.dataset.rmSport), 1); renderSports(); markDirty();
});
sportCombobox($('#sport-add'), { clearOnSelect: true, onSelect: (x) => {
  if (!s.sports.some((y) => y.name.toLowerCase() === x.name.toLowerCase())) { s.sports.push({ name: x.name, sport_id: x.sport_id }); renderSports(); markDirty(); }
} });
$('#acts').addEventListener('click', (e) => {
  const step = e.target.closest('[data-a]');
  const rm = e.target.closest('[data-rm-act]');
  if (step) {
    const g = s.activity_goals[Number(step.dataset.a)]; const d = Number(step.dataset.d);
    if (step.dataset.k === 'm') g.minutes_per_session = Math.max(5, Math.min(300, g.minutes_per_session + d));
    else g.sessions_per_week = Math.max(1, Math.min(7, g.sessions_per_week + d));
    renderActs(); markDirty();
  }
  if (rm) { s.activity_goals.splice(Number(rm.dataset.rmAct), 1); renderActs(); markDirty(); }
});
const newCombo = sportCombobox($('#new-sport'));
$('#add-act').addEventListener('click', () => {
  const sp = newCombo.value();
  if (!sp) { toast('Please choose or type a sport.', 'error'); return; }
  const m = Number($('#new-mins').value); const t = Number($('#new-times').value);
  if (!(m >= 5 && m <= 300) || !(t >= 1 && t <= 7)) { toast('Minutes 5–300 and 1–7 times per week.', 'error'); return; }
  s.activity_goals.push({ sport: sp.name, sport_id: sp.sport_id, minutes_per_session: m, sessions_per_week: t });
  newCombo.clear(); renderActs(); markDirty();
});
$('#nuts').addEventListener('input', (e) => {
  if (e.target.dataset.nut !== undefined) { s.nutrition_goals[Number(e.target.dataset.nut)].amount = Number(e.target.value); markDirty(); }
});
$('#nuts').addEventListener('change', () => renderNuts());
$('#nuts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rm-nut]'); if (!b) return;
  s.nutrition_goals.splice(Number(b.dataset.rmNut), 1); renderNuts(); markDirty();
});
$('#nut-add').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add-nut]'); if (!b) return;
  toast('Nutrition is not implemented', 'error');
});
['#cur-kg', '#target-kg', '#target-date'].forEach((id) => $(id).addEventListener('input', () => { renderWeight(); markDirty(); }));

/* ----------------------------------------------------------- Goal check */
const check = debounce(async () => {
  try {
    const target = Number($('#target-kg').value);
    const res = await meApi.checkGoals({
      goals: s.goals, activity_goals: s.activity_goals, nutrition_goals: s.nutrition_goals,
      current_weight_kg: Number($('#cur-kg').value) || s.current_weight_kg,
      weight_goal: target ? { target_kg: target, target_date: $('#target-date').value || null } : null,
    });
    $('#checks').innerHTML = res.checks.map((c) => `<div class="row small muted" style="flex-wrap:nowrap;align-items:flex-start;line-height:1.5"><span style="color:${c.status === 'ok' ? 'var(--mint)' : '#F4A97A'};font-size:11px;line-height:21px" aria-label="${c.status}">●</span><span style="color:#D3DED9">${esc(c.text)}</span></div>`).join('');
  } catch { /* ignore */ }
}, 500);

/* ----------------------------------------------------------- Save */
saveBtn.addEventListener('click', async () => {
  if (!s.goals.length) { toast('Please keep at least one main goal.', 'error'); return; }
  setBusy(saveBtn, true, 'Saving…');
  try {
    const res = await meApi.saveTargets({
      goals: s.goals, sports: s.sports, activity_goals: s.activity_goals,
      nutrition_goals: s.nutrition_goals,
      current_weight_kg: Number($('#cur-kg').value),
      weight_goal: Number($('#target-kg').value) || $('#target-date').value ? {
        target_kg: Number($('#target-kg').value),
        target_date: $('#target-date').value || null,
      } : null,
    });
    load(res);
    dirty = false;
    setBusy(saveBtn, false);
    saveBtn.disabled = true; saveBtn.textContent = 'Saved ✓';
    toast('Goals saved · your AI Coach will adapt your plan');
  } catch (err) { setBusy(saveBtn, false); toast(err.message, 'error'); }
});

function load(t) {
  s = JSON.parse(JSON.stringify(t));
  s.goals = Array.isArray(s.goals) ? s.goals : [];
  s.sports = Array.isArray(s.sports) ? s.sports : [];
  s.activity_goals = Array.isArray(s.activity_goals) ? s.activity_goals : [];
  s.nutrition_goals = [];
  s.weight_goal = null;
  $('#cur-kg').value = s.current_weight_kg;
  $('#target-kg').value = s.weight_goal?.target_kg ?? '';
  $('#target-date').value = s.weight_goal?.target_date ?? '';
  renderAll(); check();
}
load(await meApi.getTargets());
