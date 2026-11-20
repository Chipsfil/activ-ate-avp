# Activ-Ate backend

Flask REST API backed by PostgreSQL. Routes use the `/api/v1` prefix and are
grouped by domain in `api/` (`auth.py`, `profile.py`, `activity.py`,
`nutrition.py`, `community.py`, `recommendations.py`, `coach.py`, and
`system.py`). `app.py` registers the blueprints; `schema.sql` defines the
database structure.

## Local setup

Requires Python 3.11 or newer and PostgreSQL.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set `DATABASE_URL` and a private, random `JWT_SECRET` in `.env`. The other
available settings are `FRONTEND_ORIGIN` (default `http://localhost:8080`),
`COOKIE_SECURE`, `COOKIE_SAMESITE`, `HOST` (default `0.0.0.0`), and `PORT`
(default `8000`). Do not commit `.env`.

For the AI Coach and recommendations, choose a provider in `backend/.env`:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4o-mini
```

Or use DeepSeek:

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-flash
```

Or use OpenRouter:

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-your-openrouter-api-key
OPENROUTER_MODEL=deepseek/deepseek-chat
```

Restart the backend after changing these settings. API usage is billed by the
selected provider. Coach questions, the last 10 conversation messages, and
your goals, sports, and weekly activity target are sent to that provider.
The conversations are saved in PostgreSQL. Recommendation cards use the same
profile details and make a new API request each time they are loaded. Meal
estimation sends the meal description and meal type to the selected provider;
estimates are saved for review and are not logged as meals until confirmed.

Create an empty database, then apply the schema and start the API:

```bash
psql "$DATABASE_URL" -f schema.sql
python app.py
```

This schema initializes a new database; it does not migrate existing tables.
Target changes apply from the day they are saved; multiple changes on the same
day use the latest values. Earlier unrecorded target changes cannot be recovered,
so the existing targets are the historical baseline.
Promote a trusted registered account to the study administrator with:

```sql
UPDATE users SET role = 'admin' WHERE username = 'your-admin-username';
```

Only administrator accounts can use the `/api/v1/admin/*` endpoints.

The health endpoint is `http://127.0.0.1:8000/api/v1/health`.

Workout calorie estimates use the standard MET formula:
`kcal = MET x body weight (kg) x duration (hours)`. The selected workout
intensity applies a 0.8 (light), 1.0 (medium), or 1.2 (high) modifier. Height
is not included because the Compendium of Physical Activities MET formula is
body-weight-based. Estimates require body weight; until one is recorded, the
backend uses a 70 kg fallback.

## Deployment

See the repository's [GCP deployment guide](../GCP_DEPLOYMENT.md) for the
existing Linux VM setup. Use HTTPS and secure cookies when handling real user
data; keep PostgreSQL accessible only to the backend.
