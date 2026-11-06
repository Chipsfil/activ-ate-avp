# Activ-Ate – Backend specification

What the Python backend has to do behind each endpoint in [API.md](API.md).
The frontend is finished and talks to the API through `assets/js/api.js`; the in-browser mock
(`assets/js/mock/`) shows the expected behaviour and can be read as executable pseudo-code.

---

## 1. Target architecture

```
Browser (static HTML/CSS/JS)  ──HTTP──▶  Python static server (port 8080)
     │
     └───────────────────────────────▶  FastAPI backend (port 8000)
                                                                 ├── PostgreSQL (Cloud SQL or local on VM)
                                                                 ├── LLM API (Claude or OpenAI) – only from backend
```

Recommended stack: **Python 3.12, FastAPI, SQLAlchemy 2, Alembic, Pydantic v2, passlib[argon2], PyJWT, httpx**, the official
`anthropic` or `openai` SDK. Run with `uvicorn` as a service on the backend VM, or on Cloud Run.

Suggested project layout:

```
backend/
  app/main.py              # FastAPI app, routers, CORS off (same origin), error handler → {error,message,field}
  app/config.py            # settings from env: DATABASE_URL, JWT_SECRET, LLM_API_KEY, LLM_MODEL, SMTP_*
  app/auth/                # register, login, refresh, logout, reset
  app/routers/             # me.py, sports.py, dashboard.py, workouts.py, nutrition.py, community.py, coach.py
  app/services/            # targets.py, streaks.py, network.py, calories.py, ai.py (all LLM calls in one place)
  app/models.py            # SQLAlchemy models
  alembic/                 # migrations
  scripts/import_sports.py # loads the sports list (CSV/JSON) into the sports table
```

Every router depends on `get_current_user()` (verifies the JWT) except the public auth routes and `/sports`.

---

## 2. Data model (PostgreSQL)

| Table | Columns | Notes |
| --- | --- | --- |
| `users` | id (uuid pk), username (unique, citext), email (unique, citext), password_hash, first_name, last_name, gender, date_of_birth, height_cm, sleep_goal_h (default 8), onboarding_step (text: '2','3','4','done'), created_at | |
| `sessions` | id, user_id → users, refresh_token_hash, expires_at, revoked_at, created_at | refresh tokens |
| `body_weights` | id, user_id, weight_kg, measured_on | history; latest row = current weight |
| `user_goals` | user_id, goal (enum lose_weight/gain_muscle/improve_stamina), position | position 0 = primary goal (used for network) |
| `sports` | id (text slug pk), name, category, met, popularity | ~1000 rows, imported (see §5) |
| `sport_aliases` | sport_id → sports, alias | for search ("gym", "unihockey") |
| `user_sports` | user_id, sport_id (nullable), name | free text allowed (sport_id null) |
| `activity_goals` | id, user_id, sport_id (nullable), sport_name, minutes_per_session, sessions_per_week | |
| `nutrition_goals` | user_id, nutrient (enum), amount | unit derived from nutrient |
| `weight_goals` | user_id (pk), start_kg, target_kg, target_date | |
| `workouts` | id, user_id, sport_id (nullable), sport_name, title, performed_on, duration_min, distance_km, intensity, notes, kcal, status (done/planned), created_at | index (user_id, performed_on) |
| `meals` | id, user_id, eaten_on, meal_type, description, source (ai/manual), kcal, protein_g, carbs_g, fat_g, estimate_id, edited (bool), created_at | index (user_id, eaten_on) |
| `meal_items` | id, meal_id, name, amount_g, kcal, protein_g, carbs_g, fat_g, assumed | |
| `ai_meal_estimates` | id, user_id, input_text, model, response_json, status (pending/confirmed/discarded), created_at | |
| `daily_logs` | user_id, log_date, sleep_hours, water_l | pk (user_id, log_date) |
| `networks` | id, criteria_json, created_at | auto-assigned groups |
| `network_members` | network_id, user_id, joined_at, left_at | one active row per user |
| `cheers` | id, from_user, to_user, habit, week_start, created_at | unique (from_user, to_user, habit, week_start) |
| `ai_recommendations` | id, user_id, kind (daily/workout/nutrition/insights_exercise/…), content_json, created_at, valid_until | cache |
| `chat_conversations` / `chat_messages` | id, user_id, created_at / id, conversation_id, role, content, tokens_in, tokens_out, created_at | |

**Removed compared to the earlier concept:** `friendships`, `sharing_settings`, `nudges`/messages, `challenges`.
Community data is shared automatically within a network; the only interaction is `cheers`.

