/**
 * Onboarding: 3 steps.
 *  1  POST /auth/register          (account is created here → user can resume later)
 *  2  PUT  /me/goals                { goals, sports }
 *  3  PUT  /me/targets  + POST /me/onboarding/complete  (backend assigns the network)
 * Data sharing with the network is enabled automatically – there is no sharing step.
 */
import { auth, me } from '../api.js';
import { $, $$, esc, setBusy, clearErrors, showError, debounce, toast } from '../ui.js';
import { sportCombobox } from '../components/sport-combobox.js';

$('#onboarding-logo').addEventListener('click', async (event) => {
  event.preventDefault();
  try {
    await auth.logout();
  } finally {
    window.location.replace('signin.html');
  }
});

const TITLES = {
  1: ['About you', 'Create your account and tell us a bit about yourself.'],
  2: ['Goals & sports', 'What do you want to achieve, and which sports do you do?'],
  3: ['Targets', 'Turn your goals into concrete weekly targets for training and food.'],
};
const UNITS = { protein: 'g', calories: 'kcal', water: 'L', carbs: 'g', fat: 'g', fiber: 'g', sugar: 'g' };
const NUT_LABEL = { protein: 'protein', calories: 'calories', water: 'water', carbs: 'carbohydrates', fat: 'fat', fiber: 'fiber', sugar: 'sugar' };

const state = { step: 1, goals: [], sports: [], acts: [], nuts: [], times: 3 };

function showStep(n) {
  state.step = n;
  [1, 2, 3].forEach((i) => { $(`#step-${i}`).hidden = i !== n; });
  $('#step-done').hidden = true;
  $('#step-no').textContent = `Step ${n} of 3`;
  $('#step-title').textContent = TITLES[n][0];
  $('#step-sub').textContent = TITLES[n][1];
  $$('#stepper li').forEach((li, i) => { li.className = i + 1 < n ? 'done' : i + 1 === n ? 'current' : ''; });
  if (n === 3) enterStep3();
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------- Resume? */
(async () => {
  const user = await auth.restore();
  if (!user) { showStep(1); return; }
  $('#topbar-right').innerHTML = `Signed in as <b style="color:#fff">${esc(user.username)}</b>`;
  if (user.onboarding_step === 'done') { location.replace('dashboard.html'); return; }
  const t = await me.getTargets().catch(() => null);
  if (t) {
    state.goals = t.goals || [];
    state.sports = t.sports || [];
    renderGoals(); renderSports();
  }
  showStep(user.onboarding_step >= 3 ? 3 : 2);
})();

/* ---------------------------------------------------------- Step 1 */
const f1 = $('#step-1');
$$('#gender-group .chip').forEach((b) => b.addEventListener('click', () => {
  $$('#gender-group .chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  f1.gender.value = b.dataset.gender;
}));

const status = $('#username-status');
f1.username.addEventListener('input', debounce(async () => {
  const v = f1.username.value.trim();
  if (v.length < 3) { status.textContent = ''; return; }
  try {
    const { available } = await auth.usernameAvailable(v);
    status.textContent = available ? '✓ Available' : '✗ Already taken';
    status.style.color = available ? 'var(--brand)' : 'var(--danger)';
  } catch { status.textContent = ''; }
}, 400));

f1.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(f1);
  const v = Object.fromEntries(new FormData(f1));
  const required = ['first_name', 'last_name', 'username', 'email', 'password', 'date_of_birth', 'weight_kg', 'height_cm'];
  for (const k of required) if (!String(v[k] || '').trim()) return showError(f1, { field: k, message: 'This field is required.' });
  if (v.password.length < 8) return showError(f1, { field: 'password', message: 'The password needs at least 8 characters.' });
  if (v.password !== v.password_confirm) return showError(f1, { field: 'password_confirm', message: 'The passwords do not match.' });
  if (!v.gender) return showError(f1, { message: 'Please choose a gender option (you can pick "Prefer not to say").' });
  const btn = f1.querySelector('[type="submit"]');
  setBusy(btn, true, 'Creating account…');
  try {
    await auth.register({
      first_name: v.first_name.trim(), last_name: v.last_name.trim(), username: v.username.trim(), email: v.email.trim(),
      password: v.password, gender: v.gender, date_of_birth: v.date_of_birth, weight_kg: Number(v.weight_kg), height_cm: Number(v.height_cm),
    });
    $('#topbar-right').innerHTML = `Signed in as <b style="color:#fff">${esc(v.username)}</b>`;
    showStep(2);
  } catch (err) {
    showError(f1, err);
  } finally { setBusy(btn, false); }
});

