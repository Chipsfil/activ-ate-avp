/**
 * MOCK ONLY – an in-browser implementation of the REST API in docs/API.md.
 * It exists so the frontend is fully usable before the Python backend is built.
 * Every route here mirrors a real endpoint; business rules are simplified versions
 * of what docs/BACKEND.md specifies.
 */
import { CONFIG } from '../config.js';
import { db, save, reload, uid, rng, hash, today, addDays, weekStart, daysBetween, round1 } from './mock-db.js';
import { estimateMeal, coachReply } from './mock-ai.js';

/* ================================================================ Router */
class HttpError { constructor(status, error, message, field = null) { Object.assign(this, { status, error, message, field }); } }
const fail = (status, error, message, field) => { throw new HttpError(status, error, message, field); };
const withStatus = (status, data) => ({ __status: status, data });

const routes = [];
function route(method, pattern, handler, { auth = true, slow = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth, slow });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handle(method, fullPath, body, token) {
  const [path, query = ''] = fullPath.split('?');
  const q = Object.fromEntries(new URLSearchParams(query));
  const r = routes.find((x) => x.method === method && x.re.test(path));
  const [min, max] = CONFIG.MOCK_LATENCY_MS;
  await sleep(min + Math.random() * (max - min) + (r && r.slow ? 900 : 0));
  if (!r) return { status: 404, data: { error: 'not_found', message: `No mock route for ${method} ${path}` } };
  const m = path.match(r.re);
  const params = {};
  r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  try {
    reload();
    ensureStudyData();
    let user = null;
    if (r.auth) {
      const id = db().tokens[token];
      user = db().users.find((u) => u.id === id);
      if (!user) fail(401, 'unauthorized', 'Your session has expired. Please sign in again.');
      studyGate(user, path);
    }
    const res = await r.handler({ params, q, body: body || {}, user, token });
    save();
    if (res && res.__status) return { status: res.__status, data: res.data };
    return { status: res === undefined ? 204 : 200, data: res ?? null };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: { error: e.error, message: e.message, field: e.field } };
    console.error('[mock]', e);
    return { status: 500, data: { error: 'server_error', message: 'Mock server error: ' + e.message } };
  }
}

/* ================================================================ Helpers */
let SPORTS = null;
async function sportsList() {
  if (!SPORTS) {
    const res = await fetch(new URL('../../data/sports.json', import.meta.url));
    SPORTS = (await res.json()).items;
  }
  return SPORTS;
}
const sportById = (id) => (SPORTS || []).find((s) => s.id === id);
const sportByName = (name) => (SPORTS || []).find((s) => s.name.toLowerCase() === String(name).toLowerCase() || (s.aliases || []).includes(String(name).toLowerCase()));
const INTENSITY = { light: 0.8, medium: 1, high: 1.2 };
const GOALS = ['lose_weight', 'gain_muscle', 'improve_stamina'];
const NUTRIENTS = { calories: 'kcal', protein: 'g', carbs: 'g', fat: 'g', fiber: 'g', sugar: 'g', water: 'L' };

const initialsOf = (u) => ((u.first_name || '')[0] || '').toUpperCase() + ((u.last_name || '')[0] || '').toUpperCase();
function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email, first_name: u.first_name, last_name: u.last_name, initials: initialsOf(u),
    gender: u.gender, date_of_birth: u.date_of_birth, height_cm: u.height_cm, onboarding_step: u.onboarding_step,
    goals: u.goals || [], sports: u.sports || [], network_id: u.network_id, created_at: u.created_at,
    role: u.is_admin ? 'admin' : 'user',
    app: u.is_admin ? { paused: false, community_enabled: true }
      : { paused: !!db().settings?.experiment_paused, community_enabled: communityActive(u) },
  };
}
function currentWeight(u) {
  const w = db().weights.filter((x) => x.user_id === u.id).sort((a, b) => (a.measured_on < b.measured_on ? 1 : -1));
  return w.length ? w[0].weight_kg : 70;
}
function age(u) {
  if (!u.date_of_birth) return 30;
  return Math.floor(daysBetween(u.date_of_birth, today()) / 365.25);
}
function defaultKcal(u) {
  const w = currentWeight(u); const s = u.gender === 'male' ? 5 : u.gender === 'female' ? -161 : -78;
  let k = (10 * w + 6.25 * u.height_cm - 5 * age(u) + s) * 1.55;
  if ((u.goals || []).includes('lose_weight')) k -= 400;
  else if ((u.goals || []).includes('gain_muscle')) k += 250;
  return Math.round(k / 50) * 50;
}
function nutritionTargets(u) {
  const g = Object.fromEntries((u.nutrition_goals || []).map((n) => [n.nutrient, Number(n.amount)]));
  const w = currentWeight(u);
  const kcal = g.calories || defaultKcal(u);
  const protein = g.protein || Math.round(w * ((u.goals || []).includes('gain_muscle') ? 1.8 : 1.4));
  const fat = g.fat || Math.round((kcal * 0.3) / 9);
  const carbs = g.carbs || Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
  return { kcal, protein_g: protein, carbs_g: carbs, fat_g: fat, water_l: g.water || 2, fiber_g: g.fiber || null, sugar_g: g.sugar || null };
}
const weeklyTarget = (u) => (u.activity_goals || []).reduce((s, g) => s + g.minutes_per_session * g.sessions_per_week, 0) || 150;
const plannedSessions = (u) => (u.activity_goals || []).reduce((s, g) => s + g.sessions_per_week, 0) || 3;
const doneWorkouts = (u) => db().workouts.filter((w) => w.user_id === u.id && w.status === 'done');
const inRange = (d, a, b) => d >= a && d <= b;
const minutesBetween = (u, a, b) => doneWorkouts(u).filter((w) => inRange(w.performed_on, a, b)).reduce((s, w) => s + w.duration_min, 0);
const mealsOn = (u, d) => db().meals.filter((m) => m.user_id === u.id && m.eaten_on === d);
function dayTotals(u, d) {
  return mealsOn(u, d).reduce((a, m) => ({ kcal: a.kcal + m.kcal, protein_g: round1(a.protein_g + m.protein_g), carbs_g: round1(a.carbs_g + m.carbs_g), fat_g: round1(a.fat_g + m.fat_g) }), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
}
const logOn = (u, d) => db().daily_logs.find((l) => l.user_id === u.id && l.log_date === d);
const sportMatches = (w, g) => (g.sport_id && w.sport_id === g.sport_id) || w.sport.toLowerCase() === g.sport.toLowerCase();

function streak(u) {
  const active = new Set(doneWorkouts(u).map((w) => w.performed_on));
  let d = active.has(today()) ? today() : addDays(today(), -1);
  let current = 0;
  while (active.has(d)) { current++; d = addDays(d, -1); }
  let best = 0; let run = 0;
  for (let i = 120; i >= 0; i--) { if (active.has(addDays(today(), -i))) { run++; best = Math.max(best, run); } else run = 0; }
  return { current, best };
}
function workoutOut(w) {
  return { id: w.id, sport: w.sport, sport_id: w.sport_id, title: w.title, performed_on: w.performed_on, duration_min: w.duration_min,
    distance_km: w.distance_km, intensity: w.intensity, notes: w.notes, kcal: w.kcal, status: w.status, created_at: w.created_at };
}
function weekSummary(u) {
  const ws = weekStart(today());
  const done = doneWorkouts(u).filter((w) => inRange(w.performed_on, ws, addDays(ws, 6)));
  return { minutes: done.reduce((s, w) => s + w.duration_min, 0), target_minutes: weeklyTarget(u), sessions_done: done.length, sessions_planned: plannedSessions(u) };
}
function goalProgress(u) {
  const ws = weekStart(today()); const we = addDays(ws, 6);
  const week = doneWorkouts(u).filter((w) => inRange(w.performed_on, ws, we));
  const out = (u.activity_goals || []).map((g) => ({
    kind: 'activity', label: `${g.sport} · ${g.minutes_per_session} min · ${g.sessions_per_week}×/week`,
    done: week.filter((w) => sportMatches(w, g)).length, target: g.sessions_per_week, unit: 'sessions',
  }));
  const t = nutritionTargets(u); const elapsed = daysBetween(ws, today()) + 1;
  let pDays = 0; let wDays = 0;
  for (let i = 0; i < elapsed; i++) {
    const d = addDays(ws, i);
    if (dayTotals(u, d).protein_g >= t.protein_g) pDays++;
    const l = logOn(u, d); if (l && l.water_l >= t.water_l) wDays++;
  }
  out.push({ kind: 'nutrition', label: `Protein · ${t.protein_g} g · daily`, done: pDays, target: elapsed, unit: 'days' });
  out.push({ kind: 'nutrition', label: `Water · ${t.water_l} L · daily`, done: wDays, target: elapsed, unit: 'days' });
  return out;
}

/* ================================================================ Community (people the admin lets you see) */
const GOAL_NAMES = { lose_weight: 'Lose weight', gain_muscle: 'Gain muscle', improve_stamina: 'Improve stamina', general: 'General fitness' };
const HABITS = {
  exercise: { unit: 'min', label: 'Exercise minutes' },
  water: { unit: 'L', label: 'Water' },
};
function memberStats(m, habit) {
  const ws = weekStart(today());
  const elapsed = daysBetween(ws, today()) + 1;
  const r = rng(m.id + habit + ws);
  if (habit === 'exercise') {
    const target = [150, 200, 240, 300][Math.floor(r() * 4)];
    const value = Math.round(target * (0.45 + r() * 0.85) * Math.min(1, (elapsed + 2) / 7));
    return { value, target, daily_target: Math.round(target / 7), streak: Math.floor(r() * 12), change_pct: Math.round((r() - 0.4) * 40), active_today: r() > 0.5, goal_reached: value >= target };
  }
  const per = [2, 2, 2.5][Math.floor(r() * 3)];
  const avg = 1.4 + r() * 1.5;
  const value = round1(avg * elapsed);
  return { value, target: round1(per * elapsed), daily_target: per, streak: Math.floor(r() * 15), change_pct: Math.round((r() - 0.4) * 30), active_today: r() > 0.4, goal_reached: avg >= per };
}
function myStats(u, habit) {
  const ws = weekStart(today());
  const elapsed = daysBetween(ws, today()) + 1;
  const logs = db().daily_logs.filter((l) => l.user_id === u.id && inRange(l.log_date, ws, today()));
  const t = nutritionTargets(u);
  const st = streak(u).current;
  if (habit === 'exercise') {
    const value = minutesBetween(u, ws, addDays(ws, 6));
    const target = weeklyTarget(u);
    const prev = minutesBetween(u, addDays(ws, -7), addDays(ws, -7 + elapsed - 1));
    return { value, target, daily_target: Math.round(target / 7), streak: st, change_pct: prev ? Math.round(((value - prev) / prev) * 100) : 0, active_today: doneWorkouts(u).some((w) => w.performed_on === today()), goal_reached: value >= target };
  }
  const per = t.water_l;
  const value = round1(logs.reduce((s, l) => s + (l.water_l || 0), 0));
  return { value, target: round1(per * elapsed), daily_target: per, streak: habitStreak(u, 'water_l', per), change_pct: 0, active_today: !!logOn(u, today()), goal_reached: value >= per * elapsed };
}
function habitStreak(u, field, target) {
  let d = logOn(u, today()) ? today() : addDays(today(), -1); let n = 0;
  for (;;) { const l = logOn(u, d); if (!l || (l[field] || 0) < target) break; n++; d = addDays(d, -1); }
  return n;
}
function cheerKey(memberId, habit) { return `${memberId}|${habit}|${weekStart(today())}`; }
function cheeredByMe(u, memberId, habit) { return db().cheers.some((c) => c.from_user === u.id && c.key === cheerKey(memberId, habit)); }
function cheerCount(memberId, habit) {
  const base = Math.floor(rng(memberId + habit + weekStart(today()))() * 6);
  return base + db().cheers.filter((c) => c.key === cheerKey(memberId, habit)).length;
}
function leaderboard(u, habit) {
  const me = { member_id: 'me', display_name: 'You', initials: initialsOf(u), is_me: true, ...myStats(u, habit) };
  const rows = [me, ...visibleMembers(u).map((m) => ({ member_id: m.id, display_name: m.display_name, initials: m.initials, is_me: false, ...memberStats(m, habit) }))];
  const key = (r) => r.value;
  rows.sort((a, b) => key(b) - key(a));
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.vs_me = r.is_me ? null : round1(r.value - me.value);
    r.cheered_by_me = r.is_me ? false : cheeredByMe(u, r.member_id, habit);
    r.cheer_count = cheerCount(r.member_id, habit);
    r.can_cheer = !r.is_me && r.goal_reached && !r.cheered_by_me;
  });
  return { rows, me };
}