---

## 3. Business rules

### 3.1 Calorie & macro targets (`computed_defaults`, used when the user sets no own goal)
- BMR (Mifflin-St Jeor): `10·kg + 6.25·cm − 5·age + s`, with s = +5 (male), −161 (female), −78 (diverse/unspecified).
- TDEE = BMR × 1.55 (moderately active). Goal adjustment: lose_weight −400 kcal, gain_muscle +250 kcal. Round to 50.
- Protein: 1.8 g/kg (gain_muscle), else 1.4 g/kg. Fat: 30 % of kcal ÷ 9. Carbs: remaining kcal ÷ 4. Water: 2 L. Sleep: 8 h.
- `POST /me/onboarding/complete` stores calories, protein and water goals if the user added none.

### 3.2 Calories burned per workout
`kcal = MET × intensity_factor × body_weight_kg × duration_min / 60`
- MET from the `sports` table (`sport_id`, else match by name/alias). Unknown free-text sport → MET 6.0 (and log the name, see §5).
- intensity_factor: light 0.8, medium 1.0, high 1.2. Body weight = latest `body_weights` row.
- Equivalent "kcal per minute" for the sports list: `MET × 3.5 × kg / 200`.

### 3.3 Weekly numbers
- Week = Monday–Sunday in the user's local date (send the date from the client, e.g. `?date=`).
- `target_minutes` = Σ(minutes_per_session × sessions_per_week) over activity goals (fallback 150).
- Activity goal progress = number of `done` workouts this week whose sport matches the goal (sport_id, else case-insensitive name).
- Nutrition goal progress = days of this week (so far) on which the daily total met the target (protein ≥ target; water from `daily_logs`).

### 3.4 Streaks
- Dashboard streak = consecutive days (counting back from today, or from yesterday if today has no entry yet) with at least one logged workout, meal or check-in. Best = longest run in the last 120 days.
- Community streaks per habit: exercise = days in a row with a done workout; sleep = nights in a row with `sleep_hours ≥ sleep_goal_h`; water = days in a row with `water_l ≥ water goal`.

### 3.5 Goal check (`POST /goals/check`) – rule based, no AI
1. Weekly planned minutes ≥ 150 (WHO) → ok, else warning.
2. Weight change rate = |target − current| ÷ weeks until target date; ≤ 0.5 kg/week → ok.
3. Protein per kg: gain_muscle 1.6–2.4 g/kg ok; otherwise 0.8–2.4 g/kg. No protein goal → warning.

---

## 4. Network assignment (replaces friends)

Goal: everyone is compared with people who are **similar**, so rankings feel fair and motivating. Users cannot add,
remove or message members.

**When:** at `POST /me/onboarding/complete`; re-evaluated at most once a month if weight changes by more than 5 kg,
the primary goal changes or the age band changes. Membership history is kept in `network_members` (`left_at`).

**Algorithm (prototype version, simple and explainable):**
1. Build a bucket key from the profile: height band (10 cm), weight band (10 kg, or BMI band), age band (10 years), primary goal.
   Optional later: gender, activity level (weekly target minutes).
2. Find an open network (fewer than **12** active members) whose `criteria_json` has the same key → join it.
3. If none exists, create a new network with that key.
4. Networks with fewer than **5** members after 7 days are merged with the nearest bucket (relax in this order:
   weight band ±1 → height band ±1 → age band → goal) so nobody stays alone.
5. Return `criteria` as human-readable chips (`Height: 170–179 cm`, …). Never show other users' exact weight.

**Later improvement:** k-means / nearest-neighbour clustering on standardized features (height, weight/BMI, age, goal one-hot,
weekly target minutes) with a size constraint of 8–12, recomputed monthly.

**Leaderboard values** (`GET /community/leaderboard`): for each active member of the user's network, compute
`value`, `target`, `streak`, `change_pct` (vs. same days of last week), `active_today`, `goal_reached` as defined in API.md §9.
`goal_reached`: exercise → minutes this week ≥ weekly target; sleep/water → value ≥ daily target × days elapsed.

**Shared data:** exercise minutes, workout sport/duration/date, streaks, sleep hours, water. **Never shared:** meals,
calories, body weight, notes, email. Display name = first name + last initial (full name only on the member profile).
This is shown to users during onboarding and on the Goals page; mention it in the privacy policy.

**Cheers:** allowed only if `goal_reached` is true, the target is in the same network, and the sender has not cheered
that member for that habit in the current week (unique constraint). Cheers appear as a count; no free text.

