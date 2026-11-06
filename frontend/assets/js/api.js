/**
 * API client – the ONLY place where the frontend talks to the backend.
 *
 * Every function below maps 1:1 to an endpoint documented in docs/API.md.
 * A backend developer implements those endpoints and sets CONFIG.USE_MOCK_API = false.
 *
 * Demo auth model for two-VM HTTP deployments:
 *  - access token (JWT, short-lived) is kept in memory only and sent as "Authorization: Bearer …"
 *  - refresh token is an HttpOnly cookie set by the backend; every page calls auth.restore() on load,
 *    which calls POST /auth/refresh to obtain a fresh access token.
 */
import { CONFIG } from './config.js';

let accessToken = (() => {
  try { return sessionStorage.getItem('activate.accessToken'); } catch { return null; }
})();
let mockModule = null;

function clearSession() {
  accessToken = null;
  try { sessionStorage.removeItem('activate.accessToken'); } catch { /* storage may be disabled */ }
}

export class ApiError extends Error {
  constructor(status, body = {}) {
    super(body.message || `Request failed (${status})`);
    this.status = status;
    this.code = body.error || 'error';
    this.field = body.field || null;
    this.body = body;
  }
}

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? '?' + new URLSearchParams(entries).toString() : '';
}

async function transport(method, path, body) {
  if (CONFIG.USE_MOCK_API) {
    if (!mockModule) mockModule = await import('./mock/mock-server.js');
    return mockModule.handle(method, path, body, accessToken);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.API_BASE_URL + path, {
      method,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') return { status: 504, data: { error: 'timeout', message: 'The server took too long to answer. Please try again.' } };
    return { status: 0, data: { error: 'network', message: 'No connection to the server. Check your internet connection.' } };
  } finally {
    clearTimeout(timer);
  }
}

async function request(method, path, body, { retryOn401 = true } = {}) {
  const { status, data } = await transport(method, path, body);
  if (status === 401 && retryOn401 && !path.startsWith('/auth/')) {
    const ok = await auth.restore();
    if (ok) return request(method, path, body, { retryOn401: false });
    window.location.href = 'signin.html?expired=1';
    throw new ApiError(401, data);
  }
  if (status < 200 || status >= 300) {
    const body = data && typeof data === 'object' ? data : {};
    if (!body.message) {
      body.message = status >= 500 || status === 404 || status === 405
        ? `The server is not available right now (error ${status}). Please try again later.`
        : `Something went wrong (error ${status}). Please try again.`;
    }
    throw new ApiError(status, body);
  }
  return data;
}

const get = (p, q) => request('GET', p + qs(q));
const post = (p, b = {}) => request('POST', p, b);
const put = (p, b = {}) => request('PUT', p, b);
const patch = (p, b = {}) => request('PATCH', p, b);
const del = (p) => request('DELETE', p);

function setSession(data) {
  if (data && data.access_token) {
    accessToken = data.access_token;
    try { sessionStorage.setItem('activate.accessToken', accessToken); } catch { /* storage may be disabled */ }
  }
  return data;
}

/* ------------------------------------------------------------------ Auth */
export const auth = {
  /** POST /auth/register → { access_token, user } */
  register: async (payload) => setSession(await post('/auth/register', payload)),
  /** POST /auth/login → { access_token, user } */
  login: async (username, password) => setSession(await post('/auth/login', { username, password })),
  /** POST /auth/refresh (uses HttpOnly cookie) → { access_token, user }. Returns user or null. */
  restore: async () => {
    if (accessToken) {
      const { status, data } = await transport('GET', '/me');
      if (status === 200) return data;
      clearSession();
    }
    try {
      const data = setSession(await request('POST', '/auth/refresh', {}, { retryOn401: false }));
      return data.user;
    } catch { clearSession(); return null; }
  },
  logout: async () => { try { await post('/auth/logout'); } finally { clearSession(); } },
  usernameAvailable: (username) => get('/auth/username-available', { username }),
};

/* ------------------------------------------------------- Profile & goals */
export const me = {
  get: () => get('/me'),
  saveGoals: (payload) => put('/me/goals', payload),          // { goals:[], sports:[{name, sport_id}] }
  getTargets: () => get('/me/targets'),
  saveTargets: (payload) => put('/me/targets', payload),
  completeOnboarding: () => post('/me/onboarding/complete'),
  checkGoals: (payload) => post('/goals/check', payload),
};

/* ---------------------------------------------------------------- Sports */
export const sports = {
  /** GET /sports?q=…&limit=… → { items:[{ id, name, category, met }] } */
  search: (q, limit = 8) => get('/sports', { q, limit }),
};

/* ------------------------------------------------------------- Dashboard */
export const dashboard = {
  get: (date) => get('/dashboard', { date }),
  saveDailyLog: (payload) => put('/daily-logs', payload),      // { date, sleep_hours?, water_l? }
};

/* -------------------------------------------------------------- Workouts */
export const workouts = {
  list: (params) => get('/workouts', params),                 // { limit, cursor, sport }
  stats: (weeks = 8) => get('/workouts/stats', { weeks }),
  create: (payload) => post('/workouts', payload),
  update: (id, payload) => patch(`/workouts/${encodeURIComponent(id)}`, payload),
  remove: (id) => del(`/workouts/${encodeURIComponent(id)}`),
};

/* ------------------------------------------------------------- Nutrition */
export const nutrition = {
  summary: (date) => get('/nutrition/summary', { date }),
  meals: (date) => get('/meals', { date }),
  estimate: (text, meal_type) => post('/meals/estimate', { text, meal_type }),
  createMeal: (payload) => post('/meals', payload),
  removeMeal: (id) => del(`/meals/${encodeURIComponent(id)}`),
};

/* ------------------------------------------------------- Recommendations */
export const recommendations = {
  daily: () => get('/recommendations/daily'),
  workout: () => get('/recommendations/workout'),
  nutrition: () => get('/recommendations/nutrition'),
};

/* ------------------------------------------------------------- Community */
export const community = {
  network: () => get('/community/network'),
  leaderboard: (habit, period = 'week') => get('/community/leaderboard', { habit, period }),
  member: (id, habit, period) => get(`/community/members/${encodeURIComponent(id)}`, { habit, period }),
  cheer: (id, habit) => post(`/community/members/${encodeURIComponent(id)}/cheers`, { habit }),
  insights: (habit) => get('/community/insights', { habit }),
  feed: (limit = 10) => get('/feed', { limit }),
};

/* ---------------------------------------------------------------- Coach */
export const coach = {
  context: () => get('/coach/context'),
  latest: () => get('/coach/conversations/latest'),
  newConversation: () => post('/coach/conversations'),
  send: (conversation_id, text, topic = 'general') => post('/coach/messages', { conversation_id, text, topic }),
};

export const api = { auth, me, sports, dashboard, workouts, nutrition, recommendations, community, coach };
export default api;