/* ================================================================ AUTH */
// The "refresh cookie" is kept per browser tab (sessionStorage) so the admin and a
// participant can be tested side by side in two tabs of the same browser.
const REFRESH_KEY = 'activate.mockRefresh';
const getRefresh = () => { try { return sessionStorage.getItem(REFRESH_KEY); } catch { return null; } };
const setRefresh = (v) => { try { if (v) sessionStorage.setItem(REFRESH_KEY, v); else sessionStorage.removeItem(REFRESH_KEY); } catch { /* ignore */ } };

function issueToken(u) {
  const token = 'mock.' + uid();
  db().tokens[token] = u.id;
  setRefresh(u.id);                    // simulates the HttpOnly refresh cookie
  return token;
}
function validateRegistration(b) {
  const need = ['first_name', 'last_name', 'username', 'email', 'password', 'gender', 'date_of_birth', 'weight_kg', 'height_cm'];
  for (const f of need) if (b[f] === undefined || b[f] === null || String(b[f]).trim() === '') fail(422, 'validation_error', 'This field is required.', f);
  if (!/^[a-z0-9._-]{3,30}$/i.test(b.username)) fail(422, 'validation_error', 'Use 3–30 letters, numbers, dots, dashes or underscores.', 'username');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) fail(422, 'validation_error', 'Please enter a valid email address.', 'email');
  if (String(b.password).length < 8) fail(422, 'validation_error', 'The password needs at least 8 characters.', 'password');
  const w = Number(b.weight_kg); const h = Number(b.height_cm);
  if (!(w >= 30 && w <= 300)) fail(422, 'validation_error', 'Weight must be between 30 and 300 kg.', 'weight_kg');
  if (!(h >= 100 && h <= 250)) fail(422, 'validation_error', 'Height must be between 100 and 250 cm.', 'height_cm');
  if (!b.date_of_birth || Number.isNaN(Date.parse(b.date_of_birth))) {
    fail(422, 'validation_error', 'Date of birth must be a valid date.', 'date_of_birth');
  }
}

route('GET', '/auth/username-available', ({ q }) => {
  const name = String(q.username || '').toLowerCase();
  if (name.length < 3) return { available: false, reason: 'too_short' };
  if (name === 'admin') return { available: false, reason: 'reserved' };
  return { available: !db().users.some((u) => u.username.toLowerCase() === name) };
}, { auth: false });

route('POST', '/auth/register', ({ body }) => {
  validateRegistration(body);
  if (String(body.username).toLowerCase() === 'admin') fail(409, 'conflict', 'This username is reserved.', 'username');
  if (db().users.some((u) => u.username.toLowerCase() === body.username.toLowerCase())) fail(409, 'conflict', 'This username is already taken.', 'username');
  if (db().users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) fail(409, 'conflict', 'An account with this email already exists.', 'email');
  const u = {
    id: uid('u-'), username: body.username.trim(), email: body.email.trim(), password: body.password,
    first_name: body.first_name.trim(), last_name: body.last_name.trim(), gender: body.gender, date_of_birth: body.date_of_birth,
    height_cm: Number(body.height_cm), created_at: new Date().toISOString(), onboarding_step: 2,
    goals: [], sports: [], activity_goals: [], nutrition_goals: [], weight_goal: null, network_id: null,
  };
  db().users.push(u);
  db().weights.push({ user_id: u.id, weight_kg: Number(body.weight_kg), measured_on: today() });
  u.community_enabled = db().settings?.community_default !== false;
  assignNumber(u);
  return withStatus(201, { access_token: issueToken(u), user: publicUser(u) });
}, { auth: false });

route('POST', '/auth/login', ({ body }) => {
  const id = String(body.username || '').toLowerCase();
  const u = db().users.find((x) => x.username.toLowerCase() === id || x.email.toLowerCase() === id);
  if (!u || u.password !== body.password) fail(401, 'invalid_credentials', 'Username or password is incorrect.');
  return { access_token: issueToken(u), user: publicUser(u) };
}, { auth: false });

route('POST', '/auth/refresh', () => {
  const u = db().users.find((x) => x.id === getRefresh());
  if (!u) fail(401, 'unauthorized', 'Not signed in.');
  return { access_token: issueToken(u), user: publicUser(u) };
}, { auth: false });

route('POST', '/auth/logout', ({ token }) => {
  delete db().tokens[token];
  setRefresh(null);
}, { auth: false });

/* ================================================================ ME / GOALS */
route('GET', '/me', ({ user }) => publicUser(user));

route('PUT', '/me/goals', async ({ user, body }) => {
  await sportsList();
  const goals = (body.goals || []).filter((g) => GOALS.includes(g));
  if (!goals.length) fail(422, 'validation_error', 'Please choose at least one goal.', 'goals');
  const sports = (body.sports || []).map((s) => ({ name: String(s.name).trim().slice(0, 60), sport_id: s.sport_id || sportByName(s.name)?.id || null })).filter((s) => s.name);
  if (!sports.length) fail(422, 'validation_error', 'Please add at least one sport you do.', 'sports');
  user.goals = goals; user.sports = sports;
  if (user.onboarding_step === 2) user.onboarding_step = 3;
  return { goals, sports };
});

