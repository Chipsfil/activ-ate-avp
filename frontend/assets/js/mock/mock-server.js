/**
 * MOCK ONLY – an in-browser implementation of the REST API in docs/API.md.
 * It exists so the frontend is fully usable before the Python backend is built.
 * Every route here mirrors a real endpoint; business rules are simplified versions
 * of what docs/BACKEND.md specifies.
 */
import { CONFIG } from '../config.js';
import { db, save, uid, rng, hash, today, addDays, weekStart, daysBetween, round1 } from './mock-db.js';
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
    let user = null;
    if (r.auth) {
      const id = db().tokens[token];
      user = db().users.find((u) => u.id === id);
      if (!user) fail(401, 'unauthorized', 'Your session has expired. Please sign in again.');
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

/* ================================================================ Network (auto-assigned) */
const NAMES = [['Alex', 'Maxon'], ['Sarah', 'Keller'], ['David', 'Lehmann'], ['Jordan', 'Kunz'], ['Sam', 'Roth'], ['Elena', 'Brunner'], ['Chris', 'Pfister'], ['Mia', 'Tanner'], ['Noah', 'Frei'], ['Lea', 'Huber'], ['Luca', 'Meyer'], ['Nina', 'Graf']];
const GOAL_NAMES = { lose_weight: 'Lose weight', gain_muscle: 'Gain muscle', improve_stamina: 'Improve stamina', general: 'General fitness' };
const MEMBER_SPORTS = ['Running', 'Weightlifting', 'Cycling', 'Swimming', 'HIIT', 'Yoga', 'Football (soccer)', 'Climbing (indoor)'];

function networkFor(u) {
  const h = Math.floor(u.height_cm / 10) * 10;
  const w = Math.floor(currentWeight(u) / 10) * 10;
  const goal = (u.goals || [])[0] || 'general';
  const a = Math.floor(age(u) / 10) * 10;
  const key = `${h}|${w}|${goal}|${a}`;
  return {
    id: 'net-' + hash(key).toString(36), key,
    criteria: [
      { label: 'Height', value: `${h}–${h + 9} cm` },
      { label: 'Weight', value: `${w}–${w + 9} kg` },
      { label: 'Age', value: `${a}–${a + 9} years` },
      { label: 'Main goal', value: GOAL_NAMES[goal] },
    ],
  };
}
function membersOf(net) {
  const r = rng(net.id);
  const pool = NAMES.slice();
  const list = [];
  for (let i = 0; i < 7; i++) {
    const [first, last] = pool.splice(Math.floor(r() * pool.length), 1)[0];
    list.push({
      id: `${net.id}-${i}`, username: `${first.toLowerCase()}_${last.toLowerCase()}`, display_name: `${first.toLowerCase()}_${last.toLowerCase()}`, initials: `${first[0]}${last[0]}`,
      joined: `2025-${String(1 + Math.floor(r() * 9)).padStart(2, '0')}-01`,
      sports: [MEMBER_SPORTS[Math.floor(r() * 8)], MEMBER_SPORTS[Math.floor(r() * 8)]].filter((v, j, a) => a.indexOf(v) === j),
    });
  }
  return list;
}
const HABITS = {
  exercise: { unit: 'min', label: 'Exercise minutes' },
  sleep: { unit: 'h', label: 'Sleep' },
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
  if (habit === 'sleep') {
    const per = [7.5, 8, 8][Math.floor(r() * 3)];
    const avg = 6.6 + r() * 1.8;
    const value = round1(avg * elapsed);
    return { value, target: round1(per * elapsed), daily_target: per, streak: Math.floor(r() * 35), change_pct: Math.round((r() - 0.4) * 20), active_today: r() > 0.4, goal_reached: avg >= per };
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
  if (habit === 'sleep') {
    const per = u.sleep_goal_h || 8;
    const value = round1(logs.reduce((s, l) => s + (l.sleep_hours || 0), 0));
    return { value, target: round1(per * elapsed), daily_target: per, streak: habitStreak(u, 'sleep_hours', per), change_pct: 0, active_today: !!logOn(u, today()), goal_reached: value >= per * elapsed };
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
function ensureNetwork(u) {
  if (!u.network_id) u.network_id = networkFor(u).id;
  return networkFor(u);
}
function leaderboard(u, habit) {
  const net = ensureNetwork(u);
  const me = { member_id: 'me', display_name: 'You', initials: initialsOf(u), is_me: true, ...myStats(u, habit) };
  const rows = [me, ...membersOf(net).map((m) => ({ member_id: m.id, display_name: m.display_name, initials: m.initials, is_me: false, ...memberStats(m, habit) }))];
  const key = (r) => (habit === 'sleep' ? r.streak * 1000 + r.value : r.value);
  rows.sort((a, b) => key(b) - key(a));
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.vs_me = r.is_me ? null : (habit === 'sleep' ? r.streak - me.streak : round1(r.value - me.value));
    r.cheered_by_me = r.is_me ? false : cheeredByMe(u, r.member_id, habit);
    r.cheer_count = cheerCount(r.member_id, habit);
    r.can_cheer = !r.is_me && r.goal_reached && !r.cheered_by_me;
  });
  return { net, rows, me };
}

/* ================================================================ AUTH */
function issueToken(u) {
  const token = 'mock.' + uid();
  db().tokens[token] = u.id;
  db().refresh = u.id;                 // simulates the HttpOnly refresh cookie
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
  return { available: !db().users.some((u) => u.username.toLowerCase() === name) };
}, { auth: false });

route('POST', '/auth/register', ({ body }) => {
  validateRegistration(body);
  if (db().users.some((u) => u.username.toLowerCase() === body.username.toLowerCase())) fail(409, 'conflict', 'This username is already taken.', 'username');
  if (db().users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) fail(409, 'conflict', 'An account with this email already exists.', 'email');
  const u = {
    id: uid('u-'), username: body.username.trim(), email: body.email.trim(), password: body.password,
    first_name: body.first_name.trim(), last_name: body.last_name.trim(), gender: body.gender, date_of_birth: body.date_of_birth,
    height_cm: Number(body.height_cm), created_at: new Date().toISOString(), onboarding_step: 2,
    goals: [], sports: [], activity_goals: [], nutrition_goals: [], sleep_goal_h: 8, weight_goal: null, network_id: null,
  };
  db().users.push(u);
  db().weights.push({ user_id: u.id, weight_kg: Number(body.weight_kg), measured_on: today() });
  return withStatus(201, { access_token: issueToken(u), user: publicUser(u) });
}, { auth: false });

route('POST', '/auth/login', ({ body }) => {
  const id = String(body.username || '').toLowerCase();
  const u = db().users.find((x) => x.username.toLowerCase() === id || x.email.toLowerCase() === id);
  if (!u || u.password !== body.password) fail(401, 'invalid_credentials', 'Username or password is incorrect.');
  return { access_token: issueToken(u), user: publicUser(u) };
}, { auth: false });

route('POST', '/auth/refresh', () => {
  const u = db().users.find((x) => x.id === db().refresh);
  if (!u) fail(401, 'unauthorized', 'Not signed in.');
  return { access_token: issueToken(u), user: publicUser(u) };
}, { auth: false });

route('POST', '/auth/logout', ({ token }) => {
  delete db().tokens[token];
  db().refresh = null;
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
    sleep_goal_h: u.sleep_goal_h || 8,
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
  if (body.sleep_goal_h) user.sleep_goal_h = Number(body.sleep_goal_h);
  if (body.current_weight_kg && Number(body.current_weight_kg) !== currentWeight(user)) {
    const w = Number(body.current_weight_kg);
    if (!(w >= 30 && w <= 300)) fail(422, 'validation_error', 'Weight must be between 30 and 300 kg.', 'current_weight_kg');
    db().weights.push({ user_id: user.id, weight_kg: w, measured_on: today() });
  }
  if (body.weight_goal === null) user.weight_goal = null;
  else if (body.weight_goal && body.weight_goal.target_kg) {
    const t = Number(body.weight_goal.target_kg);
    if (!(t >= 30 && t <= 300)) fail(422, 'validation_error', 'Target weight must be between 30 and 300 kg.', 'target_kg');
    if (body.weight_goal.target_date && body.weight_goal.target_date <= today()) fail(422, 'validation_error', 'The target date must be in the future.', 'target_date');
    user.weight_goal = { start_kg: user.weight_goal?.start_kg ?? currentWeight(user), target_kg: t, target_date: body.weight_goal.target_date || null };
  }
  if (user.onboarding_step === 3) user.onboarding_step = 4;
  return targetsOut(user);
});

route('POST', '/me/onboarding/complete', ({ user }) => {
  if (!user.goals.length) fail(409, 'onboarding_incomplete', 'Please finish the previous steps first.');
  const net = networkFor(user);
  user.network_id = net.id;
  user.onboarding_step = 'done';
  return { network: { id: net.id, member_count: 8, criteria: net.criteria } };
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
    today: { kcal: tot.kcal, kcal_target: t.kcal, protein_g: tot.protein_g, protein_target_g: t.protein_g, sleep_hours: log.sleep_hours ?? null, water_l: log.water_l ?? null, water_target_l: t.water_l, sleep_target_h: user.sleep_goal_h || 8 },
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
  if (!l) { l = { user_id: user.id, log_date: date, sleep_hours: null, water_l: null }; db().daily_logs.push(l); }
  if (body.sleep_hours !== undefined && body.sleep_hours !== null && body.sleep_hours !== '') {
    const s = Number(body.sleep_hours); if (!(s >= 0 && s <= 16)) fail(422, 'validation_error', 'Sleep must be between 0 and 16 hours.', 'sleep_hours');
    l.sleep_hours = round1(s);
  }
  if (body.water_l !== undefined && body.water_l !== null && body.water_l !== '') {
    const w = Number(body.water_l); if (!(w >= 0 && w <= 10)) fail(422, 'validation_error', 'Water must be between 0 and 10 liters.', 'water_l');
    l.water_l = round1(w);
  }
  return { date, sleep_hours: l.sleep_hours, water_l: l.water_l };
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
  const t = nutritionTargets(user);
  return { date, totals: dayTotals(user, date), targets: { kcal: t.kcal, protein_g: t.protein_g, carbs_g: t.carbs_g, fat_g: t.fat_g } };
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
    items: body.items || [], edited, created_at: new Date().toISOString(),
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
  const net = ensureNetwork(user);
  return {
    id: net.id, member_count: 8, criteria: net.criteria,
    explanation: 'You were matched automatically with people of similar height, weight, age and main goal, so comparisons are fair. Your network is updated when your profile changes a lot.',
    shared_data: ['Exercise minutes', 'Workout type and duration', 'Streaks', 'Sleep hours', 'Water intake'],
  };
});
route('GET', '/community/leaderboard', ({ user, q }) => {
  const habit = HABITS[q.habit] ? q.habit : 'exercise';
  const { rows, me } = leaderboard(user, habit);
  const top = rows.slice().sort((a, b) => b.streak - a.streak)[0];
  const first = rows[0];
  return {
    habit, unit: HABITS[habit].unit, period: 'week',
    target_label: habit === 'exercise' ? 'Weekly target' : habit === 'sleep' ? 'Hours per night' : 'Liters per day',
    rows,
    summary: {
      my_rank: me.rank, member_count: rows.length,
      top_streak: { days: top.streak, display_name: top.display_name },
      gap_to_first: first.is_me ? 0 : (habit === 'sleep' ? first.streak - me.streak : round1(first.value - me.value)),
      gap_unit: habit === 'sleep' ? 'streak days' : HABITS[habit].unit,
    },
  };
});
route('GET', '/community/members/:id', ({ user, params, q }) => {
  const habit = HABITS[q.habit] ? q.habit : 'exercise';
  const period = ['week', 'month', 'all'].includes(q.period) ? q.period : 'week';
  const net = ensureNetwork(user);
  const m = membersOf(net).find((x) => x.id === params.id);
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
    else myTotal = round1(db().daily_logs.filter((l) => l.user_id === user.id && l.log_date >= from).reduce((s, l) => s + (l[habit === 'sleep' ? 'sleep_hours' : 'water_l'] || 0), 0));
  }
  const unit = HABITS[habit].unit;
  const log = Array.from({ length: 8 }, (_, i) => {
    const date = addDays(today(), -(i + (habit === 'exercise' ? Math.floor(i * 0.4) : 0)));
    const rr = rng(m.id + habit + date);
    if (habit === 'exercise') return { date, label: m.sports[Math.floor(rr() * m.sports.length)], value: 20 + Math.round(rr() * 60), unit: 'min', met: null };
    const per = row.daily_target;
    const v = habit === 'sleep' ? round1(6.4 + rr() * 2.2) : round1(1.4 + rr() * 1.6);
    return { date, label: null, value: v, unit, met: v >= per };
  });
  const fmtT = (s) => (habit === 'exercise' ? `${s.target} min / week` : habit === 'sleep' ? `${s.daily_target} h / night` : `${s.daily_target} L / day`);
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
    if (habit === 'sleep') items.push({ text: `${first.display_name} leads with a ${first.streak}-day sleep streak. ${Math.max(1, first.streak - me.streak)} more nights on target and you catch up.`, action: null });
    else items.push({ text: `${first.display_name} is ahead by ${round1(first.value - me.value)} ${unit} this week. ${habit === 'exercise' ? 'One more session brings you closer to first place.' : 'One extra glass per day closes the gap.'}`, action: null });
  } else items.push({ text: 'You lead your network this week – keep the rhythm!', action: null });
  rows.filter((r) => r.can_cheer).slice(0, 2).forEach((r) => items.push({ text: `${r.display_name} reached the ${HABITS[habit].label.toLowerCase()} goal. A cheer takes one click and keeps the whole network motivated.`, action: 'cheer', member_id: r.member_id }));
  const improver = rows.filter((r) => !r.is_me).sort((a, b) => b.change_pct - a.change_pct)[0];
  if (improver && improver.change_pct > 10) items.push({ text: `${improver.display_name} improved by ${improver.change_pct} % compared to last week.`, action: null });
  return { habit, items, generated_at: new Date().toISOString(), source: 'mock' };
}, { slow: true });

function feedItems(user, limit) {
  const items = [];
  ['exercise', 'sleep', 'water'].forEach((habit) => {
    const { rows } = leaderboard(user, habit);
    rows.filter((r) => !r.is_me && r.goal_reached).forEach((r) => {
      const text = habit === 'exercise' ? `reached the weekly exercise goal (${r.value} min)` : habit === 'sleep' ? `is on target with sleep every night this week` : `hit the water goal every day this week`;
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
  const logs = db().daily_logs.filter((l) => l.user_id === user.id && l.log_date >= addDays(today(), -7) && l.sleep_hours);
  return {
    proteinTarget: t.protein_g, proteinToday: tot.protein_g, kcalTarget: t.kcal, kcalToday: tot.kcal,
    activityGoals: user.activity_goals || [], targetMinutes: weeklyTarget(user), weekMinutes: weekSummary(user).minutes,
    sleepAvg: logs.length ? round1(logs.reduce((s, l) => s + l.sleep_hours, 0) / logs.length) : null, sleepTarget: user.sleep_goal_h || 8,
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
