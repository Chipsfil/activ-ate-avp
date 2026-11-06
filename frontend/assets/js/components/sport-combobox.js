/**
 * Sport autocomplete (ARIA combobox).
 * Suggestions come from GET /sports?q=… (backend: list of ~1000 sports with MET / kcal per minute).
 * Users may also keep free text that is not in the list → { name, sport_id: null }.
 *
 * Usage:
 *   const combo = sportCombobox(inputEl, { onSelect: (sport) => …, clearOnSelect: true });
 *   combo.value()   // → { name, sport_id, met } | null
 *   combo.set(sport)
 */
import { sports } from '../api.js';
import { esc, debounce } from '../ui.js';

let uid = 0;

export function sportCombobox(input, { onSelect = () => {}, clearOnSelect = false, limit = 8 } = {}) {
  const id = `sport-list-${++uid}`;
  const wrap = input.closest('.combo') || input.parentElement;
  const list = document.createElement('ul');
  list.className = 'combo-list';
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.hidden = true;
  wrap.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', id);
  input.setAttribute('autocomplete', 'off');

  let options = [];
  let active = -1;
  let selected = null;
  let reqId = 0;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function render(q) {
    const exact = options.some((o) => o.name.toLowerCase() === q.toLowerCase());
    const items = options.map((o, i) => `
      <li class="combo-option" role="option" id="${id}-${i}" data-i="${i}" aria-selected="${i === active}">
        <span>${esc(o.name)}</span><span class="meta">${esc(o.category || '')}</span>
      </li>`);
    if (q && !exact) {
      const i = options.length;
      items.push(`<li class="combo-option combo-option--free" role="option" id="${id}-${i}" data-i="${i}" aria-selected="${i === active}">Use “${esc(q)}”</li>`);
    }
    if (!items.length) items.push('<li class="combo-empty">Start typing a sport…</li>');
    list.innerHTML = items.join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
  }

  function choose(i) {
    const q = input.value.trim();
    let sport;
    if (i < options.length) sport = options[i];
    else if (q) sport = { id: null, name: q, category: null, met: null };
    else return;
    selected = { name: sport.name, sport_id: sport.id, met: sport.met, category: sport.category };
    input.value = clearOnSelect ? '' : sport.name;
    close();
    onSelect(selected);
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    const my = ++reqId;
    try {
      const res = await sports.search(q, limit);
      if (my !== reqId) return;
      options = res.items || [];
    } catch {
      options = [];
    }
    active = options.length ? 0 : (q ? 0 : -1);
    render(q);
  }, 180);

  input.addEventListener('input', () => { selected = null; search(); });
  input.addEventListener('focus', () => search());
  input.addEventListener('keydown', (e) => {
    const count = list.querySelectorAll('.combo-option').length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) search(); else { active = (active + 1) % count; render(input.value.trim()); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + count) % count; render(input.value.trim()); }
    else if (e.key === 'Enter') { if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); } }
    else if (e.key === 'Escape') { close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.combo-option');
    if (!li) return;
    e.preventDefault();
    choose(Number(li.dataset.i));
  });

  return {
    value() {
      if (selected) return selected;
      const q = input.value.trim();
      return q ? { name: q, sport_id: null, met: null } : null;
    },
    set(sport) { selected = sport; input.value = sport ? sport.name : ''; },
    clear() { selected = null; input.value = ''; },
  };
}