function targetsOut(u) {
  return {
    goals: u.goals, sports: u.sports,
    activity_goals: u.activity_goals,
    nutrition_goals: (u.nutrition_goals || []).map((n) => ({ ...n, unit: NUTRIENTS[n.nutrient] })),
    weight_goal: u.weight_goal ? { ...u.weight_goal, current_kg: currentWeight(u) } : null,
    current_weight_kg: currentWeight(u),
    computed_defaults: { kcal: defaultKcal(u), protein_g: nutritionTargets({ ...u, nutrition_goals: [] }).protein_g },
  };
}
route('GET', '/me/targets', ({ user }) => targetsOut(user));

route('PUT', '/me/targets', async ({ user, body }) => {
  await sportsList();
  if (body.goals) {
    const goals = body.goals.filter((g) => GOALS.includes(g));
    if (!goals.length) fail(422, 'validation_error', 'Please choose at least one goal.', 'goals');
    user.goals = goals;
  }
  if (body.sports) user.sports = body.sports.map((s) => ({ name: String(s.name).trim(), sport_id: s.sport_id || sportByName(s.name)?.id || null })).filter((s) => s.name);
  if (body.activity_goals) {
    user.activity_goals = body.activity_goals.map((g) => {
      const mins = Number(g.minutes_per_session); const ses = Number(g.sessions_per_week);
      if (!g.sport) fail(422, 'validation_error', 'Every activity goal needs a sport.', 'activity_goals');
      if (!(mins >= 5 && mins <= 300)) fail(422, 'validation_error', 'Minutes per session must be between 5 and 300.', 'activity_goals');
      if (!(ses >= 1 && ses <= 7)) fail(422, 'validation_error', 'Sessions per week must be between 1 and 7.', 'activity_goals');
      return { id: g.id || uid('ag-'), sport: g.sport, sport_id: g.sport_id || sportByName(g.sport)?.id || null, minutes_per_session: mins, sessions_per_week: ses };
    });
  }
  if (body.nutrition_goals) {
    user.nutrition_goals = body.nutrition_goals.filter((n) => NUTRIENTS[n.nutrient] && Number(n.amount) > 0).map((n) => ({ nutrient: n.nutrient, amount: Number(n.amount) }));
  }
  if (body.current_weight_kg && Number(body.current_weight_kg) !== currentWeight(user)) {
    const w = Number(body.current_weight_kg);
    if (!(w >= 30 && w <= 300)) fail(422, 'validation_error', 'Weight must be between 30 and 300 kg.', 'current_weight_kg');
    db().weights.push({ user_id: user.id, weight_kg: w, measured_on: today() });
  }
  if (body.weight_goal === null) user.weight_goal = null;
  else if (body.weight_goal && body.weight_goal.target_kg) {
    const t = Number(body.weight_goal.target_kg);
    if (!(t >= 30 && t <= 300)) fail(422, 'validation_error', 'Target weight must be between 30 and 300 kg.', 'target_kg');
    if (body.weight_goal.target_date && body.weight_goal.target_date <= today() && body.weight_goal.target_date !== user.weight_goal?.target_date) fail(422, 'validation_error', 'The target date must be in the future.', 'target_date');
    user.weight_goal = { start_kg: user.weight_goal?.start_kg ?? currentWeight(user), target_kg: t, target_date: body.weight_goal.target_date || null };
  }
  if (user.onboarding_step === 3) user.onboarding_step = 4;
  return targetsOut(user);
});

route('POST', '/me/onboarding/complete', ({ user }) => {
  if (!user.goals.length) fail(409, 'onboarding_incomplete', 'Please finish the previous steps first.');
  user.onboarding_step = 'done';
  // New participants see nobody until the admin connects them.
  return { network: { id: 'my-network', member_count: visibleMembers(user).length + 1, criteria: [] } };
});

route('POST', '/goals/check', ({ user, body }) => {
  const acts = body.activity_goals || user.activity_goals || [];
  const minutes = acts.reduce((s, g) => s + Number(g.minutes_per_session || 0) * Number(g.sessions_per_week || 0), 0);
  const checks = [{ status: minutes >= 150 ? 'ok' : 'warning', text: `${minutes} exercise minutes per week planned${minutes >= 150 ? ' – meets the WHO recommendation of 150 min.' : ' – below the WHO recommendation of 150 min.'}` }];
  const cur = Number(body.current_weight_kg || currentWeight(user));
  const wg = body.weight_goal;
  if (wg && wg.target_kg && wg.target_date) {
    const weeks = Math.max(1, daysBetween(today(), wg.target_date) / 7);
    const diff = Number(wg.target_kg) - cur; const rate = Math.abs(diff) / weeks;
    checks.push({ status: rate <= 0.5 ? 'ok' : 'warning', text: diff === 0 ? 'Weight: maintain your current weight.' : `${diff > 0 ? 'Gaining' : 'Losing'} ${Math.abs(round1(diff))} kg in ${Math.round(weeks)} weeks = ${Math.round(rate * 100) / 100} kg/week${rate <= 0.5 ? ' – a realistic, healthy pace.' : ' – that is fast; consider a later date.'}` });
  }
  const prot = (body.nutrition_goals || []).find((n) => n.nutrient === 'protein');
  const goals = body.goals || user.goals || [];
  if (prot) {
    const perKg = Number(prot.amount) / cur; const ok = goals.includes('gain_muscle') ? perKg >= 1.6 && perKg <= 2.4 : perKg >= 0.8 && perKg <= 2.4;
    checks.push({ status: ok ? 'ok' : 'warning', text: `Protein ${prot.amount} g = ${round1(perKg)} g per kg body weight${ok ? ' – fits your goal.' : (goals.includes('gain_muscle') ? ' – for muscle gain 1.6–2.2 g/kg is recommended.' : ' – 0.8–2.2 g/kg is the usual range.')}` });
  } else {
    checks.push({ status: 'warning', text: 'Add a protein goal so the AI can plan your meals.' });
  }
  return { checks };
});

/* ================================================================ SPORTS */
route('GET', '/sports', async ({ q }) => {
  const list = await sportsList();
  const term = String(q.q || '').trim().toLowerCase();
  const limit = Math.min(50, Number(q.limit) || 8);
  if (!term) return { items: list.slice(0, limit).map(({ aliases, ...s }) => s) };
  const score = (s) => {
    const n = s.name.toLowerCase(); const al = s.aliases || [];
    if (n === term) return 0;
    if (n.startsWith(term)) return 1;
    if (al.some((a) => a.startsWith(term))) return 2;
    if (n.split(/[\s(/]+/).some((w) => w.startsWith(term))) return 3;
    if (n.includes(term) || al.some((a) => a.includes(term))) return 4;
    return 99;
  };
  const items = list.map((s) => [score(s), s]).filter(([sc]) => sc < 99).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map(([, { aliases, ...s }]) => s);
  return { items };
}, { auth: false });

/* ================================================================ DASHBOARD */
route('GET', '/dashboard', ({ user, q }) => {
  const date = q.date || today();
  const ws = weekStart(date);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    return { date: d, minutes: d > today() ? null : minutesBetween(user, d, d) };
  });
  const t = nutritionTargets(user);
  const tot = dayTotals(user, date);
  const log = logOn(user, date) || {};
  const lb = leaderboard(user, 'exercise');
  const feed = feedItems(user, 2);
  return {
    date,
    week: weekSummary(user),
    days,
    today: { kcal: tot.kcal, kcal_target: t.kcal, protein_g: tot.protein_g, protein_target_g: t.protein_g, water_l: log.water_l ?? null, water_target_l: t.water_l },
    streak: streak(user),
    goal_progress: goalProgress(user),
    recent_workouts: doneWorkouts(user).sort(byDateDesc).slice(0, 4).map(workoutOut),
    network_top: lb.rows.slice(0, 4).map(({ member_id, display_name, initials, is_me, value, rank }) => ({ member_id, display_name, initials, is_me, value, rank })),
    network_note: lb.me.rank === 1 ? 'You lead your network this week!' : `You are ${Math.round(lb.rows[0].value - lb.me.value)} min behind ${lb.rows[0].display_name}.`,
    feed,
  };
});
const byDateDesc = (a, b) => (a.performed_on === b.performed_on ? (a.created_at < b.created_at ? 1 : -1) : (a.performed_on < b.performed_on ? 1 : -1));

route('PUT', '/daily-logs', ({ user, body }) => {
  const date = body.date || today();
  if (date > today()) fail(422, 'validation_error', 'You cannot log a future day.', 'date');
  let l = logOn(user, date);
  if (!l) { l = { user_id: user.id, log_date: date, water_l: null }; db().daily_logs.push(l); }
  if (body.water_l !== undefined && body.water_l !== null && body.water_l !== '') {
    const w = Number(body.water_l); if (!(w >= 0 && w <= 10)) fail(422, 'validation_error', 'Water must be between 0 and 10 liters.', 'water_l');
    l.water_l = round1(w);
  }
  return { date, water_l: l.water_l };
});

