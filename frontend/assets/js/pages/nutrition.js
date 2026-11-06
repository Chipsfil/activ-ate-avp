/**
 * Nutrition: AI estimate is a 2-step flow
 *   1. POST /meals/estimate  → shown for review, NOT saved as a meal
 *   2. POST /meals (with estimate_id + possibly edited totals) → saved
 */
import { nutrition, recommendations, coach } from '../api.js';
import { initPage, $, $$, esc, fmt, track, todayISO, addDaysISO, formatDate, toast, setBusy, clearErrors, showError, icons } from '../ui.js';

await initPage('nutrition');

const EXAMPLE = '100 g toast, 50 g cheese, 1 tomato, 150 g chicken, 10 g butter';
const state = { day: todayISO(), mealType: guessMealType(), estimate: null, conversationId: null };

function guessMealType() {
  const h = new Date().getHours();
  return h < 10 ? 'breakfast' : h < 14 ? 'lunch' : h < 17 ? 'snack' : 'dinner';
}

/* ----------------------------------------------------------- Day */
const dayInput = $('#day');
dayInput.max = todayISO();
function setDay(d) {
  state.day = d > todayISO() ? todayISO() : d;
  dayInput.value = state.day;
  $('#next-day').disabled = state.day >= todayISO();
  $('#date-lead').textContent = `${state.day === todayISO() ? 'Today, ' : ''}${formatDate(state.day, { weekday: 'long', day: 'numeric', month: 'long' })}`;
  $('#meals-title').textContent = state.day === todayISO() ? "Today's meals" : `Meals on ${formatDate(state.day)}`;
  loadDay();
}
$('#prev-day').addEventListener('click', () => setDay(addDaysISO(state.day, -1)));
$('#next-day').addEventListener('click', () => setDay(addDaysISO(state.day, 1)));
dayInput.addEventListener('change', () => dayInput.value && setDay(dayInput.value));

/* ----------------------------------------------------------- Totals & meals */
async function loadDay() {
  try {
    const [sum, meals] = await Promise.all([nutrition.summary(state.day), nutrition.meals(state.day)]);
    renderTotals(sum);
    renderMeals(meals.items);
  } catch (err) { toast(err.message, 'error'); }
}
function renderTotals({ totals: t, targets: g }) {
  const cell = (label, v, target, unit, warm) => {
    const left = target - v;
    return `<div class="stack" style="gap:10px"><span class="kpi-label">${label}</span>
      <span class="kpi-value" style="font-size:28px">${fmt(v)} <small>/ ${fmt(target)} ${unit}</small></span>
      ${track(v, target, warm)}<span class="small muted">${left > 0 ? `${fmt(left)} ${unit} left` : 'Target reached ✓'}</span></div>`;
  };
  $('#totals').innerHTML = cell('Calories', t.kcal, g.kcal, 'kcal') + cell('Protein', t.protein_g, g.protein_g, 'g', true) + cell('Carbs', t.carbs_g, g.carbs_g, 'g') + cell('Fat', t.fat_g, g.fat_g, 'g');
}
const TYPE_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' };
function renderMeals(items) {
  $('#meals').innerHTML = items.length ? items.map((m) => `
    <div class="list-row">
      <span style="width:84px;flex-shrink:0;font-size:13px;font-weight:700;color:var(--orange-ink)">${TYPE_LABEL[m.meal_type] || esc(m.meal_type)}</span>
      <span class="grow"><span class="title">${esc(m.description)}</span><br><span class="meta">P ${fmt(m.protein_g)} g · C ${fmt(m.carbs_g)} g · F ${fmt(m.fat_g)} g</span></span>
      <span class="tag ${m.source === 'ai' ? 'tag--brand' : ''}">${m.source === 'ai' ? 'AI estimate' : 'Manual'}</span>
      <span class="num nowrap" style="width:84px;text-align:right">${fmt(m.kcal)} kcal</span>
      <button type="button" class="btn btn--icon btn--small" data-del="${esc(m.id)}" aria-label="Delete meal">${icons.trash}</button>
    </div>`).join('') : '<div class="empty">No meals logged for this day.</div>';
}
$('#meals').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b || !confirm('Delete this meal?')) return;
  setBusy(b, true);
  try { await nutrition.removeMeal(b.dataset.del); toast('Meal deleted'); loadDay(); }
  catch (err) { setBusy(b, false); toast(err.message, 'error'); }
});

/* ----------------------------------------------------------- Meal type + tabs */
function renderTypes() { $$('#meal-types [data-type]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === state.mealType))); }
$('#meal-types').addEventListener('click', (e) => { const b = e.target.closest('[data-type]'); if (b) { state.mealType = b.dataset.type; renderTypes(); } });
renderTypes();

function showTab(manual) {
  $('#tab-ai').setAttribute('aria-selected', String(!manual));
  $('#tab-manual').setAttribute('aria-selected', String(manual));
  $('#panel-ai').hidden = manual;
  $('#panel-manual').hidden = !manual;
}
$('#tab-ai').addEventListener('click', () => showTab(false));
$('#tab-manual').addEventListener('click', () => showTab(true));

/* ----------------------------------------------------------- AI estimate */
const describe = $('#describe-form');
const review = $('#review-form');
$('#use-example').addEventListener('click', () => { describe.text.value = EXAMPLE; describe.text.focus(); });

describe.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(describe);
  const text = describe.text.value.trim();
  if (text.length < 3) return showError(describe, { field: 'text', message: 'Please describe what you ate.' });
  const btn = $('[type="submit"]', describe);
  setBusy(btn, true, 'AI is analysing…');
  try {
    const est = await nutrition.estimate(text, state.mealType);
    state.estimate = { ...est, text };
    showReview();
  } catch (err) {
    showError(describe, err.status >= 500 || err.status === 0 ? { message: `${err.message} You can also enter the values manually.` } : err);
  } finally { setBusy(btn, false); }
});

