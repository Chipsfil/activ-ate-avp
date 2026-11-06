/**
 * MOCK ONLY – stands in for the LLM (Claude / OpenAI) until the backend exists.
 * The real prompts and JSON schemas are described in docs/BACKEND.md › AI features.
 */
import { round1 } from './mock-db.js';

/* ---------------------------------------------------- Meal estimation */
// per 100 g: kcal, protein, carbs, fat · piece = typical grams per piece / portion
const FOODS = [
  { keys: ['toast', 'bread', 'brot'], name: 'Toast / bread', v: [265, 9, 49, 3.2], piece: 30 },
  { keys: ['cheese', 'käse'], name: 'Cheese', v: [400, 25, 1.3, 33], piece: 30 },
  { keys: ['tomato'], name: 'Tomato', v: [18, 0.9, 3.9, 0.2], piece: 120 },
  { keys: ['chicken', 'poulet'], name: 'Chicken breast', v: [165, 31, 0, 3.6], piece: 150 },
  { keys: ['butter'], name: 'Butter', v: [717, 0.9, 0.1, 81], piece: 10 },
  { keys: ['egg'], name: 'Egg', v: [143, 12.6, 0.7, 9.5], piece: 55 },
  { keys: ['rice', 'reis'], name: 'Rice (cooked)', v: [130, 2.7, 28, 0.3], piece: 150 },
  { keys: ['pasta', 'spaghetti', 'noodle'], name: 'Pasta (cooked)', v: [158, 5.8, 31, 0.9], piece: 180 },
  { keys: ['oat', 'muesli', 'müesli', 'porridge'], name: 'Oats / muesli', v: [379, 13, 68, 6.5], piece: 50 },
  { keys: ['milk', 'milch'], name: 'Milk', v: [64, 3.4, 4.8, 3.6], piece: 200 },
  { keys: ['banana'], name: 'Banana', v: [89, 1.1, 23, 0.3], piece: 120 },
  { keys: ['apple', 'apfel'], name: 'Apple', v: [52, 0.3, 14, 0.2], piece: 180 },
  { keys: ['yogurt', 'yoghurt', 'skyr', 'quark'], name: 'Yogurt / skyr', v: [80, 10, 4, 2], piece: 150 },
  { keys: ['salmon', 'lachs', 'fish'], name: 'Salmon', v: [208, 20, 0, 13], piece: 125 },
  { keys: ['avocado'], name: 'Avocado', v: [160, 2, 9, 15], piece: 150 },
  { keys: ['potato', 'kartoffel'], name: 'Potatoes', v: [77, 2, 17, 0.1], piece: 150 },
  { keys: ['beef', 'steak', 'rind'], name: 'Beef', v: [250, 26, 0, 15], piece: 150 },
  { keys: ['tofu'], name: 'Tofu', v: [144, 15, 3, 9], piece: 100 },
  { keys: ['broccoli', 'vegetable', 'veggies', 'gemüse'], name: 'Vegetables', v: [34, 2.8, 7, 0.4], piece: 100 },
  { keys: ['almond', 'nut'], name: 'Nuts', v: [579, 21, 22, 50], piece: 30 },
  { keys: ['whey', 'protein shake', 'protein powder'], name: 'Whey protein', v: [380, 80, 8, 6], piece: 30 },
  { keys: ['salad', 'lettuce'], name: 'Salad', v: [15, 1.4, 2.9, 0.2], piece: 100 },
  { keys: ['coffee', 'tea', 'kaffee'], name: 'Coffee / tea', v: [2, 0.1, 0, 0], piece: 200 },
  { keys: ['pizza'], name: 'Pizza', v: [266, 11, 33, 10], piece: 350 },
  { keys: ['lentil', 'linsen', 'beans', 'chickpea'], name: 'Legumes (cooked)', v: [116, 9, 20, 0.4], piece: 150 },
  { keys: ['olive oil', 'oil'], name: 'Oil', v: [884, 0, 0, 100], piece: 10 },
  { keys: ['honey', 'honig', 'jam'], name: 'Honey / jam', v: [304, 0.3, 82, 0], piece: 20 },
];
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, half: 0.5 };