/* ================================================================ RECOMMENDATIONS (mock AI) */
route('GET', '/recommendations/daily', ({ user }) => {
  const prog = goalProgress(user).filter((g) => g.kind === 'activity');
  const open = prog.find((g) => g.done < g.target);
  const goal = open ? (user.activity_goals || []).find((g) => open.label.startsWith(g.sport)) : null;
  const t = nutritionTargets(user); const tot = dayTotals(user, today());
  const protGap = Math.round(t.protein_g - tot.protein_g);
  return {
    workout: goal ? `${goal.sport} is at ${open.done}/${open.target} sessions this week. Plan a ${goal.minutes_per_session}-minute ${goal.sport.toLowerCase()} session tomorrow to stay on track.` : 'All planned sessions are done this week – great consistency. Use tomorrow for recovery: a walk or 20 minutes of mobility.',
    nutrition: protGap > 0 ? `You are ${protGap} g short on protein today. Add 250 g skyr or 150 g chicken to your next meal; drink at least ${t.water_l} L of water.` : 'Protein target reached today. Keep dinner rich in vegetables and drink enough water.',
    suggested_session: goal ? { sport: goal.sport, sport_id: goal.sport_id, duration_min: goal.minutes_per_session, date: addDays(today(), 1) } : null,
    generated_at: new Date().toISOString(), source: 'mock',
  };
}, { slow: true });

route('GET', '/recommendations/workout', ({ user }) => {
  const ws = weekStart(today());
  const last4 = minutesBetween(user, addDays(ws, -28), addDays(ws, -1)) / 4;
  const prev4 = minutesBetween(user, addDays(ws, -56), addDays(ws, -29)) / 4;
  const change = prev4 ? Math.round(((last4 - prev4) / prev4) * 100) : 0;
  const open = goalProgress(user).find((g) => g.kind === 'activity' && g.done < g.target);
  return {
    text: `Your weekly volume averaged ${Math.round(last4)} min over the last 4 weeks (${change >= 0 ? '+' : ''}${change} % vs. the 4 weeks before). ${open ? `${open.label.split(' · ')[0]} is still at ${open.done}/${open.target} this week.` : 'All activity goals are met this week.'}`,
    tips: ['Keep next week at about your target volume and add one 20-minute mobility session.', 'On strength days, eat 30–40 g protein within 2 hours after training.'],
    generated_at: new Date().toISOString(), source: 'mock',
  };
}, { slow: true });

route('GET', '/recommendations/nutrition', ({ user }) => {
  const t = nutritionTargets(user);
  let p = 0; let k = 0; let n = 0;
  for (let i = 1; i <= 7; i++) { const d = dayTotals(user, addDays(today(), -i)); if (d.kcal) { p += d.protein_g; k += d.kcal; n++; } }
  const avgP = n ? Math.round(p / n) : 0; const avgK = n ? Math.round(k / n) : 0;
  const logs = db().daily_logs.filter((l) => l.user_id === user.id && l.log_date >= addDays(today(), -7));
  const avgW = logs.length ? round1(logs.reduce((s, l) => s + (l.water_l || 0), 0) / logs.length) : null;
  const more = []; const watch = [];
  if (avgP < t.protein_g) more.push(`Protein · avg ${avgP} / ${t.protein_g} g`);
  if (avgW !== null && avgW < t.water_l) more.push(`Water · avg ${avgW} / ${t.water_l} L`);
  if (avgK > t.kcal * 1.1) watch.push(`Calories · avg ${avgK} / ${t.kcal} kcal`);
  if (avgK && avgK < t.kcal * 0.85) more.push(`Calories · avg ${avgK} / ${t.kcal} kcal`);
  return {
    text: n ? `Over the last 7 days you averaged ${avgK} kcal and ${avgP} g protein per day.${avgP < t.protein_g ? ' Adding a protein source to every meal is your biggest lever.' : ' Your protein intake fits your goal.'}` : 'Log a few meals and I will analyse your nutrition.',
    more_of: more, watch, generated_at: new Date().toISOString(), source: 'mock',
  };
}, { slow: true });

/* ================================================================ WORKOUTS */
route('GET', '/workouts', ({ user, q }) => {
  let list = doneWorkouts(user).concat(db().workouts.filter((w) => w.user_id === user.id && w.status === 'planned')).sort(byDateDesc);
  if (q.sport) list = list.filter((w) => w.sport.toLowerCase() === q.sport.toLowerCase());
  if (q.status) list = list.filter((w) => w.status === q.status);
  const start = Number(q.cursor || 0); const limit = Math.min(100, Number(q.limit) || 20);
  const items = list.slice(start, start + limit).map(workoutOut);
  return { items, next_cursor: start + limit < list.length ? String(start + limit) : null };
});

route('GET', '/workouts/stats', ({ user, q }) => {
  const n = Math.min(26, Number(q.weeks) || 8);
  const ws = weekStart(today());
  const weeks = Array.from({ length: n }, (_, i) => {
    const s = addDays(ws, -7 * (n - 1 - i));
    return { week_start: s, minutes: minutesBetween(user, s, addDays(s, 6)) };
  });
  const by = {};
  doneWorkouts(user).filter((w) => inRange(w.performed_on, ws, addDays(ws, 6))).forEach((w) => { by[w.sport] = (by[w.sport] || 0) + w.duration_min; });
  const all = doneWorkouts(user);
  const pbs = [];
  if (all.length) {
    const longest = all.reduce((a, b) => (b.duration_min > a.duration_min ? b : a));
    pbs.push({ label: 'Longest session', value: `${longest.duration_min} min`, detail: `${longest.sport}, ${longest.performed_on}` });
  }
  const dist = all.filter((w) => w.distance_km);
  if (dist.length) {
    const far = dist.reduce((a, b) => (b.distance_km > a.distance_km ? b : a));
    pbs.push({ label: `Longest distance`, value: `${far.distance_km} km`, detail: far.sport });
  }
  const runs = dist.filter((w) => /run|jog/i.test(w.sport) && w.distance_km >= 5);
  if (runs.length) {
    const best = Math.min(...runs.map((w) => (w.duration_min / w.distance_km) * 5));
    pbs.push({ label: '5 km (estimated)', value: `${Math.floor(best)}:${String(Math.round((best % 1) * 60)).padStart(2, '0')}`, detail: 'from your average pace' });
  }
  pbs.push({ label: 'Best week', value: `${Math.max(...weeks.map((w) => w.minutes))} min`, detail: `last ${n} weeks` });
  return {
    weeks, target_minutes: weeklyTarget(user), week: weekSummary(user),
    by_sport: Object.entries(by).map(([sport, minutes]) => ({ sport, minutes })).sort((a, b) => b.minutes - a.minutes),
    goal_progress: goalProgress(user).filter((g) => g.kind === 'activity'),
    personal_bests: pbs,
  };
});

function validateWorkout(b) {
  if (!b.sport || !String(b.sport).trim()) fail(422, 'validation_error', 'Please choose or type a sport.', 'sport');
  const d = Number(b.duration_min);
  if (!(d >= 1 && d <= 600)) fail(422, 'validation_error', 'Duration must be between 1 and 600 minutes.', 'duration_min');
  if (!b.performed_on) fail(422, 'validation_error', 'Please choose a date.', 'performed_on');
  if ((b.status || 'done') === 'done' && b.performed_on > today()) fail(422, 'validation_error', 'A completed workout cannot be in the future.', 'performed_on');
  if (b.performed_on < addDays(today(), -365)) fail(422, 'validation_error', 'Workouts older than one year cannot be added.', 'performed_on');
  if (b.distance_km !== undefined && b.distance_km !== null && b.distance_km !== '' && !(Number(b.distance_km) >= 0 && Number(b.distance_km) <= 500)) fail(422, 'validation_error', 'Distance must be between 0 and 500 km.', 'distance_km');
}
route('POST', '/workouts', async ({ user, body }) => {
  await sportsList();
  validateWorkout(body);
  const sport = (body.sport_id && sportById(body.sport_id)) || sportByName(body.sport);
  const met = (sport ? sport.met : 6.0) * (INTENSITY[body.intensity] || 1);
  const w = {
    id: uid('w-'), user_id: user.id, sport: String(body.sport).trim(), sport_id: sport ? sport.id : null,
    title: String(body.title || '').trim().slice(0, 80) || null, performed_on: body.performed_on, duration_min: Number(body.duration_min),
    distance_km: body.distance_km ? round1(Number(body.distance_km)) : null, intensity: body.intensity || 'medium',
    notes: String(body.notes || '').slice(0, 1000), kcal: Math.round(met * currentWeight(user) * Number(body.duration_min) / 60),
    status: body.status === 'planned' ? 'planned' : 'done', created_at: new Date().toISOString(),
  };
  db().workouts.push(w);
  return withStatus(201, { workout: workoutOut(w), week: weekSummary(user) });
});
route('PATCH', '/workouts/:id', ({ user, params, body }) => {
  const w = db().workouts.find((x) => x.id === params.id);
  if (!w) fail(404, 'not_found', 'This workout no longer exists.');
  if (w.user_id !== user.id) fail(403, 'forbidden', 'Not your workout.');
  Object.assign(w, Object.fromEntries(Object.entries(body).filter(([k]) => ['title', 'duration_min', 'distance_km', 'intensity', 'notes', 'status', 'performed_on'].includes(k))));
  if (w.status === 'done' && w.performed_on > today()) w.performed_on = today();
  return { workout: workoutOut(w), week: weekSummary(user) };
});
route('DELETE', '/workouts/:id', ({ user, params }) => {
  const i = db().workouts.findIndex((x) => x.id === params.id && x.user_id === user.id);
  if (i < 0) fail(404, 'not_found', 'This workout no longer exists.');
  db().workouts.splice(i, 1);
  return { week: weekSummary(user) };
});

