/**
 * Reusable "log a workout" form (Workouts page + dashboard dialog).
 * Submits POST /workouts and calls onSaved(response) on success.
 */
import { workouts } from '../api.js';
import { $, $$, esc, setBusy, clearErrors, showError, todayISO } from '../ui.js';
import { sportCombobox } from './sport-combobox.js';

const CARDIO = /run|jog|walk|hik|cycl|bik|swim|row|ski|skat|padd|kayak|canoe|triathlon|orienteer/i;

export function mountWorkoutForm(host, { sports = [], onSaved = () => {}, onCancel = null } = {}) {
  host.innerHTML = `
    <form class="stack-lg" novalidate>
      <div class="form-error" role="alert" hidden></div>
      <div class="field">
        <label for="wf-sport">Sport</label>
        <div class="combo"><input class="input" id="wf-sport" name="sport" placeholder="Type a sport, e.g. Running"></div>
        ${sports.length ? `<div class="chips" style="margin-top:6px">${sports.map((s, i) => `<button type="button" class="chip" data-quick="${i}">${esc(s.name)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="field"><label for="wf-title">Title <span class="muted" style="font-weight:500">(optional)</span></label>
        <input class="input" id="wf-title" name="title" maxlength="80" placeholder="e.g. Lower body, Greifensee loop"></div>
      <div class="form-grid--2">
        <div class="field"><label for="wf-date">Date</label><input class="input" id="wf-date" name="performed_on" type="date" max="${todayISO()}" value="${todayISO()}"></div>
        <div class="field"><label for="wf-dur">Duration (min)</label><input class="input" id="wf-dur" name="duration_min" type="number" inputmode="numeric" min="1" max="600" placeholder="e.g. 38"></div>
      </div>
      <div class="field" data-distance hidden><label for="wf-dist">Distance (km, optional)</label><input class="input" id="wf-dist" name="distance_km" type="number" inputmode="decimal" min="0" max="500" step="0.1" placeholder="e.g. 6.2"></div>
      <div class="field"><span>Intensity</span>
        <div class="pill-grid" role="group" aria-label="Intensity">
          <button type="button" class="pill" data-int="light" aria-pressed="false">Light</button>
          <button type="button" class="pill" data-int="medium" aria-pressed="true">Medium</button>
          <button type="button" class="pill" data-int="high" aria-pressed="false">High</button>
        </div>
      </div>
      <div class="field"><label for="wf-notes">Exercises &amp; notes <span class="muted" style="font-weight:500">(optional)</span></label>
        <textarea class="input" id="wf-notes" name="notes" rows="3" maxlength="1000" placeholder="e.g. Squats 4×8 at 60 kg, lunges 3×12"></textarea></div>
      <div class="row" style="justify-content:flex-end">
        ${onCancel ? '<button type="button" class="btn" data-cancel>Cancel</button>' : ''}
        <button type="submit" class="btn btn--primary">Save workout</button>
      </div>
    </form>`;

  const form = $('form', host);
  let intensity = 'medium';
  const distField = $('[data-distance]', form);
  const updateDistance = (name) => { distField.hidden = !CARDIO.test(name || ''); };
  const combo = sportCombobox($('#wf-sport', form), { onSelect: (s) => updateDistance(s.name) });
  $('#wf-sport', form).addEventListener('input', (e) => updateDistance(e.target.value));

  $$('[data-quick]', form).forEach((b) => b.addEventListener('click', () => {
    const s = sports[Number(b.dataset.quick)];
    combo.set(s); updateDistance(s.name);
    $('#wf-dur', form).focus();
  }));
  $$('[data-int]', form).forEach((b) => b.addEventListener('click', () => {
    intensity = b.dataset.int;
    $$('[data-int]', form).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  if (onCancel) $('[data-cancel]', form).addEventListener('click', onCancel);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(form);
    const sport = combo.value();
    if (!sport) return showError(form, { field: 'sport', message: 'Please choose or type a sport.' });
    const duration = Number(form.duration_min.value);
    if (!(duration >= 1 && duration <= 600)) return showError(form, { field: 'duration_min', message: 'Duration must be between 1 and 600 minutes.' });
    const btn = $('[type="submit"]', form);
    setBusy(btn, true, 'Saving…');
    try {
      const res = await workouts.create({
        sport: sport.name, sport_id: sport.sport_id || null, title: form.title.value.trim() || null,
        performed_on: form.performed_on.value, duration_min: duration,
        distance_km: !distField.hidden && form.distance_km.value ? Number(form.distance_km.value) : null,
        intensity, notes: form.notes.value.trim(), status: 'done',
      });
      form.reset();
      form.performed_on.value = todayISO();
      combo.clear();
      updateDistance('');
      onSaved(res);
    } catch (err) {
      showError(form, err);
    } finally { setBusy(btn, false); }
  });

  return { focus: () => $('#wf-sport', form).focus() };
}
