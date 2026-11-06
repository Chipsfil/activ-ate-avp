/**
 * MOCK ONLY – in-browser "database" (localStorage) used while there is no backend.
 * Delete the whole assets/js/mock/ folder once the real API is connected.
 */
const KEY = 'activate.mockdb.v1';

/* ------------------------------------------------------------ Utilities */
export function rng(seed) {
  let s = typeof seed === 'number' ? seed : hash(String(seed));
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export function iso(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
export const today = () => iso();
export function addDays(isoDate, n) { const d = new Date(isoDate + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); }
export function weekStart(isoDate) { const d = new Date(isoDate + 'T12:00:00'); return addDays(isoDate, -((d.getDay() + 6) % 7)); }
export function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5); }
export const round1 = (n) => Math.round(n * 10) / 10;

/* -------------------------------------------------------------- Storage */
let cache = null;
export function db() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(KEY)); } catch { cache = null; }
  if (!cache || !cache.seeded) cache = seed();
  return cache;
}
export function save() { localStorage.setItem(KEY, JSON.stringify(cache)); }
export function resetMock() { localStorage.removeItem(KEY); cache = null; }

/* ------------------------------------------------------- Demo seed data */
function seed() {
  const data = {
    seeded: true,
    users: [], weights: [], tokens: {}, refresh: null,
    workouts: [], meals: [], estimates: [], daily_logs: [], cheers: [], chats: [],
  };
  const t = today();
  const user = {
    id: 'u-demo', username: 'demo', email: 'demo@activ-ate.app', password: 'demo1234',
    first_name: 'Lena', last_name: 'Meier', gender: 'female', date_of_birth: '1999-04-12', height_cm: 170,
    created_at: addDays(t, -60) + 'T09:00:00Z', onboarding_step: 'done',
    goals: ['gain_muscle', 'improve_stamina'],
    sports: [{ name: 'Weightlifting', sport_id: 'weightlifting' }, { name: 'Running', sport_id: 'running' }, { name: 'Cycling', sport_id: 'cycling' }],
    activity_goals: [
      { id: 'ag1', sport: 'Weightlifting', sport_id: 'weightlifting', minutes_per_session: 60, sessions_per_week: 4 },
      { id: 'ag2', sport: 'Running', sport_id: 'running', minutes_per_session: 20, sessions_per_week: 3 },
    ],
    nutrition_goals: [
      { nutrient: 'calories', amount: 2600 }, { nutrient: 'protein', amount: 140 }, { nutrient: 'water', amount: 2 },
    ],
    sleep_goal_h: 8,
    weight_goal: { start_kg: 62.5, target_kg: 67, target_date: '2027-02-01' },
    network_id: null,
  };
  data.users.push(user);
  data.weights.push({ user_id: user.id, weight_kg: 62.5, measured_on: addDays(t, -60) }, { user_id: user.id, weight_kg: 64.0, measured_on: addDays(t, -2) });

  const r = rng(42);
  const ws = weekStart(t);
  const kcalOf = (met, min) => Math.round(met * 64 * min / 60);
  const titles = { Weightlifting: ['Lower body', 'Upper body', 'Full body', 'Push day', 'Pull day'], Running: ['Easy run', 'Intervals', 'Greifensee loop', 'Tempo run'], Cycling: ['Commute', 'Evening ride'] };
  for (let w = 8; w >= 0; w--) {
    const start = addDays(ws, -7 * w);
    const plan = [
      [0, 'Weightlifting', 6.0, 55 + Math.round(r() * 15)],
      [1, 'Running', 9.8, 20 + Math.round(r() * 15)],
      [2, 'Weightlifting', 6.0, 50 + Math.round(r() * 20)],
      [3, 'Running', 9.8, 20 + Math.round(r() * 10)],
      [4, 'Weightlifting', 6.0, 55 + Math.round(r() * 10)],
      [5, r() > .5 ? 'Cycling' : 'Running', 8.0, 30 + Math.round(r() * 40)],
    ];
    plan.forEach(([dow, sport, met, min]) => {
      const date = addDays(start, dow);
      if (date >= t) return;               // nothing for today/future → user can log it live
      if (r() < 0.18) return;               // some missed sessions
      const list = titles[sport];
      const isRun = sport === 'Running';
      data.workouts.push({
        id: uid('w-'), user_id: user.id, sport, sport_id: sport.toLowerCase(), title: list[Math.floor(r() * list.length)],
        performed_on: date, duration_min: min, distance_km: isRun ? round1(min / 6.1) : (sport === 'Cycling' ? round1(min / 2.6) : null),
        intensity: r() > .6 ? 'high' : 'medium', notes: '', kcal: kcalOf(met, min), status: 'done', created_at: date + 'T18:00:00Z',
      });
    });
  }

  const mealSets = [
    ['breakfast', 'Oats with berries & whey', 520, 34, 72, 11],
    ['lunch', 'Chicken rice bowl', 780, 48, 92, 22],
    ['snack', 'Greek yogurt & honey', 220, 18, 24, 5],
    ['dinner', 'Salmon, potatoes & broccoli', 610, 38, 55, 24],
    ['snack', 'Banana & almonds', 320, 8, 34, 18],
  ];
  for (let d = 7; d >= 0; d--) {
    const date = addDays(t, -d);
    const set = d === 0 ? [0, 1, 2] : [0, 1, 2, 3, 4].filter(() => r() > .15);
    set.forEach((i) => {
      const [meal_type, description, kcal, p, c, f] = mealSets[i];
      const k = d === 0 ? 1 : 0.85 + r() * 0.3;
      data.meals.push({ id: uid('m-'), user_id: user.id, eaten_on: date, meal_type, description, source: i === 2 ? 'manual' : 'ai',
        kcal: Math.round(kcal * k), protein_g: round1(p * k), carbs_g: round1(c * k), fat_g: round1(f * k), items: [], created_at: date + 'T12:00:00Z' });
    });
  }
  for (let d = 13; d >= 1; d--) {
    data.daily_logs.push({ user_id: user.id, log_date: addDays(t, -d), sleep_hours: round1(6.8 + r() * 1.6), water_l: round1(1.4 + r() * 1.2) });
  }
  cache = data;
  save();
  return data;
}