/* ================================================================ NUTRITION */
route('GET', '/nutrition/summary', ({ user, q }) => {
  const date = q.date || today();
  const goals = Object.fromEntries((user.nutrition_goals || []).map((n) => [n.nutrient, Number(n.amount)]));
  return { date, totals: dayTotals(user, date), targets: { kcal: goals.calories ?? null, protein_g: goals.protein ?? null, carbs_g: goals.carbs ?? null, fat_g: goals.fat ?? null } };
});
route('GET', '/meals', ({ user, q }) => {
  const date = q.date || today();
  const order = { breakfast: 0, lunch: 1, snack: 2, dinner: 3 };
  return { items: mealsOn(user, date).sort((a, b) => order[a.meal_type] - order[b.meal_type] || (a.created_at < b.created_at ? -1 : 1)) };
});
route('POST', '/meals/estimate', ({ user, body }) => {
  const text = String(body.text || '').trim();
  if (text.length < 3) fail(422, 'validation_error', 'Please describe your meal (at least 3 characters).', 'text');
  if (text.length > 500) fail(422, 'validation_error', 'Please keep the description under 500 characters.', 'text');
  const todayCount = db().estimates.filter((e) => e.user_id === user.id && e.created_at.slice(0, 10) === today()).length;
  if (todayCount >= 30) fail(429, 'rate_limited', 'You reached the daily limit of 30 AI estimates. Please enter values manually.');
  const res = estimateMeal(text);
  const est = { id: uid('e-'), user_id: user.id, input_text: text, model: 'mock', response: res, status: 'pending', created_at: new Date().toISOString() };
  db().estimates.push(est);
  return { estimate_id: est.id, ...res };
}, { slow: true });
route('POST', '/meals', ({ user, body }) => {
  const types = ['breakfast', 'lunch', 'dinner', 'snack'];
  if (!types.includes(body.meal_type)) fail(422, 'validation_error', 'Please choose a meal type.', 'meal_type');
  const nums = ['kcal', 'protein_g', 'carbs_g', 'fat_g'];
  nums.forEach((k) => { const v = Number(body[k]); if (!(v >= 0) || v > (k === 'kcal' ? 5000 : 500)) fail(422, 'validation_error', 'Please enter a valid number.', k); });
  let edited = false;
  if (body.estimate_id) {
    const e = db().estimates.find((x) => x.id === body.estimate_id && x.user_id === user.id);
    if (!e || e.status !== 'pending') fail(409, 'conflict', 'This estimate was already used. Please estimate again.');
    e.status = 'confirmed';
    edited = Math.round(Number(body.kcal)) !== Math.round(e.response.totals.kcal);
  }
  const meal = {
    id: uid('m-'), user_id: user.id, eaten_on: body.eaten_on || today(), meal_type: body.meal_type,
    description: String(body.description || body.meal_type).trim().slice(0, 200), source: body.estimate_id ? 'ai' : 'manual',
    kcal: Math.round(Number(body.kcal)), protein_g: round1(Number(body.protein_g)), carbs_g: round1(Number(body.carbs_g)), fat_g: round1(Number(body.fat_g)),
    edited, created_at: new Date().toISOString(),
  };
  db().meals.push(meal);
  return withStatus(201, { meal, totals: dayTotals(user, meal.eaten_on) });
});
route('DELETE', '/meals/:id', ({ user, params }) => {
  const i = db().meals.findIndex((x) => x.id === params.id && x.user_id === user.id);
  if (i < 0) fail(404, 'not_found', 'This meal no longer exists.');
  const [m] = db().meals.splice(i, 1);
  return { totals: dayTotals(user, m.eaten_on) };
});

/* ================================================================ COMMUNITY */
route('GET', '/community/network', ({ user }) => {
  return {
    id: 'my-network', member_count: visibleMembers(user).length + 1,
    criteria: [],
    explanation: 'For this study you see a selection of other participants. You only see the people shown here.',
    shared_data: ['Exercise minutes', 'Workout type and duration', 'Streaks', 'Water intake'],
  };
});
route('GET', '/community/leaderboard', ({ user, q }) => {
  const habit = HABITS[q.habit] ? q.habit : 'exercise';
  const { rows, me } = leaderboard(user, habit);
  const top = rows.slice().sort((a, b) => b.streak - a.streak)[0];
  const first = rows[0];
  return {
    habit, unit: HABITS[habit].unit, period: 'week',
    target_label: habit === 'exercise' ? 'Weekly target' : 'Liters per day',
    rows,
    summary: {
      my_rank: me.rank, member_count: rows.length,
      top_streak: { days: top.streak, display_name: top.display_name },
      gap_to_first: first.is_me ? 0 : round1(first.value - me.value),
      gap_unit: HABITS[habit].unit,
    },
  };
});
route('GET', '/community/members/:id', ({ user, params, q }) => {
  const habit = HABITS[q.habit] ? q.habit : 'exercise';
  const period = ['week', 'month', 'all'].includes(q.period) ? q.period : 'week';
  const m = visibleMembers(user).find((x) => x.id === params.id);
  if (!m) fail(404, 'not_found', 'This member is not in your network.');
  const { rows } = leaderboard(user, habit);
  const row = rows.find((r) => r.member_id === m.id);
  const mine = rows.find((r) => r.is_me);
  const r = rng(m.id + habit + period);
  const factor = { week: 1, month: 4.1 + r() * 0.5, all: 30 + r() * 25 }[period];
  const ms = myStats(user, habit);
  let myTotal = ms.value;
  if (period !== 'week') {
    const from = period === 'month' ? addDays(today(), -29) : (user.created_at || '2025-01-01').slice(0, 10);
    if (habit === 'exercise') myTotal = minutesBetween(user, from, today());
    else myTotal = round1(db().daily_logs.filter((l) => l.user_id === user.id && l.log_date >= from).reduce((s, l) => s + (l.water_l || 0), 0));
  }
  const unit = HABITS[habit].unit;
  const log = Array.from({ length: 8 }, (_, i) => {
    const date = addDays(today(), -(i + (habit === 'exercise' ? Math.floor(i * 0.4) : 0)));
    const rr = rng(m.id + habit + date);
    if (habit === 'exercise') return { date, label: m.sports[Math.floor(rr() * m.sports.length)], value: 20 + Math.round(rr() * 60), unit: 'min', met: null };
    const per = row.daily_target;
    const v = round1(1.4 + rr() * 1.6);
    return { date, label: null, value: v, unit, met: v >= per };
  });
  const fmtT = (s) => (habit === 'exercise' ? `${s.target} min / week` : `${s.daily_target} L / day`);
  return {
    member: { id: m.id, display_name: m.username, initials: m.initials, joined: m.joined, sports: m.sports, rank: row.rank, streak: row.streak },
    habit, period, unit,
    targets: { member: fmtT(row), me: fmtT(mine) },
    totals: { member: habit === 'exercise' ? Math.round(row.value * factor) : round1(row.value * factor), me: myTotal },
    log, goal_reached: row.goal_reached, cheered_by_me: row.cheered_by_me, cheer_count: row.cheer_count, can_cheer: row.can_cheer,
  };
});
route('POST', '/community/members/:id/cheers', ({ user, params, body }) => {
  const habit = HABITS[body.habit] ? body.habit : 'exercise';
  const { rows } = leaderboard(user, habit);
  const row = rows.find((r) => r.member_id === params.id);
  if (!row || row.is_me) fail(404, 'not_found', 'This member is not in your network.');
  if (!row.goal_reached) fail(409, 'goal_not_reached', 'You can cheer once this member has reached their goal.');
  if (row.cheered_by_me) fail(409, 'already_cheered', 'You already cheered for this goal this week.');
  db().cheers.push({ from_user: user.id, key: cheerKey(params.id, habit), created_at: new Date().toISOString() });
  return withStatus(201, { cheered: true, cheer_count: cheerCount(params.id, habit) });
});
route('GET', '/community/insights', ({ user, q }) => {
  const habit = HABITS[q.habit] ? q.habit : 'exercise';
  const { rows, me } = leaderboard(user, habit);
  const unit = HABITS[habit].unit;
  const items = [];
  if (me.rank > 1) {
    const first = rows[0];
    items.push({ text: `${first.display_name} is ahead by ${round1(first.value - me.value)} ${unit} this week. ${habit === 'exercise' ? 'One more session brings you closer to first place.' : 'One extra glass per day closes the gap.'}`, action: null });
  } else items.push({ text: 'You lead your network this week – keep the rhythm!', action: null });
  rows.filter((r) => r.can_cheer).slice(0, 2).forEach((r) => items.push({ text: `${r.display_name} reached the ${HABITS[habit].label.toLowerCase()} goal. A cheer takes one click and keeps the whole network motivated.`, action: 'cheer', member_id: r.member_id }));
  const improver = rows.filter((r) => !r.is_me).sort((a, b) => b.change_pct - a.change_pct)[0];
  if (improver && improver.change_pct > 10) items.push({ text: `${improver.display_name} improved by ${improver.change_pct} % compared to last week.`, action: null });
  return { habit, items, generated_at: new Date().toISOString(), source: 'mock' };
}, { slow: true });

