/**
 * Waiting page: shown to participants after onboarding while the admin has paused
 * the study (GET /me → app.paused === true). Polls /me and opens the dashboard as
 * soon as the admin starts the study.
 */
import { auth, me } from '../api.js';
import { $, esc, homeFor, setBusy } from '../ui.js';

const POLL_MS = 15000;

const user = await auth.restore();
if (!user || homeFor(user) !== 'waiting.html') {
  location.replace(homeFor(user));
} else {
  $('#wait-user').innerHTML = `Signed in as <b>${esc(user.username)}</b>`;
  document.body.classList.add('ready');
  setInterval(check, POLL_MS);
}

async function check(manual = false) {
  const btn = $('#check-now');
  if (manual) setBusy(btn, true, 'Checking…');
  try {
    const fresh = await me.get();
    const next = homeFor(fresh);
    if (next !== 'waiting.html') {
      $('#wait-status').textContent = 'Activ-Ate has started – opening your dashboard…';
      location.replace(next);
      return;
    }
    if (manual) $('#wait-status').textContent = `Not started yet (checked at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}). We'll keep checking for you.`;
  } catch {
    $('#wait-status').textContent = 'Could not reach the server. We will try again in a moment.';
  } finally {
    if (manual) setBusy(btn, false);
  }
}

$('#check-now').addEventListener('click', () => check(true));
$('#logout').addEventListener('click', async () => {
  await auth.logout();
  location.replace('signin.html');
});
