import { coach, workouts } from '../api.js';
import { initPage, $, esc, toast, setBusy, addDaysISO, todayISO } from '../ui.js';

await initPage('coach');

const chat = $('#chat');
const form = $('#chat-form');
const input = $('#chat-input');
let conversationId = null;
let busy = false;

const CHIPS = ['Build my training plan for next week', 'What should I eat before my run?', 'How can I get more protein?', 'How do I compare to my network?'];
const ACTIONS = [['Create next week\'s plan', 'Build my training plan for next week'], ['Close my protein gap', 'How can I get more protein?'], ['Improve my recovery', 'I feel tired – how can I sleep and recover better?']];
$('#chips').innerHTML = CHIPS.map((c) => `<button type="button" class="chip" style="font-size:13px;min-height:38px">${esc(c)}</button>`).join('');
$('#actions').innerHTML = ACTIONS.map(([l, q]) => `<button type="button" class="btn btn--ghost-dark" style="justify-content:flex-start" data-q="${esc(q)}">${esc(l)}</button>`).join('');
$('#chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });
$('#actions').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) send(b.dataset.q); });

function bubble(role, text) {
  const el = document.createElement('div');
  el.className = `bubble ${role === 'user' ? 'bubble--me' : role === 'error' ? 'bubble--error' : 'bubble--ai'}`;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

const DAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function nextWeekDate(day) {
  const d = new Date(); const back = (d.getDay() + 6) % 7;
  const nextMonday = addDaysISO(todayISO(), 7 - back);
  return addDaysISO(nextMonday, DAY_INDEX[day] ?? 0);
}
function proposal(sessions) {
  const box = document.createElement('div');
  box.className = 'bubble bubble--ai';
  box.innerHTML = `<b>Add these ${sessions.length} sessions to your plan?</b><br><span class="small muted">They appear as planned workouts on the Workouts page.</span><div class="row" style="margin-top:10px"><button type="button" class="btn btn--primary btn--small">Add to my plan</button></div>`;
  const btn = box.querySelector('button');
  btn.addEventListener('click', async () => {
    setBusy(btn, true);
    try {
      // Only this explicit click writes data – the AI never creates workouts by itself.
      for (const s of sessions) {
        await workouts.create({ sport: s.sport, performed_on: nextWeekDate(s.day), duration_min: s.minutes, intensity: 'medium', status: 'planned', title: 'Planned with AI Coach' });
      }
      btn.parentElement.innerHTML = '<span class="small" style="color:var(--brand);font-weight:700">Added to your plan ✓</span>';
    } catch (err) { setBusy(btn, false); toast(err.message, 'error'); }
  });
  chat.appendChild(box);
  chat.scrollTop = chat.scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  bubble('user', text);
  const typing = document.createElement('div');
  typing.className = 'typing'; typing.setAttribute('aria-label', 'Coach is typing');
  typing.innerHTML = '<span></span><span></span><span></span>';
  chat.appendChild(typing); chat.scrollTop = chat.scrollHeight;
  try {
    const res = await coach.send(conversationId, text, 'general');
    conversationId = res.conversation_id;
    typing.remove();
    bubble('assistant', res.message.content);
    if (res.proposed_sessions && res.proposed_sessions.length) proposal(res.proposed_sessions);
  } catch (err) {
    typing.remove();
    bubble('error', `${err.message} Please try again.`);
  } finally { busy = false; }
}

form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; send(v); });

$('#new-chat').addEventListener('click', async (e) => {
  setBusy(e.currentTarget, true);
  try {
    const res = await coach.newConversation();
    conversationId = res.conversation_id;
    chat.innerHTML = '';
    res.messages.forEach((m) => bubble(m.role, m.content));
  } catch (err) { toast(err.message, 'error'); } finally { setBusy(e.currentTarget, false); }
});

async function loadContext() {
  try {
    const { items } = await coach.context();
    $('#context').innerHTML = items.map((i, n) => `
      <div class="stack" style="gap:2px;padding:10px 0;${n < items.length - 1 ? 'border-bottom:1px solid var(--line-2)' : ''}">
        <span style="font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-2)">${esc(i.label)}</span>
        <b style="font-size:14px">${esc(i.value)}</b>${i.detail ? `<span class="small muted">${esc(i.detail)}</span>` : ''}
      </div>`).join('');
  } catch { $('#context').innerHTML = '<p class="small muted">Not available.</p>'; }
}

(async () => {
  try {
    const res = await coach.latest();
    conversationId = res.conversation_id;
    res.messages.forEach((m) => bubble(m.role, m.content));
  } catch (err) { bubble('error', err.message); }
  const q = new URLSearchParams(location.search).get('q');
  if (q) send(q);
})();
loadContext();