function feedItems(user, limit) {
  const items = [];
  ['exercise', 'water'].forEach((habit) => {
    const { rows } = leaderboard(user, habit);
    rows.filter((r) => !r.is_me && r.goal_reached).forEach((r) => {
      const text = habit === 'exercise' ? `reached the weekly exercise goal (${r.value} min)` : `hit the water goal every day this week`;
      items.push({ id: `${r.member_id}-${habit}`, member_id: r.member_id, display_name: r.display_name, initials: r.initials, habit, text, cheered_by_me: r.cheered_by_me, cheer_count: r.cheer_count, can_cheer: r.can_cheer });
    });
  });
  items.sort((a, b) => hash(a.id) - hash(b.id));
  return items.slice(0, limit);
}
route('GET', '/feed', ({ user, q }) => ({ items: feedItems(user, Math.min(30, Number(q.limit) || 10)) }));

/* ================================================================ COACH */
function coachCtx(user) {
  const t = nutritionTargets(user); const tot = dayTotals(user, today());
  const { rows, me } = leaderboard(user, 'exercise');
  return {
    proteinTarget: t.protein_g, proteinToday: tot.protein_g, kcalTarget: t.kcal, kcalToday: tot.kcal,
    activityGoals: user.activity_goals || [], targetMinutes: weeklyTarget(user), weekMinutes: weekSummary(user).minutes,
    rank: me.rank, networkSize: rows.length,
    gapText: me.rank === 1 ? 'You lead – great job!' : `${rows[0].display_name} leads with ${rows[0].value} min; ${Math.round(rows[0].value - me.value)} more minutes would put you in first place.`,
    currentKg: currentWeight(user), targetKg: user.weight_goal?.target_kg ?? null,
  };
}
function greeting(user) {
  const c = coachCtx(user);
  return `Hi ${user.first_name}! You have ${c.weekMinutes} of ${c.targetMinutes} exercise minutes this week${c.proteinTarget > c.proteinToday ? ` and you are ${Math.round(c.proteinTarget - c.proteinToday)} g short on protein today` : ''}.\n\nWhat would you like to work on – training, nutrition or recovery?`;
}
function newChat(user) {
  const chat = { id: uid('c-'), user_id: user.id, created_at: new Date().toISOString(), messages: [{ role: 'assistant', content: greeting(user), created_at: new Date().toISOString() }] };
  db().chats.push(chat);
  return chat;
}
route('GET', '/coach/context', ({ user }) => {
  const c = coachCtx(user);
  const goals = (user.goals || []).map((g) => GOAL_NAMES[g]).join(' + ');
  return {
    items: [
      { label: 'Goals', value: goals || '–', detail: (user.activity_goals || []).map((g) => `${g.sport} ${g.minutes_per_session} min ${g.sessions_per_week}×/week`).join(' · ') },
      { label: 'This week', value: `${c.weekMinutes} / ${c.targetMinutes} exercise minutes`, detail: `${weekSummary(user).sessions_done} sessions logged` },
      { label: "Today's food", value: `${c.kcalToday} / ${c.kcalTarget} kcal`, detail: `Protein ${Math.round(c.proteinToday)} / ${c.proteinTarget} g` },
      { label: 'Body', value: `${c.currentKg} kg${c.targetKg ? ` → target ${c.targetKg} kg` : ''}`, detail: `${user.height_cm} cm` },
      { label: 'Network', value: `#${c.rank} of ${c.networkSize}`, detail: c.gapText },
    ],
  };
});
route('GET', '/coach/conversations/latest', ({ user }) => {
  const chats = db().chats.filter((c) => c.user_id === user.id);
  const chat = chats.length ? chats[chats.length - 1] : newChat(user);
  return { conversation_id: chat.id, messages: chat.messages.slice(-50) };
});
route('POST', '/coach/conversations', ({ user }) => {
  const chat = newChat(user);
  return withStatus(201, { conversation_id: chat.id, messages: chat.messages });
});
route('POST', '/coach/messages', ({ user, body }) => {
  const text = String(body.text || '').trim();
  if (!text) fail(422, 'validation_error', 'Please type a message.', 'text');
  if (text.length > 1000) fail(422, 'validation_error', 'Please keep your message under 1000 characters.', 'text');
  let chat = db().chats.find((c) => c.id === body.conversation_id && c.user_id === user.id);
  if (!chat) chat = newChat(user);
  chat.messages.push({ role: 'user', content: text, created_at: new Date().toISOString() });
  const reply = coachReply(text, coachCtx(user));
  const msg = { role: 'assistant', content: reply.content, created_at: new Date().toISOString() };
  chat.messages.push(msg);
  return { conversation_id: chat.id, message: msg, proposed_sessions: reply.proposed_sessions || [] };
}, { slow: true });


/* ================================================================ STUDY / ADMIN (mock) */
/*
 * Mirrors backend/api/admin.py + experiment.py:
 *  - admin account Admin / Admin, ~20 example participants with IDs (ID 1 … ID N)
 *  - one big network: db().visibility = [{ viewer, target }] ("viewer sees target")
 *  - Community = admin switch AND sees at least one person
 *  - "experiment_paused" and "community_default" settings, two CSV files
 * Activity numbers of other participants are simulated in the mock.
 */
const YES_WORDS = ['yes', 'y', 'ja', 'j', 'true', '1', 'on', 'an', 'x'];
const NO_WORDS = ['no', 'n', 'nein', 'false', '0', 'off', 'aus'];
const GOAL_LABEL = { lose_weight: 'Lose weight', gain_muscle: 'Gain muscle', improve_stamina: 'Improve stamina' };
const GENDERS = ['female', 'male', 'diverse', 'unspecified'];
const idLabel = (n) => `ID ${n}`;
const participants = () => db().users.filter((u) => !u.is_admin);
const byNo = (n) => participants().find((u) => u.participant_no === n);

function assignNumber(u) {
  if (u.is_admin || u.participant_no) return;
  const d = db();
  d.next_participant_no = Math.max(d.next_participant_no || 1, ...participants().map((x) => (x.participant_no || 0) + 1));
  u.participant_no = d.next_participant_no++;
}
function seesIds(u) { return db().visibility.filter((e) => e.viewer === u.id).map((e) => e.target); }
function visibleMembers(u) {
  return seesIds(u).map((id) => db().users.find((x) => x.id === id)).filter((t) => t && !t.is_admin).map((t) => ({
    id: t.id, username: t.username, display_name: t.username, initials: initialsOf(t),
    joined: (t.created_at || '2026-01-01').slice(0, 10),
    sports: (t.sports || []).map((x) => x.name).slice(0, 2).concat((t.sports || []).length ? [] : ['Running']),
  }));
}
const communityActive = (u) => u.community_enabled !== false && seesIds(u).length > 0;

