import { auth, me } from '../api.js';
import { CONFIG } from '../config.js';
import { $, setBusy, clearErrors, showError } from '../ui.js';
import { wireRevealButtons } from './auth-common.js';

const form = $('#signin-form');
const params = new URLSearchParams(location.search);
if (params.get('expired')) $('#expired-note').hidden = false;
if (CONFIG.USE_MOCK_API) $('#mock-note').hidden = false;
if (params.get('reset')) { const n = $('#expired-note'); n.textContent = 'Password changed. Please sign in with your new password.'; n.hidden = false; }

wireRevealButtons();

// Already signed in? Go straight to the app.
auth.restore().then((user) => { if (user) location.replace(user.onboarding_step === 'done' ? 'dashboard.html' : 'signup.html'); });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(form);
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username) return showError(form, { field: 'username', message: 'Please enter your username or email.' });
  if (!password) return showError(form, { field: 'password', message: 'Please enter your password.' });
  const btn = form.querySelector('[type="submit"]');
  setBusy(btn, true, 'Signing in…');
  try {
    const { user } = await auth.login(username, password);
    const fresh = user || (await me.get());
    location.href = fresh.onboarding_step === 'done' ? 'dashboard.html' : 'signup.html';
  } catch (err) {
    setBusy(btn, false);
    showError(form, err.status === 401 ? { message: err.message } : err);
  }
});