export function estimateMeal(text) {
  const parts = text.toLowerCase().split(/,|\band\b|\bwith\b|\+|\n|;/).map((x) => x.trim()).filter(Boolean);
  const items = parts.map((part) => {
    const food = FOODS.find((d) => d.keys.some((k) => part.includes(k)));
    const m = part.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grams?|ml|l|dl)?\b/);
    let grams; let assumed = false;
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'));
      const u = m[2] || '';
      if (u === 'kg' || u === 'l') grams = n * 1000;
      else if (u === 'dl') grams = n * 100;
      else if (u) grams = n;
      else { grams = n * (food ? food.piece : 100); assumed = true; }
    } else {
      const w = part.split(/\s+/).find((x) => WORDS[x] !== undefined);
      grams = (w ? WORDS[w] : 1) * (food ? food.piece : 100);
      assumed = true;
    }
    const v = food ? food.v : [150, 5, 18, 6];
    const f = grams / 100;
    const label = food ? food.name : part.replace(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grams?|ml|l|dl)?\b/, '').trim();
    return {
      name: label.charAt(0).toUpperCase() + label.slice(1), amount_g: Math.round(grams), assumed: assumed || !food,
      kcal: Math.round(v[0] * f), protein_g: round1(v[1] * f), carbs_g: round1(v[2] * f), fat_g: round1(v[3] * f),
    };
  });
  const totals = items.reduce((a, i) => ({ kcal: a.kcal + i.kcal, protein_g: round1(a.protein_g + i.protein_g), carbs_g: round1(a.carbs_g + i.carbs_g), fat_g: round1(a.fat_g + i.fat_g) }), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  return { items, totals };
}

/* ---------------------------------------------------- Coach replies */
export function coachReply(question, c) {
  const t = question.toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  const protGap = Math.max(0, Math.round(c.proteinTarget - c.proteinToday));
  if (has('pain', 'hurt', 'injur', 'sore knee', 'sore back')) {
    return { content: 'I\'m sorry to hear that. Please pause any training that causes pain and have it checked by a doctor or physiotherapist if it lasts more than a few days or is sharp. Until then I can suggest pain-free alternatives – just tell me where it hurts.' };
  }
  if (has('plan', 'next week', 'schedule')) {
    const sessions = c.activityGoals.length ? c.activityGoals : [{ sport: 'Running', minutes_per_session: 30, sessions_per_week: 3 }];
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const plan = []; let d = 0;
    sessions.forEach((g) => { for (let i = 0; i < g.sessions_per_week && plan.length < 7; i++) { plan.push({ day: days[d % 7], sport: g.sport, minutes: g.minutes_per_session }); d += 1; } });
    plan.sort((a, b) => days.indexOf(a.day) - days.indexOf(b.day));
    const lines = plan.map((p) => `${p.day} – ${p.sport}, ${p.minutes} min`).join('\n');
    return {
      content: `Here is a plan for next week based on your goals (${c.targetMinutes} min):\n\n${lines}\n\nKeep at least one full rest day. Increase weights by ~2.5 % when you hit all reps.`,
      proposed_sessions: plan.map((p) => ({ sport: p.sport, minutes: p.minutes, day: p.day })),
    };
  }
  if (has('sleep', 'tired', 'fatigue')) return { content: `You averaged ${c.sleepAvg ?? '–'} h of sleep over the last 7 days (target ${c.sleepTarget} h). Recovery happens mostly in deep sleep. Try a fixed bedtime, no screens 30 min before and caffeine only before 14:00.` };
  if (has('before', 'pre-run', 'pre run', 'pre-workout')) return { content: '1–2 h before training: 30–50 g easy carbs, little fat and fiber.\n\n• Banana + 2 rice cakes with honey\n• Toast with jam\n• Small bowl of oats with milk\n\nIf you only have 30 minutes, a banana alone is enough. Drink ~400 ml water.' };
  if (has('after', 'recover', 'post')) return { content: `After training: 30–40 g protein + carbs within 2 hours.${protGap > 0 ? ` Today you still need about ${protGap} g protein – 250 g skyr would cover most of it.` : ''}` };
  if (has('protein')) return { content: `Your protein target is ${c.proteinTarget} g per day; today you are at ${Math.round(c.proteinToday)} g. Easy wins:\n• 3 eggs at breakfast (+19 g)\n• Skyr instead of yogurt (+10 g)\n• 150 g chicken, tofu or lentils at lunch (+20–45 g)` };
  if (has('network', 'compare', 'rank', 'friend', 'others')) return { content: `You are #${c.rank} of ${c.networkSize} in your network this week with ${c.weekMinutes} exercise minutes. ${c.gapText}` };
  if (has('weight', 'gain', 'lose', 'scale')) return { content: `You are at ${c.currentKg ?? '–'} kg with a target of ${c.targetKg ?? '–'} kg. A healthy pace is up to 0.5 kg per week. Your calorie target is ${c.kcalTarget} kcal; today you have eaten ${c.kcalToday} kcal.` };
  if (has('eat', 'food', 'meal', 'dinner', 'lunch', 'breakfast', 'nutrient')) return { content: `For your next meal: a palm-sized protein source (150 g chicken, salmon or tofu), a fist of carbs (rice, potatoes) and half a plate of vegetables. ${protGap > 0 ? `That closes most of your ${protGap} g protein gap today.` : 'Your protein target is already reached today.'}` };
  return { content: `Good question! Based on your data you are at ${c.weekMinutes} of ${c.targetMinutes} exercise minutes this week and ${Math.round(c.proteinToday)} of ${c.proteinTarget} g protein today.\n\n(Mock answer – the real AI Coach will answer this using your full history.)` };
}
