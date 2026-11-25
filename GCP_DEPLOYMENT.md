# Two-VM HTTP demo

This demo keeps the frontend and API on separate Ubuntu VMs and uses Cloud
SQL:

```text
Browser → Frontend VM (Python static server) → Backend VM (Flask API) → Cloud SQL
```

The steps below assume you have already created both VMs and a PostgreSQL
Cloud SQL instance. Replace the uppercase placeholders with your actual values.
Clone the repository separately on each VM. These instructions are for a
disposable demo only: the app uses plain HTTP and the Flask development server.
Do not use real accounts, personal data, or this setup as a production service.

## 1. Configure network access

Allow these ingress rules in the VPC network used by the VMs. Restrict source
ranges to your own IP addresses where possible.

| VM | Source range | Protocol and port |
| --- | --- | --- |
| Frontend | `0.0.0.0/0` (or your IP range) | TCP `8080` |
| Backend | `0.0.0.0/0` (or your IP range) | TCP `8000` |

The Cloud SQL instance must accept connections from the backend VM (for
example, through a configured Cloud SQL connection method or an authorized
network). Do not open TCP `5432` on either VM. Keep the database credentials
and JWT secret private; do not put them in the repository.

Record the VMs' external IPs:

```text
FRONTEND_EXTERNAL_IP
BACKEND_EXTERNAL_IP
```

## 2. Prepare each VM and clone the repository

SSH into each VM from the Google Cloud Console or with `gcloud compute ssh`.
Run these commands on **both** VMs:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip tmux
git clone https://github.com/Chipsfil/activ-ate-avp.git ~/activ-ate
```

If GitHub prompts for credentials, authenticate using your approved GitHub
access method; never paste a password or access token into a command or this
guide.

## 3. Set up and start the backend VM

SSH into the backend VM. Create a virtual environment and install the
dependencies:

```bash
cd ~/activ-ate/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
nano .env
```

In `.env`, set `DATABASE_URL` to the connection string for the PostgreSQL
database you want this app to use, plus a private, random `JWT_SECRET`. For an
existing Cloud SQL database, keep its current database name, user, password,
and connection method; make sure the backend VM is allowed to connect. When
connecting directly to Cloud SQL over its public IP, use SSL:

```dotenv
DATABASE_URL=postgresql://DB_USER:URL_ENCODED_PASSWORD@CLOUD_SQL_IP:5432/DB_NAME?sslmode=require
```

Replace the placeholders with your database's values. URL-encode special
characters in the username or password. The repository's `.env.example`
includes `sslmode=require`. Set these values for the two-VM browser setup:

```dotenv
FRONTEND_ORIGIN=http://FRONTEND_EXTERNAL_IP:8080
COOKIE_SECURE=false
COOKIE_SAMESITE=Lax
HOST=0.0.0.0
PORT=8000
ACCESS_TOKEN_TTL_MINUTES=1440
```

Replace `FRONTEND_EXTERNAL_IP` with the actual frontend VM IP. `1440` keeps
demo access tokens valid for 24 hours. Save and close `nano` with `Ctrl+O`,
`Enter`, then `Ctrl+X`.

If the database is empty and has not been initialized for Activ-Ate, initialize
it once with the schema below. If it already contains Activ-Ate tables or
data, check its version before upgrading. `schema.sql` initializes a new
database. For the legacy schema with `networks.bucket`, back up the existing
database and check that both legacy group tables are empty. From `backend/`,
run the command below with
`migrations/upgrade_legacy_groups.sql` in place of `schema.sql`. The migration
loads `schema.sql` in the same transaction. The
`psql` client must be installed. The command reads `DATABASE_URL` from `.env`
without loading the file as shell code:

```bash
sudo apt install -y postgresql-client
python3 -c 'from dotenv import dotenv_values; import subprocess, sys; sys.exit(subprocess.run(["psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", dotenv_values(".env")["DATABASE_URL"], "-f", "schema.sql"]).returncode)'
```

Do not reapply this initialization schema to an existing database; it is not a
migration script.

Start the API in a `tmux` session so it keeps running after you disconnect:

```bash
tmux new -s activate-backend
cd ~/activ-ate/backend
source .venv/bin/activate
python3 app.py
```

Detach from `tmux` with `Ctrl+B`, then `D`. Reattach later with
`tmux attach -t activate-backend`. To stop the API, reattach and press `Ctrl+C`.

### Promote an Activ-Ate user to administrator

Register the account in Activ-Ate first. On the backend VM, run the following
from `~/activ-ate/backend` with the virtual environment active. Replace
`ACTIVATE_USERNAME` with the registered username. The script uses the same
database as the backend and prints the updated username and role.

```bash
python3 - ACTIVATE_USERNAME <<'PY'
import sys