function showReview() {
  const est = state.estimate;
  $('#review-text').textContent = `“${est.text}”`;
  $('#review-items').innerHTML = `<div class="tr th"><span>Food</span><span>Amount</span><span class="text-right">kcal</span><span class="text-right">Protein</span><span class="text-right">Carbs</span><span class="text-right">Fat</span></div>` +
    est.items.map((i) => `<div class="tr"><b>${esc(i.name)}</b><span class="muted">${fmt(i.amount_g)} g${i.assumed ? ' <span class="tag tag--warm" title="Amount assumed by AI">assumed</span>' : ''}</span><span class="text-right">${fmt(i.kcal)}</span><span class="text-right">${fmt(i.protein_g, 1)} g</span><span class="text-right">${fmt(i.carbs_g, 1)} g</span><span class="text-right">${fmt(i.fat_g, 1)} g</span></div>`).join('');
  review.kcal.value = Math.round(est.totals.kcal);
  review.protein_g.value = Math.round(est.totals.protein_g);
  review.carbs_g.value = Math.round(est.totals.carbs_g);
  review.fat_g.value = Math.round(est.totals.fat_g);
  describe.hidden = true;
  review.hidden = false;
  clearErrors(review);
}
$('#edit-description').addEventListener('click', () => { review.hidden = true; describe.hidden = false; describe.text.focus(); });

review.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(review);
  const est = state.estimate;
  const btn = $('[type="submit"]', review);
  setBusy(btn, true, 'Saving…');
  try {
    const name = est.items.map((i) => i.name).slice(0, 3).join(', ') + (est.items.length > 3 ? ' …' : '');
    await nutrition.createMeal({
      estimate_id: est.estimate_id, meal_type: state.mealType, eaten_on: state.day, description: name,
      kcal: Number(review.kcal.value), protein_g: Number(review.protein_g.value), carbs_g: Number(review.carbs_g.value), fat_g: Number(review.fat_g.value),
      items: est.items,
    });
    toast(`${TYPE_LABEL[state.mealType]} saved · ${review.kcal.value} kcal`);
    state.estimate = null;
    describe.reset();
    review.hidden = true; describe.hidden = false;
    loadDay();
  } catch (err) { showError(review, err); } finally { setBusy(btn, false); }
});

/* ----------------------------------------------------------- Manual */
const manual = $('#manual-form');
manual.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(manual);
  if (manual.kcal.value === '') return showError(manual, { field: 'kcal', message: 'Please enter the calories.' });
  const btn = $('[type="submit"]', manual);
  setBusy(btn, true, 'Saving…');
  try {
    await nutrition.createMeal({
      meal_type: state.mealType, eaten_on: state.day, description: manual.description.value.trim() || TYPE_LABEL[state.mealType],
      kcal: Number(manual.kcal.value), protein_g: Number(manual.protein_g.value || 0), carbs_g: Number(manual.carbs_g.value || 0), fat_g: Number(manual.fat_g.value || 0),
    });
    toast('Meal saved');
    manual.reset();
    loadDay();
  } catch (err) { showError(manual, err); } finally { setBusy(btn, false); }
});

/* ----------------------------------------------------------- AI advice + questions */
async function loadAdvice() {
  try {
    const r = await recommendations.nutrition();
    const pills = (arr) => arr.map((x) => `<span class="chip" style="cursor:default;background:var(--side-3);border-color:transparent;color:var(--side-ink);min-height:32px;font-size:13px">${esc(x)}</span>`).join('');
    $('#ai-nutrition').innerHTML = `<p class="muted" style="line-height:1.55">${esc(r.text)}</p>
      ${r.more_of.length ? `<div class="stack" style="gap:8px"><span class="ai-tag">Get more of</span><div class="chips">${pills(r.more_of)}</div></div>` : ''}
      ${r.watch.length ? `<div class="stack" style="gap:8px"><span class="ai-tag ai-tag--warm">Watch</span><div class="chips">${pills(r.watch)}</div></div>` : ''}`;
  } catch { $('#ai-nutrition').innerHTML = '<p class="muted">Advice not available right now.</p>'; }
}

const QUESTIONS = ['Which nutrients do I need more of?', 'What should I eat after strength training?', 'Am I eating enough for my goal?', 'What should I eat before a run?'];
$('#questions').innerHTML = QUESTIONS.map((q) => `<button type="button" class="btn" style="justify-content:flex-start;white-space:normal;text-align:left;height:auto;padding:10px 14px">${esc(q)}</button>`).join('');
$('#questions').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
$('#ask-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#ask').value.trim(); if (v) { ask(v); $('#ask').value = ''; } });

async function ask(q) {
  const box = $('#answer');
  box.innerHTML = `<div class="bubble bubble--me">${esc(q)}</div><div class="typing" aria-label="Coach is typing"><span></span><span></span><span></span></div>`;
  try {
    const res = await coach.send(state.conversationId, q, 'nutrition');
    state.conversationId = res.conversation_id;
    box.innerHTML = `<div class="bubble bubble--me">${esc(q)}</div><div class="bubble bubble--ai">${esc(res.message.content)}</div>`;
  } catch (err) {
    box.innerHTML = `<div class="bubble bubble--me">${esc(q)}</div><div class="bubble bubble--error">${esc(err.message)}</div>`;
  }
}

setDay(todayISO());
loadAdvice();