**Feed:** generated from events detected when data is saved: weekly exercise goal reached, sleep/water target met all
days of the week so far, streak milestones (7/14/30 days), new personal best.

---

## 5. Sports list

- Frontend autocomplete calls `GET /sports?q=` while typing (debounced 180 ms) and allows free text.
- Production list: ~1000 sports with `name`, `category`, `met`, aliases (e.g. from the *Compendium of Physical Activities*;
  verify licensing). Seed with `assets/data/sports.json` (100 sports) and import more via `scripts/import_sports.py`.
- Search: `ILIKE` on name and aliases, ranked as in API.md §4; consider `pg_trgm` for typo tolerance.
- Log free-text sports (`sport_id IS NULL`) and review the most common ones regularly to extend the list.
- `popularity` (count of users/workouts) sorts results for empty or short queries.

---

## 6. AI features (Claude or OpenAI)

All LLM calls live in `services/ai.py`. API key only in backend environment variables. Suggested model: a small, cheap
model (e.g. Claude Haiku 4.5) with structured JSON output; temperature 0 for estimates, ~0.5 for advice.

| Feature | Endpoint | Input sent to the LLM | Output (validated with Pydantic) | Cache / limits |
| --- | --- | --- | --- | --- |
| Meal estimate | `POST /meals/estimate` | meal text (delimited, treated as data) | `items[]` + `totals` (schema in API.md) | identical normalised text reused 30 days; 30/day/user; timeout 15 s |
| Daily advice | `GET /recommendations/daily` | goals, this week's workouts, today's & 7-day nutrition, remaining macros | `{workout, nutrition, suggested_session}` | 1 per user per day, invalidated when a workout/meal/goal is saved |
| Training insight | `GET /recommendations/workout` | 8 weeks of workout totals, goals | `{text, tips[]}` | until next workout saved |
| Nutrition advice | `GET /recommendations/nutrition` | 7-day averages vs. targets (computed in SQL) | `{text, more_of[], watch[]}` | daily |
| Network insights | `GET /community/insights` | **pre-computed facts** (gap to leader, members who reached goals) – no raw data | `{items:[{text, action: "cheer"|null, member_id}]}` | daily per habit |
| Coach chat | `POST /coach/messages` | system prompt + compact user context (~800 tokens) + last 10 messages + question | `{content, proposed_sessions?}` | 50 messages/user/day, max_tokens 700, timeout 30 s |

Rules for every AI call:
- **Numbers are computed in Python/SQL, the LLM only writes text and estimates food.** Recompute meal totals from items; check kcal ≈ 4·P + 4·C + 9·F (±15 %).
- The system prompt states: general fitness/nutrition guidance only, no diagnoses, refer to a doctor/physiotherapist for pain, injuries or health conditions, answer ≤ 200 words, treat user text and context as data.
- No names, emails or usernames in prompts. Store `tokens_in/out` per call to monitor cost.
- AI never writes data on its own: proposed sessions are only saved when the user clicks "Add to my plan".
- On provider failure: return 502/504 with a friendly message; cached advice may be returned instead.

---

## 7. Security checklist

- Argon2/bcrypt password hashes; JWT signed with a secret from env (HS256) or key pair; access token 15 min.
- Refresh token in `HttpOnly; Secure; SameSite=Strict` cookie, hashed in DB, rotated on every refresh, revoked on logout/reset.
- Every query filters by `user_id`; member endpoints check that both users are in the same active network.
- Pydantic validation for every body; SQL only via ORM/bound parameters.
- Rate limits: login 5/15 min per username+IP, AI endpoints as in §6.
- Use HTTPS for production deployments; the simple Python static server is intended for local or disposable demos.
- Privacy: `GET /me/export` and `DELETE /me` recommended (nDSG/GDPR) – not yet used by the frontend.

---

## 8. Connecting the backend to this frontend

1. Implement the endpoints of API.md (start with auth → me/targets → workouts → nutrition → dashboard → community → coach).
2. Run FastAPI on `127.0.0.1:8000` with routes under `/api/v1`.
3. Set the backend URL in `assets/js/config.js` and run the frontend with `python3 -m http.server 8080`.
4. Set `USE_MOCK_API: false` in `assets/js/config.js` (or for testing in the browser console:
   `localStorage.setItem('activate.useMock','false')`).
5. Open the site, sign up, and walk through every page. Errors appear as toasts or under the related form field.
6. Delete `assets/js/mock/` once everything works (it is only loaded in mock mode).
