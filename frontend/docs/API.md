# Activ-Ate – REST API contract (v1)

This is the contract between the frontend in this repository and the Python backend that still has to be built.
The frontend already calls every endpoint below (see `assets/js/api.js`). Until the backend exists, the same
endpoints are answered by an in-browser mock (`assets/js/mock/mock-server.js`). That mock is a working reference
implementation: when in doubt about a field, check what the mock returns.

**Implement the endpoints, then set `USE_MOCK_API: false` in `assets/js/config.js`. No other frontend change is needed.**

---

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Base URL | `/api/v1` on the backend URL configured in `assets/js/config.js`; local/demo deployments serve the frontend with `python3 -m http.server 8080`. |
| Format | JSON request and response bodies, `Content-Type: application/json`. |
| Dates | ISO date strings `YYYY-MM-DD` (user's local date). Timestamps ISO 8601 UTC (`2026-10-17T09:00:00Z`). |
| Units | Metric only: kg, cm, minutes, km, kcal, grams, liters, hours. |
| IDs | Opaque strings (UUIDs recommended). The frontend never parses them. |
| Auth | `Authorization: Bearer <access_token>` on every endpoint except those marked **public**. |
| Week | Monday–Sunday, in the user's local date. |
| Empty success | `204 No Content` is allowed for logout. Everything else returns JSON. |

### Error format (all non-2xx responses)

```json
{ "error": "validation_error", "message": "Duration must be between 1 and 600 minutes.", "field": "duration_min" }
```

- `message` is shown to the user as-is, so write it in plain English.
- `field` (optional) is the name of the form field; the frontend puts the message right under that input.

| Status | `error` | When | Frontend behaviour |
| --- | --- | --- | --- |
| 400 | `invalid_token` | Bad/expired reset token | message in form |
| 401 | `unauthorized` / `invalid_credentials` | Missing/expired access token, wrong login | silent `POST /auth/refresh` + retry once, else redirect to sign-in |
| 403 | `forbidden` | Resource of another user | toast |
| 404 | `not_found` | Unknown id, member not in your network | message / toast |
| 409 | `conflict`, `already_cheered`, `goal_not_reached`, `onboarding_incomplete` | Business rule violated | message under field or toast |
| 422 | `validation_error` | Invalid input | message under `field` |
| 429 | `rate_limited` | Too many requests (login, AI) | toast |
| 502/504 | `ai_unavailable`, `timeout` | LLM failed or timed out | "try again or enter manually" |

---

## 2. Authentication

- **Access token**: JWT, valid ~15 min, returned in the JSON body. The frontend keeps it in `sessionStorage`.
- **Refresh token**: random string, valid 30 days, set by the backend as cookie
  `Set-Cookie: refresh_token=…; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. Store only its hash.
- Every page calls `POST /auth/refresh` when it loads (multi-page app → memory is lost on navigation). Rotate the refresh token on each call.

### `GET /auth/username-available?username=lena.meier` — public
`200 { "available": true }`

### `POST /auth/register` — public
```json
{ "first_name": "Lena", "last_name": "Meier", "username": "lena.meier", "email": "lena@example.com",
  "password": "secret123", "gender": "female", "date_of_birth": "1999-04-12", "weight_kg": 64, "height_cm": 170 }
```
`gender` ∈ `female | male | diverse | unspecified`.
Validation: username 3–30 chars `[a-z0-9._-]`, unique (409, field `username`); email valid & unique (409, field `email`);
password ≥ 8; weight 30–300; height 100–250; age ≥ 16.
Creates the user with `onboarding_step = 2` and a first `body_weights` row. Sets refresh cookie.
`201 { "access_token": "…", "user": User }`

### `POST /auth/login` — public
`{ "username": "lena.meier", "password": "…" }` — `username` may also be the email.
`200 { "access_token": "…", "user": User }` · `401 invalid_credentials` with the **same message** for unknown user and wrong password. Rate limit: 5 failures / 15 min → 429.

### `POST /auth/refresh` — public (uses cookie)
`200 { "access_token": "…", "user": User }` · `401` if no/invalid cookie.

### `POST /auth/logout`
Revokes the session, clears the cookie. `204`.

### `User` object
```json
{ "id": "u-1", "username": "lena.meier", "email": "lena@example.com", "first_name": "Lena", "last_name": "Meier",
  "initials": "LM", "gender": "female", "date_of_birth": "1999-04-12", "height_cm": 170,
  "onboarding_step": "done", "goals": ["gain_muscle", "improve_stamina"],
  "sports": [{ "name": "Weightlifting", "sport_id": "weightlifting" }, { "name": "Underwater rugby", "sport_id": null }],
  "network_id": "net-4rhtlq", "created_at": "2026-08-18T09:00:00Z" }
```
`onboarding_step` is `2`, `3`, `4` (number) while onboarding runs and `"done"` afterwards. The frontend sends users with an unfinished onboarding back to `signup.html`.

---

## 3. Profile, goals & onboarding

Main goals: `lose_weight | gain_muscle | improve_stamina` (multiple allowed).
Nutrients: `calories (kcal) | protein (g) | carbs (g) | fat (g) | fiber (g) | sugar (g, maximum) | water (L)`.

### `GET /me` → `User`

### `PUT /me/goals` (onboarding step 2)
```json
{ "goals": ["gain_muscle", "improve_stamina"],
  "sports": [{ "name": "Padel", "sport_id": "padel" }, { "name": "Underwater rugby", "sport_id": null }] }
```
Sports come from the autocomplete; `sport_id: null` = free text not in the sports list (keep it – see BACKEND.md › Sports).
At least one goal and one sport (422). Sets `onboarding_step` 2 → 3. `200 { goals, sports }`.

### `GET /me/targets` → `Targets`
```json
{ "goals": ["gain_muscle"], "sports": [ … ],
  "activity_goals": [{ "id": "ag1", "sport": "Weightlifting", "sport_id": "weightlifting", "minutes_per_session": 60, "sessions_per_week": 4 }],
  "nutrition_goals": [{ "nutrient": "protein", "amount": 140, "unit": "g" }],
  "sleep_goal_h": 8,
  "weight_goal": { "start_kg": 62.5, "target_kg": 67, "target_date": "2027-02-01", "current_kg": 64 },
  "current_weight_kg": 64,
  "computed_defaults": { "kcal": 2350, "protein_g": 115 } }
```
`computed_defaults` = recommended values from profile (formula in BACKEND.md); the onboarding pre-fills them.

### `PUT /me/targets` (onboarding step 3 and Goals page)
All keys optional; only sent keys are replaced.
```json
{ "goals": ["gain_muscle"], "sports": [ … ],
  "activity_goals": [{ "sport": "Running", "sport_id": "running", "minutes_per_session": 20, "sessions_per_week": 7 }],
  "nutrition_goals": [{ "nutrient": "protein", "amount": 200 }],
  "sleep_goal_h": 8, "current_weight_kg": 64.5,
  "weight_goal": { "target_kg": 67, "target_date": "2027-02-01" } }
```
`weight_goal: null` removes it. A changed `current_weight_kg` inserts a new `body_weights` row (history is kept).
Validation: minutes 5–300, sessions 1–7, target date in the future. Invalidates cached AI recommendations. Sets step 3 → 4.
`200 Targets`.

### `POST /me/onboarding/complete`
Fills default nutrition goals if none were given, **assigns the user to a network** (BACKEND.md › Network assignment),
sets `onboarding_step = "done"`. No sharing settings exist: community data is shared automatically.
```json
{ "network": { "id": "net-4rhtlq", "member_count": 8,
  "criteria": [{ "label": "Height", "value": "170–179 cm" }, { "label": "Weight", "value": "60–69 kg" },
               { "label": "Age", "value": "20–29 years" }, { "label": "Main goal", "value": "Gain muscle" }] } }
```

### `POST /goals/check`
Body = unsaved form values (`goals`, `activity_goals`, `nutrition_goals`, `current_weight_kg`, `weight_goal`). Rule-based, no AI.
`200 { "checks": [{ "status": "ok" | "warning", "text": "300 exercise minutes per week planned – meets the WHO recommendation of 150 min." }] }`

---

## 4. Sports (autocomplete)

### `GET /sports?q=pad&limit=8` — public
`200 { "items": [{ "id": "padel", "name": "Padel", "category": "Racket", "met": 6.0 }] }`
Empty `q` returns the most popular sports. Ranking: exact name → name prefix → alias prefix → word prefix → contains.
Search should also match aliases (e.g. "gym" → Weightlifting, "unihockey" → Floorball). Seed list: `assets/data/sports.json`.

---

## 5. Dashboard & daily check-in

### `GET /dashboard?date=2026-10-17`
```json
{ "date": "2026-10-17",
  "week": { "minutes": 127, "target_minutes": 300, "sessions_done": 3, "sessions_planned": 7 },
  "days": [{ "date": "2026-10-12", "minutes": 0 }, …, { "date": "2026-10-18", "minutes": null }],
  "today": { "kcal": 1520, "kcal_target": 2600, "protein_g": 100, "protein_target_g": 140,
             "sleep_hours": 7.5, "water_l": 0.5, "water_target_l": 2, "sleep_target_h": 8 },
  "streak": { "current": 14, "best": 14 },
  "goal_progress": [{ "kind": "activity", "label": "Weightlifting · 60 min · 4×/week", "done": 1, "target": 4, "unit": "sessions" },
                    { "kind": "nutrition", "label": "Protein · 140 g · daily", "done": 1, "target": 6, "unit": "days" }],
  "recent_workouts": [Workout, …4],
  "network_top": [{ "member_id": "net-…-3", "display_name": "David L.", "initials": "DL", "is_me": false, "value": 322, "rank": 1 }, …4],
  "network_note": "You are 195 min behind David L.",
  "feed": [FeedItem, …2] }
```
`days[].minutes` is `null` for future days.

### `PUT /daily-logs` (sleep & water check-in)
Returns `501 { "message": "Not implemented in the backend" }`.

---

## 6. Workouts

### `Workout`
```json
{ "id": "w-1", "sport": "Running", "sport_id": "running", "title": "Greifensee loop", "performed_on": "2026-10-17",
  "duration_min": 38, "distance_km": 6.2, "intensity": "medium", "notes": "", "kcal": 397,
  "status": "done", "created_at": "2026-10-17T17:02:11Z" }
```
`intensity` ∈ `light | medium | high`; `status` ∈ `done | planned` (planned sessions come from AI suggestions and do not count until done).

### `GET /workouts?limit=15&cursor=…&sport=Running&status=planned`
Newest first. `200 { "items": [Workout], "next_cursor": "15" | null }`.

### `GET /workouts/stats?weeks=8`
```json
{ "weeks": [{ "week_start": "2026-08-24", "minutes": 255 }, …],
  "target_minutes": 300,
  "week": { "minutes": 127, "target_minutes": 300, "sessions_done": 3, "sessions_planned": 7 },
  "by_sport": [{ "sport": "Running", "minutes": 63 }],
  "goal_progress": [ …activity items as in /dashboard… ],
  "personal_bests": [{ "label": "Longest session", "value": "70 min", "detail": "Weightlifting, 2026-09-12" }] }
```

### `POST /workouts`
```json
{ "sport": "Running", "sport_id": "running", "title": null, "performed_on": "2026-10-17", "duration_min": 38,
  "distance_km": 6.2, "intensity": "medium", "notes": "", "status": "done" }
```
Validation: sport required (free text allowed), duration 1–600, done workouts not in the future and not older than 1 year, distance 0–500.
Backend computes `kcal` (BACKEND.md › Calories). `201 { "workout": Workout, "week": WeekSummary }`.

### `PATCH /workouts/{id}` — e.g. `{ "status": "done" }` → `200 { workout, week }`
### `DELETE /workouts/{id}` → `200 { week }` · 403 if not owner, 404 if unknown.

---

## 7. Nutrition

### `Meal`
```json
{ "id": "m-1", "eaten_on": "2026-10-17", "meal_type": "dinner", "description": "Toast / bread, Cheese, Tomato …",
  "source": "ai" | "manual", "kcal": 807, "protein_g": 65, "carbs_g": 54, "fat_g": 33, "items": [MealItem], "created_at": "…" }
```
`meal_type` ∈ `breakfast | lunch | dinner | snack`.

### `GET /nutrition/summary?date=2026-10-17`
`200 { "date": "…", "totals": { "kcal": 1520, "protein_g": 100, "carbs_g": 188, "fat_g": 38 }, "targets": { "kcal": 2600, "protein_g": 140, "carbs_g": 314, "fat_g": 87 } }`

### `GET /meals?date=2026-10-17` → `200 { "items": [Meal] }` (breakfast → lunch → snack → dinner)

### `POST /meals/estimate` — **AI**, step 1 of 2 (does NOT create a meal)
`{ "text": "100 g toast, 50 g cheese, 1 tomato, 150 g chicken, 10 g butter", "meal_type": "dinner" }`
```json
{ "estimate_id": "e-7c1e",
  "items": [{ "name": "Toast / bread", "amount_g": 100, "kcal": 265, "protein_g": 9, "carbs_g": 49, "fat_g": 3.2, "assumed": false },
            { "name": "Tomato", "amount_g": 120, "kcal": 22, "protein_g": 1.1, "carbs_g": 4.7, "fat_g": 0.2, "assumed": true }],
  "totals": { "kcal": 807, "protein_g": 69.2, "carbs_g": 54.4, "fat_g": 33.4 } }
```
`assumed: true` = the AI guessed the amount. Text 3–500 chars; max 30 estimates/user/day (429). Timeout 15 s → 504.

### `POST /meals` — step 2 (confirm) or manual entry
```json
{ "estimate_id": "e-7c1e", "meal_type": "dinner", "eaten_on": "2026-10-17", "description": "Toast / bread, Cheese, Tomato …",
  "kcal": 807, "protein_g": 65, "carbs_g": 54, "fat_g": 33, "items": [MealItem] }
```
Manual entry: same without `estimate_id`/`items`. With `estimate_id`: must belong to user and be `pending` (409 otherwise);
mark it `confirmed` and store whether totals were edited. Values ≥ 0, kcal ≤ 5000.
`201 { "meal": Meal, "totals": DayTotals }`

### `DELETE /meals/{id}` → `200 { "totals": DayTotals }`

---

## 8. AI recommendations (cached)

| Endpoint | Response |
| --- | --- |
| `GET /recommendations/daily` | `{ "workout": "…", "nutrition": "…", "suggested_session": { "sport": "Weightlifting", "sport_id": "weightlifting", "duration_min": 60, "date": "2026-10-18" } \| null, "generated_at": "…" }` |
| `GET /recommendations/workout` | `{ "text": "…", "tips": ["…", "…"], "generated_at": "…" }` |
| `GET /recommendations/nutrition` | `{ "text": "…", "more_of": ["Protein · avg 115 / 140 g"], "watch": ["…"], "generated_at": "…" }` |

The dashboard's "Add to my plan" creates `POST /workouts` with `status: "planned"` from `suggested_session`.

---

## 9. Community (automatic network – no friends, no messages)

Users are **assigned automatically** to a network of similar people (BACKEND.md › Network assignment).
There is no friend request, no search for other users and no messaging. The only social action is a **cheer**
for a member who reached their goal. Habits: `exercise | sleep | water`.

### `GET /community/network`
```json
{ "id": "net-4rhtlq", "member_count": 8,
  "criteria": [{ "label": "Height", "value": "170–179 cm" }, …],
  "explanation": "You were matched automatically with people of similar height, weight, age and main goal…",
  "shared_data": ["Exercise minutes", "Workout type and duration", "Streaks", "Sleep hours", "Water intake"] }
```

### `GET /community/leaderboard?habit=exercise&period=week`
```json
{ "habit": "exercise", "unit": "min", "period": "week", "target_label": "Weekly target",
  "rows": [{ "member_id": "net-…-3", "display_name": "David L.", "initials": "DL", "is_me": false, "rank": 1,
             "value": 322, "target": 300, "daily_target": 43, "streak": 4, "change_pct": 12, "active_today": true,
             "goal_reached": true, "vs_me": 195, "cheered_by_me": false, "cheer_count": 3, "can_cheer": true },
           { "member_id": "me", "display_name": "You", "is_me": true, … }],
  "summary": { "my_rank": 5, "member_count": 8, "top_streak": { "days": 9, "display_name": "Sam R." },
               "gap_to_first": 195, "gap_unit": "min" } }
```
- `value`: exercise = minutes this week; sleep = hours this week; water = liters this week.
- `target`: exercise = weekly target; sleep/water = daily target × days elapsed this week.
- Ranking: exercise and water by `value`, sleep by `streak` (then value).
- `vs_me`: difference to the current user (sleep: streak days). `null` on the user's own row.
- `can_cheer = !is_me && goal_reached && !cheered_by_me`.
- The current user's row has `member_id: "me"`. Display names are `First L.` only.

### `GET /community/members/{member_id}?habit=sleep&period=week|month|all`
404 if the member is not in the user's network.
```json
{ "member": { "id": "net-…-3", "display_name": "David Lehmann", "initials": "DL", "joined": "2025-01-01",
              "sports": ["Running", "Cycling"], "rank": 1, "streak": 30 },
  "habit": "sleep", "period": "week", "unit": "h",
  "targets": { "member": "8 h / night", "me": "8 h / night" },
  "totals": { "member": 40.7, "me": 38.2 },
  "log": [{ "date": "2026-10-17", "label": null, "value": 8.2, "unit": "h", "met": true },
          { "date": "2026-10-16", "label": "Running", "value": 45, "unit": "min", "met": null }],
  "goal_reached": true, "cheered_by_me": false, "cheer_count": 2, "can_cheer": true }
```
`log`: last 8 entries – exercise: sport + minutes (only workouts, no notes); sleep/water: value + `met`.

### `POST /community/members/{member_id}/cheers`
`{ "habit": "exercise" }` → `201 { "cheered": true, "cheer_count": 4 }`
409 `goal_not_reached` if the member has not reached the goal; 409 `already_cheered` (one cheer per member, habit and week).

### `GET /community/insights?habit=exercise` — AI (or rules), cached daily
`{ "habit": "exercise", "items": [{ "text": "David L. is ahead by 195 min…", "action": null },
                                    { "text": "Sarah K. reached the exercise goal…", "action": "cheer", "member_id": "net-…-1" }] }`
`action` is `"cheer"` or `null` – nothing else (no messages, no invites).

### `GET /feed?limit=10`
`{ "items": [{ "id": "net-…-3-water", "member_id": "net-…-3", "display_name": "David L.", "initials": "DL", "habit": "water",
               "text": "hit the water goal every day this week", "cheered_by_me": false, "cheer_count": 2, "can_cheer": true }] }`
Achievement events of network members (goal reached, streak milestones).

---

## 10. AI Coach

### `GET /coach/context`
`{ "items": [{ "label": "Goals", "value": "Gain muscle + Improve stamina", "detail": "Weightlifting 60 min 4×/week · …" }, …] }`

### `GET /coach/conversations/latest`
`{ "conversation_id": "c-1", "messages": [{ "role": "assistant" | "user", "content": "…", "created_at": "…" }] }`
Creates a conversation with a personal greeting if none exists.

### `POST /coach/conversations` → `201 { conversation_id, messages: [greeting] }`

### `POST /coach/messages`
`{ "conversation_id": "c-1" | null, "text": "What should I eat before my run?", "topic": "general" | "nutrition" }`
```json
{ "conversation_id": "c-1",
  "message": { "role": "assistant", "content": "1–2 h before training: …", "created_at": "…" },
  "proposed_sessions": [{ "sport": "Running", "minutes": 20, "day": "Mon" }] }
```
`proposed_sessions` is optional (only for plan requests). The frontend shows "Add to my plan" and, on click only,
creates planned workouts via `POST /workouts`. Text 1–1000 chars; 50 messages/user/day.

---

## 11. Endpoint checklist

| # | Method | Path | AI | Page |
| --- | --- | --- | --- | --- |
| 1 | GET | /auth/username-available | – | Sign up |
| 2 | POST | /auth/register | – | Sign up |
| 3 | POST | /auth/login | – | Sign in |
| 4 | POST | /auth/refresh | – | every page |
| 5 | POST | /auth/logout | – | sidebar |
| 6 | GET | /me | – | every page |
| 7 | PUT | /me/goals | – | Sign up |
| 8 | GET | /me/targets | – | Sign up, Goals, Workouts, Dashboard |
| 9 | PUT | /me/targets | – | Sign up, Goals |
| 10 | POST | /me/onboarding/complete | – | Sign up |
| 11 | POST | /goals/check | rules | Goals |
| 14 | GET | /sports | – | autocomplete |
| 15 | GET | /dashboard | – | Dashboard |
| 16 | PUT | /daily-logs | – | Dashboard |
| 17 | GET | /recommendations/daily | ✓ | Dashboard |
| 18 | GET | /recommendations/workout | ✓ | Workouts |
| 19 | GET | /recommendations/nutrition | ✓ | Nutrition |
| 20 | GET | /workouts | – | Workouts |
| 21 | GET | /workouts/stats | – | Workouts |
| 22 | POST | /workouts | – | Dashboard, Workouts, Coach |
| 23 | PATCH | /workouts/{id} | – | Workouts |
| 24 | DELETE | /workouts/{id} | – | Workouts |
| 25 | GET | /nutrition/summary | – | Nutrition |
| 26 | GET | /meals | – | Nutrition |
| 27 | POST | /meals/estimate | ✓ | Nutrition |
| 28 | POST | /meals | – | Nutrition |
| 29 | DELETE | /meals/{id} | – | Nutrition |
| 30 | GET | /community/network | – | Community |
| 31 | GET | /community/leaderboard | – | Community, Dashboard |
| 32 | GET | /community/members/{id} | – | Member profile |
| 33 | POST | /community/members/{id}/cheers | – | Community, Member, Dashboard |
| 34 | GET | /community/insights | ✓ | Community |
| 35 | GET | /feed | – | Dashboard, Community |
| 36 | GET | /coach/context | – | AI Coach |
| 37 | GET | /coach/conversations/latest | – | AI Coach |
| 38 | POST | /coach/conversations | – | AI Coach |
| 39 | POST | /coach/messages | ✓ | AI Coach, Nutrition |
