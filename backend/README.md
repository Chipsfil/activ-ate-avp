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

Create an empty database, then apply the schema and start the API:

```bash
psql "$DATABASE_URL" -f schema.sql
python app.py
```

The health endpoint is `http://127.0.0.1:8000/api/v1/health`.

## Deployment

See the repository's [GCP deployment guide](../GCP_DEPLOYMENT.md) for the
existing Linux VM setup. Use HTTPS and secure cookies when handling real user
data; keep PostgreSQL accessible only to the backend.