function ensureStudyData() {
  const d = db();
  if (d.study_version === 2) return;
  d.visibility = [];
  if (!d.study_seeded) {
    d.users.push({
      id: 'u-admin', username: 'Admin', email: 'admin@admin.activ-ate.local', password: 'Admin', is_admin: true,
      first_name: 'Admin', last_name: 'Activ-Ate', gender: 'na', date_of_birth: '1970-01-01', height_cm: 170,
      created_at: new Date().toISOString(), onboarding_step: 'done', goals: [], sports: [], activity_goals: [], nutrition_goals: [],
    });
    const first = ['Mia', 'Noah', 'Lea', 'Luca', 'Elena', 'David', 'Sara', 'Jonas', 'Anna', 'Nico', 'Laura', 'Tim', 'Nina', 'Leon',
      'Julia', 'Samuel', 'Lara', 'Fabio', 'Chiara', 'Marco'];
    const last = ['Keller', 'Brunner', 'Frei', 'Huber', 'Meier', 'Baumann', 'Weber', 'Schmid', 'Fischer', 'Gerber',
      'Moser', 'Graf', 'Roth', 'Kunz', 'Steiner', 'Bianchi', 'Suter', 'Widmer', 'Lehmann', 'Bühler'];
    const goalSets = [['lose_weight'], ['gain_muscle'], ['improve_stamina'], ['gain_muscle', 'improve_stamina'], ['lose_weight', 'improve_stamina']];
    const sportSets = [['Running'], ['Weightlifting'], ['Cycling', 'Swimming'], ['Yoga'], ['Running', 'Weightlifting'], ['Football'], ['Tennis']];
    const r = rng('study-seed');
    first.forEach((f, i) => {
      const female = i % 2 === 0;
      const u = {
        id: `u-p${i + 1}`, username: `${f.toLowerCase()}.${last[i].toLowerCase().replace('ü', 'ue')}`, email: `${f.toLowerCase()}@example.ch`,
        password: 'demo1234', first_name: f, last_name: last[i], gender: female ? 'female' : 'male',
        date_of_birth: `${1990 + Math.floor(r() * 12)}-0${1 + Math.floor(r() * 9)}-1${Math.floor(r() * 9)}`,
        height_cm: Math.round((female ? 160 : 172) + r() * 18), created_at: new Date(Date.now() - (20 - i) * 36e5).toISOString(),
        onboarding_step: i === 19 ? 3 : 'done', goals: goalSets[i % goalSets.length],
        sports: sportSets[i % sportSets.length].map((name) => ({ name, sport_id: name.toLowerCase() })),
        activity_goals: [{ id: uid('ag'), sport: sportSets[i % sportSets.length][0], sport_id: null, minutes_per_session: 30 + 10 * (i % 4), sessions_per_week: 2 + (i % 3) }],
        nutrition_goals: [{ nutrient: 'protein', amount: 90 + 10 * (i % 6) }], weight_goal: null, network_id: null, community_enabled: true,
      };
      d.users.push(u);
      d.weights.push({ user_id: u.id, weight_kg: Math.round(((female ? 58 : 72) + r() * 22) * 10) / 10, measured_on: today() });
    });
  }
  d.settings = { experiment_paused: false, community_default: true, ...(d.settings || {}) };
  delete d.settings.community_enabled;
  delete d.groups;
  // IDs in order of registration
  d.users.forEach((u) => { delete u.group_id; delete u.participant_no; });
  d.next_participant_no = 1;
  participants().slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).forEach(assignNumber);
  // A few example connections so the demo Community is not empty (the real backend starts empty).
  const pairs = [[1, 2], [1, 3], [1, 4], [1, 5], [2, 3], [3, 2], [3, 1], [4, 1], [5, 6], [6, 5], [7, 8]];
  pairs.forEach(([v, t]) => { if (byNo(v) && byNo(t)) d.visibility.push({ viewer: byNo(v).id, target: byNo(t).id }); });
  d.study_seeded = true;
  d.study_version = 2;
  save();
}

function studyGate(user, path) {
  if (user.is_admin) {
    if (/^\/(community|feed)/.test(path)) fail(403, 'forbidden', 'The admin account is not part of a network.');
    return;
  }
  if (path.startsWith('/admin/')) fail(403, 'forbidden', 'Admin access only.');
  const open = path === '/me' || /^\/(auth|me|sports|goals\/check)(\/|$)/.test(path);
  if (db().settings.experiment_paused && !open) fail(423, 'experiment_paused', 'Activ-Ate has not started yet. Please wait for the start of the study.');
  if (!communityActive(user) && /^\/(community|feed)/.test(path)) fail(403, 'community_disabled', 'The Community is not available.');
}

function ageOf(u) {
  const b = new Date(u.date_of_birth + 'T12:00:00'); const n = new Date();
  return n.getFullYear() - b.getFullYear() - ((n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) ? 1 : 0);
}
function participantOut(u) {
  const no = (id) => db().users.find((x) => x.id === id)?.participant_no;
  const sees = seesIds(u).map(no).filter(Boolean).sort((a, b) => a - b);
  const seenBy = db().visibility.filter((e) => e.target === u.id).map((e) => no(e.viewer)).filter(Boolean).sort((a, b) => a - b);
  return {
    id: u.id, participant_no: u.participant_no, username: u.username, email: u.email, first_name: u.first_name, last_name: u.last_name,
    gender: u.gender, date_of_birth: u.date_of_birth, age: ageOf(u), height_cm: u.height_cm, weight_kg: currentWeight(u),
    goals: (u.goals || []).map((g) => GOAL_LABEL[g] || g), sports: (u.sports || []).map((s) => s.name),
    activity_goals: (u.activity_goals || []).map((a) => `${a.sport} ${a.minutes_per_session} min x${a.sessions_per_week}/week`),
    nutrition_goals: (u.nutrition_goals || []).map((n) => `${n.nutrient} ${n.amount}`),
    weight_goal: u.weight_goal ? `${u.weight_goal.start_kg} -> ${u.weight_goal.target_kg} kg` : '',
    onboarding_complete: u.onboarding_step === 'done', registered_at: String(u.created_at).slice(0, 19),
    sees, seen_by: seenBy, community_enabled: u.community_enabled !== false, community_active: u.community_enabled !== false && sees.length > 0,
  };
}
function overview() {
  const users = participants().slice().sort((a, b) => a.participant_no - b.participant_no).map(participantOut);
  return { settings: { ...db().settings }, connections: users.reduce((n, u) => n + u.sees.length, 0), users };
}

route('GET', '/admin/overview', () => overview());
route('PUT', '/admin/settings', ({ body }) => {
  ['experiment_paused', 'community_default'].forEach((k) => { if (typeof body[k] === 'boolean') db().settings[k] = body[k]; });
  return { settings: { ...db().settings } };
});
route('PUT', '/admin/users/:id/visibility', ({ params, body }) => {
  const u = participants().find((x) => x.id === params.id);
  if (!u) fail(404, 'not_found', 'Participant not found.');
  if (!Array.isArray(body.sees) || !body.sees.every((n) => Number.isInteger(n))) fail(422, 'validation_error', 'Send sees as a list of participant IDs, e.g. [2, 5].', 'sees');
  if (body.sees.includes(u.participant_no)) fail(422, 'validation_error', 'A participant cannot see themselves.', 'sees');
  const unknown = body.sees.filter((n) => !byNo(n));
  if (unknown.length) fail(422, 'validation_error', `Unknown participant ID(s): ${unknown.map(idLabel).join(', ')}.`, 'sees');
  db().visibility = db().visibility.filter((e) => e.viewer !== u.id).concat([...new Set(body.sees)].map((n) => ({ viewer: u.id, target: byNo(n).id })));
  return overview();
});
route('PUT', '/admin/users/:id/community', ({ params, body }) => {
  const u = participants().find((x) => x.id === params.id);
  if (!u) fail(404, 'not_found', 'Participant not found.');
  if (typeof body.enabled !== 'boolean') fail(422, 'validation_error', 'Send enabled as true or false.', 'enabled');
  u.community_enabled = body.enabled;
  return { user_id: u.id, community_enabled: u.community_enabled };
});
route('POST', '/admin/community', ({ body }) => {
  if (typeof body.enabled !== 'boolean') fail(422, 'validation_error', 'Send enabled as true or false.', 'enabled');
  const ids = Array.isArray(body.user_ids) ? new Set(body.user_ids) : null;
  const list = participants().filter((u) => !ids || ids.has(u.id));
  list.forEach((u) => { u.community_enabled = body.enabled; });
  return { ...overview(), message: `Community ${body.enabled ? 'allowed' : 'switched off'} for ${list.length} participant(s).` };
});