/* ---------------------------------------------------------- Step 2 */
const f2 = $('#step-2');
function renderGoals() {
  $$('#goal-cards .goal-card').forEach((c) => c.setAttribute('aria-pressed', String(state.goals.includes(c.dataset.goal))));
}
$$('#goal-cards .goal-card').forEach((c) => c.addEventListener('click', () => {
  const g = c.dataset.goal;
  state.goals = state.goals.includes(g) ? state.goals.filter((x) => x !== g) : [...state.goals, g];
  renderGoals();
}));

function renderSports() {
  $('#sport-chips').innerHTML = state.sports.length
    ? state.sports.map((s, i) => `<span class="chip chip--removable">${esc(s.name)}<button type="button" data-i="${i}" aria-label="Remove ${esc(s.name)}">×</button></span>`).join('')
    : '<span class="small muted">No sports added yet.</span>';
}
$('#sport-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  state.sports.splice(Number(b.dataset.i), 1);
  renderSports();
});
sportCombobox($('#sport-input'), {
  clearOnSelect: true,
  onSelect: (s) => {
    if (!state.sports.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) state.sports.push({ name: s.name, sport_id: s.sport_id });
    renderSports();
  },
});
renderSports();

f2.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(f2);
  if (!state.goals.length) return showError(f2, { message: 'Please choose at least one goal.' });
  if (!state.sports.length) return showError(f2, { field: 'sports', message: 'Please add at least one sport you do.' });
  const btn = f2.querySelector('[type="submit"]');
  setBusy(btn, true, 'Saving…');
  try {
    await me.saveGoals({ goals: state.goals, sports: state.sports });
    showStep(3);
  } catch (err) { showError(f2, err); } finally { setBusy(btn, false); }
});

/* ---------------------------------------------------------- Step 3 */
const f3 = $('#step-3');
const actCombo = sportCombobox($('#act-sport'));
let step3Loaded = false;

async function enterStep3() {
  // Suggest the sports from step 2 as quick picks
  $('#act-suggest').innerHTML = state.sports.map((s, i) => `<button type="button" class="chip" data-i="${i}">${esc(s.name)}</button>`).join('');
  if (step3Loaded) return;
  step3Loaded = true;
  try {
    const t = await me.getTargets();
    if (t.activity_goals?.length) state.acts = t.activity_goals.map((g) => ({ sport: g.sport, sport_id: g.sport_id, minutes_per_session: g.minutes_per_session, sessions_per_week: g.sessions_per_week }));
    if (t.nutrition_goals?.length) state.nuts = t.nutrition_goals.map((n) => ({ nutrient: n.nutrient, amount: n.amount }));
    if (t.weight_goal) { f3.target_kg.value = t.weight_goal.target_kg; f3.target_date.value = t.weight_goal.target_date || ''; }
  } catch { /* keep empty */ }
  renderActs(); renderNuts();
}
$('#act-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  actCombo.set(state.sports[Number(b.dataset.i)]);
  $('#act-mins').focus();
});
$('#times-down').addEventListener('click', () => { state.times = Math.max(1, state.times - 1); $('#act-times').textContent = state.times; });
$('#times-up').addEventListener('click', () => { state.times = Math.min(7, state.times + 1); $('#act-times').textContent = state.times; });

const freq = (n) => (n === 7 ? 'every day' : `${n} ${n === 1 ? 'time' : 'times'} a week`);
const dur = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

