# Activ-Ate – Frontend

Health web app: log workouts and meals, get AI recommendations, and compare yourself with an automatically
assigned network of similar people. This repository contains the **complete frontend** (plain HTML, CSS and
JavaScript – no build step) plus the **documentation the backend team needs**.

The backend (Python + PostgreSQL + Claude/OpenAI API) is **not built yet**. Until then a mock backend runs inside the
browser, so every page already works end to end (data is stored in `localStorage`).

| Document | For whom | Content |
| --- | --- | --- |
| [docs/API.md](docs/API.md) | Backend developer | Every endpoint with request/response JSON, validation and errors |
| [docs/BACKEND.md](docs/BACKEND.md) | Backend developer | Architecture, database tables, business rules, network assignment, AI prompts, security |

---

## Run locally (2 minutes)

ES modules do not work from `file://`, so start any static web server in the project folder:

```bash
cd activ-ate-frontend
python3 -m http.server 8080
# open http://localhost:8080
```

**Demo login (mock mode):** username `demo`, password `demo1234` – 8 weeks of example data.
Or create a new account through the onboarding. To reset all demo data run in the browser console:
`localStorage.clear()`.

---

## Design ("Evergreen & Brass")

- **Logo:** a folded ribbon forming the letter A, with a crossbar that passes in front of one leg and behind the other (one continuous band). Files in `assets/img/`: `logo-mark.svg` (for dark backgrounds), `logo-mark-dark.svg` (for light backgrounds), `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`; `assets/site.webmanifest` links the app icons.
- **Colours:** warm ivory canvas, evergreen primary (`--brand`), brass accent (`--brass`, `--mint` on dark surfaces), copper for secondary series (`--orange`). All tokens are at the top of `assets/css/styles.css`; changing them re-themes the whole app.
- **Type:** Newsreader (serif, headings and numbers) + Inter (UI text). Both are **self-hosted** in `assets/fonts/` (SIL Open Font License, licence files included) – no request to Google Fonts, so the CSP only allows `'self'`.
- Only styles and markup changed in this redesign; all API calls, endpoints and page logic are unchanged.

---

## Pages

| Page | File | Main endpoints |
| --- | --- | --- |
| Entry (redirect) | `index.html` | `POST /auth/refresh` |
| Sign in | `signin.html` | `POST /auth/login` |
| Sign up (3-step onboarding) | `signup.html` | `POST /auth/register`, `PUT /me/goals`, `PUT /me/targets`, `POST /me/onboarding/complete` |
| Dashboard | `dashboard.html` | `GET /dashboard`, `GET /recommendations/daily`, `PUT /daily-logs`, `POST /workouts` |
| Workouts | `workouts.html` | `GET /workouts`, `GET /workouts/stats`, `POST/PATCH/DELETE /workouts` |
| Nutrition | `nutrition.html` | `POST /meals/estimate`, `POST /meals`, `GET /nutrition/summary` |
| Goals | `goals.html` | `GET/PUT /me/targets`, `POST /goals/check` |
| Community | `community.html` | `GET /community/leaderboard`, `POST …/cheers`, `GET /community/insights` |
| Network member | `member.html?id=…` | `GET /community/members/{id}` |
| AI Coach | `coach.html` | `POST /coach/messages` |

### What changed compared to the clickable prototype
- **Community = automatic network.** Users are matched by height, weight, age and main goal. No "add friend", no friend requests, no messaging. The only interaction is **cheering** a member who reached a goal.
- **No "share your data" step** in onboarding. Exercise minutes, workouts, streaks, sleep and water are shared with the network automatically; meals and body weight stay private (shown to the user in onboarding and on the Goals page).
- **Sports are typed with autocomplete** (onboarding, goals, workout logging). Users can also keep their own text if a sport is not in the list. The list comes from `GET /sports` – later ~1000 sports with calories per minute; seed data in `assets/data/sports.json`.
- **Daily check-in** for sleep and water on the dashboard (needed for the sleep/water comparison).
- Onboarding has 3 steps: About you → Goals & sports → Targets.

---

## Project structure

```
index.html, signin.html, signup.html, …   one HTML file per page (layout only)
assets/css/styles.css                      design system (colours, type, components, responsive)
assets/js/config.js                        API URL + mock switch
assets/js/api.js                           the ONLY place that talks to the backend (fetch, tokens, errors)
assets/js/ui.js                            sidebar, auth guard, toasts, formatting, escaping
assets/js/components/                      sport autocomplete, workout form
assets/js/pages/*.js                       one script per page
assets/js/mock/                            in-browser mock backend (delete when the real API is live)
assets/data/sports.json                    seed list of sports with MET values
assets/fonts/, assets/img/                 self-hosted fonts, logo and icons
docs/                                      API contract + backend specification
```

Conventions: all text from users or the backend is escaped with `esc()` before it is put into HTML; every form shows
backend validation errors under the field named in the error response; buttons show a spinner while a request runs.

---
