/**
 * Shared UI helpers: page bootstrap (auth guard + sidebar), toasts, escaping, formatting.
 */
import { auth, me as meApi } from './api.js';

/* ----------------------------------------------------------------- Icons */
const svg = (d, size = 20, sw = 1.7) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const icons = {
  logo: `<img class="brand-logo" src="assets/img/logo-mark.svg" alt="" width="40" height="40">`,
  dashboard: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  workouts: svg('<path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/>'),
  nutrition: svg('<path d="M7 2v9a3 3 0 0 0 3 3v8M7 2v6M11 2v6M17 2c-2 2-3 5-3 9h3v11"/>'),
  goals: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  community: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5c2.4.2 4 1.8 4.5 4.5"/>'),
  coach: svg('<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01M12 11h.01M15 11h.01"/>'),
  logout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'),
  spark: svg('<path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2"/>', 18, 2.2),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 18, 2.6),
  check: svg('<path d="M5 12l5 5L19 7"/>', 18, 2.6),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18, 2.4),
  run: svg('<circle cx="14" cy="4" r="2"/><path d="M7 22l3-7 3 2v5M10 15l1-6 4 3 3-1M6 11l3-3 3 1"/>', 22),
  dumbbell: svg('<path d="M6 7v10M3 9.5v5M18 7v10M21 9.5v5M6 12h12"/>', 22),
  send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 20, 2.2),
  back: svg('<path d="M15 6l-6 6 6 6"/>', 16, 2.4),
  next: svg('<path d="M9 6l6 6-6 6"/>', 16, 2.4),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.2-6 8-6s7 2 8 6"/>', 18),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 18),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>', 18),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 18),
  menu: svg('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', 18),
  clap: svg('<path d="M7 11l4-4a2 2 0 0 1 3 3l-1 1 3-3a2 2 0 0 1 3 3l-6 6a5 5 0 0 1-7 0l-1-1a3 3 0 0 1 0-4l2-2"/>', 16),
};

/* -------------------------------------------------------------- Helpers */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Escape any user/backend provided text before putting it into innerHTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  return Number(n).toLocaleString('de-CH', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(value, target) {
  if (!target) return 0;
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)));
}

export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

export function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return todayISO(d);
}

export function formatDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', opts);
}

export function relativeDay(iso) {
  const t = todayISO();
  if (iso === t) return 'Today';
  if (iso === addDaysISO(t, -1)) return 'Yesterday';
  return formatDate(iso);
}

export function initials(first = '', last = '') {
  return ((first[0] || '') + (last[0] || '')).toUpperCase() || '?';
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function track(value, target, warm = false, thick = false) {
  return `<div class="track${warm ? ' track--warm' : ''}${thick ? ' track--thick' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct(value, target)}"><span style="width:${pct(value, target)}%"></span></div>`;
}

/* ---------------------------------------------------- Busy / form errors */
export function setBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${busyLabel ? esc(busyLabel) : ''}`;
  } else {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export function clearErrors(form) {
  $$('.field-error', form).forEach((e) => e.remove());
  $$('[aria-invalid="true"]', form).forEach((e) => e.removeAttribute('aria-invalid'));
  const fe = $('.form-error', form);
  if (fe) fe.hidden = true;
}

/** Show an ApiError next to its field (error.field) or in the form's .form-error box. */
export function showError(form, error) {
  const input = error.field ? form.querySelector(`[name="${error.field}"]`) : null;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    const msg = document.createElement('span');
    msg.className = 'field-error';
    msg.textContent = error.message;
    (input.closest('.field') || input.parentElement).appendChild(msg);
    input.focus();
    return;
  }
  const box = $('.form-error', form);
  if (box) { box.textContent = error.message; box.hidden = false; }
  else toast(error.message, 'error');
}

/* ----------------------------------------------------------------- Toast */
export function toast(message, type = 'ok') {
  let host = $('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast--error' : '');
  el.innerHTML = (type === 'error' ? '' : `<span style="color:var(--mint)">${icons.check}</span>`) + esc(message);
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* --------------------------------------------------------------- Sidebar */
const NAV = [
  { id: 'dashboard', href: 'dashboard.html', label: 'Dashboard', icon: icons.dashboard },
  { id: 'workouts', href: 'workouts.html', label: 'Workouts', icon: icons.workouts },
  { id: 'nutrition', href: 'nutrition.html', label: 'Nutrition', icon: icons.nutrition },
  { id: 'goals', href: 'goals.html', label: 'Goals', icon: icons.goals },
  { id: 'community', href: 'community.html', label: 'Community', icon: icons.community },
  { id: 'coach', href: 'coach.html', label: 'AI Coach', icon: icons.coach },
];

const GOAL_LABELS = { lose_weight: 'Lose weight', gain_muscle: 'Gain muscle', improve_stamina: 'Stamina' };

function renderSidebar(active, user) {
  const host = $('#sidebar');
  if (!host) return;
  const goals = (user.goals || []).map((g) => GOAL_LABELS[g] || g).join(' · ') || 'Set your goals';
  host.className = 'sidebar';
  host.setAttribute('aria-label', 'Main navigation');
  host.innerHTML = `
    <div class="sidebar-top">
      <a class="brand" href="dashboard.html" aria-label="Activ-Ate – Dashboard">${icons.logo}<span class="brand-name">Activ<i>-</i>Ate</span></a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="nav-main" aria-label="Open menu">${icons.menu}</button>
    </div>
    <nav class="nav" id="nav-main">
      ${NAV.map((n) => `<a href="${n.href}"${n.id === active ? ' aria-current="page"' : ''}>${n.icon}${n.label}</a>`).join('')}
    </nav>
    <div class="sidebar-foot">
      <div class="nav"><button type="button" id="logout-btn">${icons.logout}Log out</button></div>
      <div class="user-card">
        <span class="avatar avatar--me">${esc(user.initials || initials(user.first_name, user.last_name))}</span>
        <div style="min-width:0"><div class="name">${esc(user.first_name)} ${esc(user.last_name)}</div><div class="sub">${esc(goals)}</div></div>
      </div>
    </div>`;
  const toggle = $('.menu-toggle', host);
  toggle.addEventListener('click', () => {
    const open = host.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  $('#logout-btn', host).addEventListener('click', async () => {
    await auth.logout();
    window.location.href = 'signin.html';
  });
}

/**
 * Bootstraps every logged-in page:
 * 1. restores the session (POST /auth/refresh) or redirects to sign-in,
 * 2. redirects to onboarding if it is not finished,
 * 3. renders the sidebar.
 * Returns the current user (GET /me shape).
 */
export async function initPage(active) {
  const restored = await auth.restore();
  if (!restored) {
    window.location.replace('signin.html');
    return new Promise(() => {});
  }
  const user = await meApi.get();
  if (user.onboarding_step !== 'done') {
    window.location.replace('signup.html');
    return new Promise(() => {});
  }
  renderSidebar(active, user);
  document.body.classList.add('ready');
  return user;
}

export function goalLabel(g) { return GOAL_LABELS[g] || g; }