function renderActs() {
  $('#act-list').innerHTML = state.acts.length ? state.acts.map((g, i) => `
    <div class="goal-row">
      <span class="icon-box" style="width:36px;height:36px">${'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/></svg>'}</span>
      <span class="grow"><b>${esc(g.sport)} for ${dur(g.minutes_per_session)} ${freq(g.sessions_per_week)}</b><br><span class="small muted">${g.minutes_per_session * g.sessions_per_week} min per week</span></span>
      <button type="button" class="btn btn--icon btn--small" data-act="${i}" aria-label="Remove goal">×</button>
    </div>`).join('') : '<div class="empty">No activity goal yet – add at least one.</div>';
}
$('#act-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) { state.acts.splice(Number(b.dataset.act), 1); renderActs(); }
});
$('#add-act').addEventListener('click', () => {
  const s = actCombo.value();
  const mins = Number($('#act-mins').value);
  if (!s) { toast('Please choose or type a sport first.', 'error'); $('#act-sport').focus(); return; }
  if (!(mins >= 5 && mins <= 300)) { toast('Minutes per session must be between 5 and 300.', 'error'); return; }
  state.acts.push({ sport: s.name, sport_id: s.sport_id, minutes_per_session: mins, sessions_per_week: state.times });
  actCombo.clear();
  renderActs();
});

function renderNuts() {
  $('#nut-list').innerHTML = state.nuts.length ? state.nuts.map((n, i) => `
    <div class="goal-row">
      <span class="icon-box icon-box--warm" style="width:36px;height:36px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 2v9a3 3 0 0 0 3 3v8M7 2v6M11 2v6M17 2c-2 2-3 5-3 9h3v11"/></svg></span>
      <b class="grow">${n.nutrient === 'water' ? 'Drink' : n.nutrient === 'sugar' ? 'Max.' : n.nutrient === 'calories' ? 'Eat about' : 'Eat'} ${esc(n.amount)} ${UNITS[n.nutrient]}${n.nutrient === 'calories' ? '' : ' ' + NUT_LABEL[n.nutrient]} every day</b>
      <button type="button" class="btn btn--icon btn--small" data-nut="${i}" aria-label="Remove goal">×</button>
    </div>`).join('') : '<div class="empty">No nutrition goals configured.</div>';
}
$('#nut-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-nut]');
  if (b) { state.nuts.splice(Number(b.dataset.nut), 1); renderNuts(); }
});
$('#nut-kind').addEventListener('change', () => { $('#nut-unit').textContent = UNITS[$('#nut-kind').value]; });
$('#add-nut').addEventListener('click', () => {
  toast('Nutrition is not implemented', 'error');
});
$('#back-3').addEventListener('click', () => showStep(2));

f3.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(f3);
  if (!state.acts.length) return showError(f3, { message: 'Please add at least one activity goal.' });
  const btn = f3.querySelector('[type="submit"]');
  setBusy(btn, true, 'Creating your plan…');
  try {
    const target_kg = f3.target_kg.value;
    await me.saveTargets({
      activity_goals: state.acts,
      nutrition_goals: state.nuts,
      ...(target_kg ? { weight_goal: { target_kg: Number(target_kg), target_date: f3.target_date.value || null } } : {}),
    });
    const { network } = await me.completeOnboarding();
    $('#step-3').hidden = true;
    $('#step-done').hidden = false;
    $('#step-no').textContent = 'Done';
    $('#step-title').textContent = 'Welcome to Activ-Ate';
    $('#step-sub').textContent = 'Your account and plan are ready.';
    $$('#stepper li').forEach((li) => { li.className = 'done'; });
    $('#network-text').textContent = `We matched you with a network of ${network.member_count} people with a similar profile. You can compare your progress and cheer each other on.`;
    $('#network-criteria').innerHTML = network.criteria.map((c) => `<span class="chip" style="cursor:default">${esc(c.label)}: ${esc(c.value)}</span>`).join('');
  } catch (err) { showError(f3, err); } finally { setBusy(btn, false); }
});