/* ---------------------------------------------------------------- CSV */
function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  let t = Array.isArray(v) ? v.join(' | ') : String(v);
  if (/^[=+\-@]/.test(t) && Number.isNaN(Number(t))) t = "'" + t;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((x) => x));
}
const parseId = (t) => { const m = String(t || '').trim().replace(/^'/, '').toLowerCase().match(/^(?:id)?\s*[-_#:]?\s*(\d{1,7})$/); return m ? Number(m[1]) : null; };
const clean = (v) => String(v || '').trim().replace(/^'/, '').replace(/\s+/g, ' ');
const stamp = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`; };
const P_COLS = ['id', 'username', 'first_name', 'last_name', 'email', 'gender', 'date_of_birth', 'age', 'height_cm', 'weight_kg', 'goals', 'sports',
  'activity_goals', 'nutrition_goals', 'weight_goal', 'onboarding_complete', 'registered_at', 'sees', 'seen_by', 'community'];
const EDITABLE = ['first_name', 'last_name', 'email', 'gender', 'date_of_birth', 'height_cm', 'weight_kg', 'community'];

route('GET', '/admin/export/participants', () => {
  const users = overview().users;
  const rows = users.map((u) => P_COLS.map((c) => csvCell(
    c === 'id' ? idLabel(u.participant_no) : c === 'sees' ? u.sees.map(idLabel) : c === 'seen_by' ? u.seen_by.map(idLabel)
      : c === 'community' ? (u.community_enabled ? 'on' : 'off') : u[c])).join(';'));
  return { filename: `activ-ate-participants_${stamp()}.csv`, csv: [P_COLS.join(';'), ...rows].join('\r\n') + '\r\n', rows: rows.length };
});

function parseField(field, raw) {
  if (field === 'first_name' || field === 'last_name') return raw.length <= 100 ? [raw] : [null, 'is longer than 100 characters'];
  if (field === 'email') { const v = raw.toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? [v] : [null, `'${raw}' is not a valid email address`]; }
  if (field === 'gender') { const v = raw.toLowerCase(); return GENDERS.includes(v) ? [v] : [null, 'must be female, male, diverse or unspecified']; }
  if (field === 'date_of_birth') {
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/); let iso = m ? raw : null;
    if (!iso) { m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); if (m) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    const d = iso ? new Date(iso + 'T12:00:00') : null;
    return d && !Number.isNaN(d.getTime()) && iso <= today() && iso >= '1900-01-01' ? [iso] : [null, `'${raw}' is not a valid date (use 1998-03-05 or 05.03.1998)`];
  }
  if (field === 'height_cm' || field === 'weight_kg') {
    const v = Number(raw.replace(',', '.').replace("'", ''));
    const [lo, hi] = field === 'height_cm' ? [100, 250] : [30, 300];
    if (Number.isNaN(v)) return [null, `'${raw}' is not a number`];
    return v >= lo && v <= hi ? [Math.round(v * 10) / 10] : [null, `must be between ${lo} and ${hi}`];
  }
  if (field === 'community') { const v = raw.toLowerCase(); if (YES_WORDS.includes(v)) return [true]; if (NO_WORDS.includes(v)) return [false]; return [null, 'must be on or off']; }
  return [null, 'cannot be changed'];
}

route('POST', '/admin/import/participants', ({ body }) => {
  if (typeof body.csv !== 'string' || !body.csv.trim()) fail(422, 'validation_error', 'Please choose a CSV file.', 'csv');
  const rows = parseCsv(body.csv);
  if (!rows.length) fail(422, 'validation_error', 'The file is empty.', 'csv');
  const head = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  if (!head.includes('id') && !head.includes('username')) fail(422, 'validation_error', "The file needs an 'id' or 'username' column to identify participants.", 'csv');
  const editable = EDITABLE.filter((f) => head.includes(f));
  if (!editable.length) fail(422, 'validation_error', `The file has no column that can be changed (${EDITABLE.join(', ')}).`, 'csv');
  const users = overview().users;
  const emails = Object.fromEntries(users.map((u) => [u.email.toLowerCase(), u.id]));
  const errors = []; const changes = []; const seen = new Set(); const newEmails = {};
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const cell = (k) => (head.indexOf(k) >= 0 ? r[head.indexOf(k)] || '' : '');
    const rawId = cell('id'); const rawName = clean(cell('username')).toLowerCase();
    const u = rawId ? users.find((x) => x.participant_no === parseId(rawId)) : users.find((x) => x.username.toLowerCase() === rawName);
    if (!u) { errors.push({ row: line, message: `Unknown participant (${rawId || rawName || 'no id'}).` }); return; }
    if (seen.has(u.id)) { errors.push({ row: line, message: `${idLabel(u.participant_no)} appears more than once.` }); return; }
    seen.add(u.id);
    const fields = {};
    editable.forEach((f) => {
      const raw = clean(cell(f));
      if (!raw) return;
      const [value, problem] = parseField(f, raw);
      if (problem) { errors.push({ row: line, message: `${f} ${problem}.` }); return; }
      if (f === 'email') {
        const owner = emails[value] || newEmails[value];
        if (owner && owner !== u.id) { errors.push({ row: line, message: `The email ${value} is already used by another participant.` }); return; }
        newEmails[value] = u.id;
      }
      const current = f === 'community' ? u.community_enabled : u[f];
      if (value !== current) fields[f] = { from: current, to: value };
    });
    if (Object.keys(fields).length) changes.push({ user_id: u.id, participant_no: u.participant_no, name: `${u.first_name} ${u.last_name}`, fields });
  });
  const summary = { rows: rows.length - 1, changes, unchanged: seen.size - changes.length, not_in_file: users.length - seen.size, errors, applied: false };
  if (errors.length) return withStatus(422, { ...summary, error: 'validation_error', message: `${errors.length} problem(s) in the file. Nothing was changed.` });
  if (body.dry_run !== false) return summary;
  changes.forEach((c) => {
    const u = db().users.find((x) => x.id === c.user_id);
    Object.entries(c.fields).forEach(([f, v]) => {
      if (f === 'community') u.community_enabled = v.to;
      else if (f === 'weight_kg') db().weights.push({ user_id: u.id, weight_kg: v.to, measured_on: today() });
      else u[f] = v.to;
    });
  });
  return { ...summary, applied: true, ...overview() };
});

route('GET', '/admin/export/network', () => {
  const users = overview().users;
  const rows = [];
  users.forEach((u) => u.sees.forEach((t) => {
    const tu = users.find((x) => x.participant_no === t);
    rows.push([idLabel(u.participant_no), idLabel(t), csvCell(`${u.first_name} ${u.last_name}`), csvCell(`${tu.first_name} ${tu.last_name}`)].join(';'));
  }));
  return { filename: `activ-ate-network_${stamp()}.csv`, csv: ['viewer_id;sees_id;viewer_name;sees_name', ...rows].join('\r\n') + '\r\n', rows: rows.length };
});

route('POST', '/admin/import/network', ({ body }) => {
  if (typeof body.csv !== 'string' || !body.csv.trim()) fail(422, 'validation_error', 'Please choose a CSV file.', 'csv');
  let rows = parseCsv(body.csv);
  let vc = 0; let tc = 1; let start = 1;
  if (rows.length && parseId(rows[0][0]) === null) {
    const head = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const v = ['viewer_id', 'viewer', 'id', 'sieht_wer'].find((h) => head.includes(h)); if (v) vc = head.indexOf(v);
    const t = ['sees_id', 'sees', 'target_id', 'target', 'sieht'].find((h) => head.includes(h)); if (t) tc = head.indexOf(t);
    rows = rows.slice(1); start = 2;
  }
  const users = overview().users;
  const nos = new Set(users.map((u) => u.participant_no));
  const name = (n) => { const u = users.find((x) => x.participant_no === n); return `${u.first_name} ${u.last_name}`; };
  const errors = []; const warnings = []; const pairs = new Set();
  rows.forEach((r, i) => {
    const line = i + start;
    if (r.length <= Math.max(vc, tc)) { errors.push({ row: line, message: 'Needs two IDs: the person who sees and the person who is seen.' }); return; }
    const v = parseId(r[vc]); const t = parseId(r[tc]);
    if (v === null || t === null) { errors.push({ row: line, message: `'${r[vc]}' / '${r[tc]}' are not IDs (use ID 1 or 1).` }); return; }
    const missing = [v, t].filter((n) => !nos.has(n)).map(idLabel);
    if (missing.length) { errors.push({ row: line, message: `Unknown participant ${missing.join(', ')}.` }); return; }
    if (v === t) { errors.push({ row: line, message: `${idLabel(v)} cannot see themselves.` }); return; }
    const key = `${v}>${t}`;
    if (pairs.has(key)) warnings.push({ row: line, message: `${idLabel(v)} → ${idLabel(t)} appears twice (counted once).` });
    pairs.add(key);
  });
  const current = new Set(users.flatMap((u) => u.sees.map((t) => `${u.participant_no}>${t}`)));
  const toPair = (k) => { const [v, t] = k.split('>').map(Number); return { viewer: v, target: t, viewer_name: name(v), target_name: name(t) }; };
  const sortPairs = (a, b) => a.viewer - b.viewer || a.target - b.target;
  const added = [...pairs].filter((k) => !current.has(k)).map(toPair).sort(sortPairs);
  const removed = [...current].filter((k) => !pairs.has(k)).map(toPair).sort(sortPairs);
  const viewers = new Set([...pairs].map((k) => Number(k.split('>')[0])));
  const summary = {
    rows: rows.length, pairs: pairs.size, added, removed, unchanged: [...pairs].filter((k) => current.has(k)).length,
    mutual: [...pairs].filter((k) => { const [v, t] = k.split('>'); return pairs.has(`${t}>${v}`); }).length / 2,
    sees_nobody: users.map((u) => u.participant_no).filter((n) => !viewers.has(n)).sort((a, b) => a - b), errors, warnings, applied: false,
  };
  if (errors.length) return withStatus(422, { ...summary, error: 'validation_error', message: `${errors.length} row(s) have errors. Nothing was changed.` });
  if (body.dry_run !== false) return summary;
  db().visibility = [...pairs].map((k) => { const [v, t] = k.split('>').map(Number); return { viewer: byNo(v).id, target: byNo(t).id }; });
  return { ...summary, applied: true, ...overview() };
});