from dotenv import dotenv_values
import psycopg

username = sys.argv[1]
with psycopg.connect(dotenv_values(".env")["DATABASE_URL"]) as connection:
    user = connection.execute(
        "UPDATE public.users SET role = 'admin' WHERE username = %s RETURNING username, role",
        (username,),
    ).fetchone()
    if user is None:
        sys.exit(f"No Activ-Ate account found for {username!r}.")

print(f"{user[0]}: {user[1]}")
PY
```

If the user is already signed in, have them sign out and back in to reload
their profile and open the admin dashboard.

## 4. Set up and start the frontend VM

SSH into the frontend VM and point the frontend at the backend VM:

```bash
cd ~/activ-ate/frontend
nano assets/js/config.js
```

Change `API_BASE_URL` to use the backend VM's external IP:

```js
API_BASE_URL: storedApiBaseUrl || 'http://BACKEND_EXTERNAL_IP:8000/api/v1',
```

Replace `BACKEND_EXTERNAL_IP` with the actual backend VM IP and save the file.
No frontend build or dependency installation is needed.

Start the static server in its own `tmux` session:

```bash
tmux new -s activate-frontend
cd ~/activ-ate/frontend
python3 -m http.server 8080 --bind 0.0.0.0
```

Detach with `Ctrl+B`, then `D`. Reattach with
`tmux attach -t activate-frontend`; press `Ctrl+C` there to stop the server.

## 5. Verify the demo

Open `http://FRONTEND_EXTERNAL_IP:8080` in a browser. Check the backend health
endpoint from the backend VM:

```bash
curl http://127.0.0.1:8000/api/v1/health
```

If the frontend still calls an old API address, clear the saved override in
the browser developer console and reload:

```js
localStorage.removeItem('activate.apiBaseUrl');
location.reload();
```

When changing the frontend IP, update `FRONTEND_ORIGIN` in the backend
`.env` and restart Flask. When changing the backend IP, update
`API_BASE_URL` in the frontend `assets/js/config.js` and restart the static
server if needed.

## Cloud SQL connection troubleshooting

A `connection timed out` error means the backend VM cannot reach the Cloud SQL
address on TCP `5432`; it is not a schema or password error. For a Cloud SQL
instance using a public IP, confirm public IP connectivity is enabled and add
the backend VM's external IP as a `/32` entry under the instance's authorized
networks. Do not authorize `0.0.0.0/0`. If the VM uses an ephemeral external
IP, reserve a static IP or update the authorized network when it changes.

If the instance uses a private IP, the backend VM must be on a network that can
reach it; use that private IP in `DATABASE_URL` and configure the required
private connectivity. Alternatively, use the Cloud SQL Auth Proxy with the
appropriate IAM permissions. Do not open TCP `5432` to the public internet.

If PostgreSQL reports `no encryption`, add `?sslmode=require` to the connection
URL (or use `&sslmode=require` if the URL already has query parameters). If it
reports `password authentication failed`, reset the database user's password
in Cloud SQL and update `DATABASE_URL` in the backend `.env`; verify the
username and selected database as well. Keep the connection URL out of pasted
commands and logs because it contains the database password.

## Limitation

The access token is stored in the current browser tab's `sessionStorage` and
is readable by JavaScript. HTTP sends credentials without encryption. A token
expires after 24 hours; the user must sign in again after that. Use only for
the demo, not real accounts or personal data.
