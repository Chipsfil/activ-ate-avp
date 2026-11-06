# Two-VM HTTP demo

This demo keeps the frontend and API on separate VMs and uses Cloud SQL:

```text
Browser → Frontend VM (Python static server) → Backend VM (Flask API) → Cloud SQL
```

It uses plain HTTP and stores the access token in the current browser tab's
`sessionStorage` so page navigation does not immediately sign the user out
when the cross-site refresh cookie is unavailable. Use disposable test data
only.

## Firewall rules

Allow these ingress rules in the VPC network used by the VMs:

| VM | Source range | Protocol and port |
| --- | --- | --- |
| Frontend | `0.0.0.0/0` | TCP `8080` |
| Backend | `0.0.0.0/0` | TCP `8000` |

The Cloud SQL instance must allow a connection from the backend VM. Do not
open TCP `5432` on either VM.

## Backend VM

Set the backend VM's `backend/.env` values. Keep the existing working
`DATABASE_URL`, `JWT_SECRET`, and other database settings. Set these values for
the two-VM browser setup:

```dotenv
FRONTEND_ORIGIN=http://FRONTEND_EXTERNAL_IP:8080
COOKIE_SECURE=false
COOKIE_SAMESITE=Lax
HOST=0.0.0.0
PORT=8000
ACCESS_TOKEN_TTL_MINUTES=1440
```

`1440` keeps demo access tokens valid for 24 hours. Restart Flask after editing
the file. From `~/activ-ate/backend`:

```bash
. .venv/bin/activate
python3 app.py
```

For local development, set `FRONTEND_ORIGIN=http://localhost:8080` in
`backend/.env` and open the frontend at exactly `http://localhost:8080`.
For GCP, replace it with the frontend VM's external IP as shown above.

## Frontend VM

Set `frontend/assets/js/config.js` to the backend VM's external IP:

```js
API_BASE_URL: storedApiBaseUrl || 'http://BACKEND_EXTERNAL_IP:8000/api/v1',
```

Copy the updated `frontend/` directory to the frontend VM. Serve it from that
VM with:

```bash
cd ~/activ-ate/frontend
python3 -m http.server 8080 --bind 0.0.0.0
```

Open `http://FRONTEND_EXTERNAL_IP:8080`. If you previously set an API URL in
the browser's local storage, clear it in the developer console and reload:

```js
localStorage.removeItem('activate.apiBaseUrl');
location.reload();
```

## Limitation

The access token is readable by JavaScript in that tab, and HTTP sends
credentials without encryption. A token expires after 24 hours; the user must
sign in again after that. Use only for the demo, not real accounts or personal
data.
