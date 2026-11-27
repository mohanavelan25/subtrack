# SubTrack

Self-hosted tracker for recurring subscriptions and bills. Node.js + SQLite, one container, no external services.

## Features
- CRUD for subscriptions/bills: category, amount, cycle (monthly, quarterly, semi-annual, yearly, custom days), next due date, payment method, auto-renew, status, notes, URL
- Mark paid (logs a payment and advances the due date), pause/resume, duplicate, edit, delete
- Monthly and annual normalized spend, due in 7/30 days, category breakdown, upcoming renewals, payments per month
- Payment history with manual logging of past payments
- Optional webhook alerts (Discord, Slack, ntfy, Gotify, generic JSON), sent once per due date
- JSON export/import (full backup) and CSV export/import
- `GET /api/health` for health checks; runs as a non-root user

## Layout
```
.github/workflows/docker-publish.yml   build + push to ghcr.io on pushes to main
src/server.js   Express app and REST API
src/db.js       SQLite connection, versioned migrations, optional demo seed
src/lib.js      date math, cost normalization, CSV helpers
src/notify.js   webhook alerts
public/         index.html, app.js, style.css
Dockerfile  docker-compose.yml  .env.example
```

## Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | Path inside the container (keep as `/data`) |
| `HOST_DATA_DIR` | `./data` | Host path bind-mounted to `/data` |
| `PUID` / `PGID` | `1000` | User the container runs as; must own `HOST_DATA_DIR` |
| `TZ` | `Asia/Kolkata` | Time zone for "today" and due-date alerts |
| `CURRENCY` | `INR` | ISO currency code for display |
| `AUTH_USER` / `AUTH_PASS` | empty | Optional built-in basic auth (health check stays open) |
| `WEBHOOK_URL` / `WEBHOOK_TYPE` / `WEBHOOK_DAYS` | empty / `generic` / `3` | Default alert settings; values saved in the UI override these |
| `SEED_DEMO` | `false` | Add three sample items when the database is empty |

## Run locally
```bash
npm install
DATA_DIR=./data npm start        # http://localhost:3000
# or
docker compose up --build        # uses build: .
```

## Push to GitHub
```bash
git init && git add . && git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```
The workflow publishes `ghcr.io/<owner>/<repo>:latest` (amd64 + arm64). Then, on GitHub: Packages -> your package -> Package settings -> set visibility to Public (or add a ghcr.io registry credential in Dockhand with a token that has `read:packages`).

## Deploy as a Dockhand Git stack
1. Prepare the data folder on the server (absolute path, so it survives Dockhand re-cloning the repo):
   ```bash
   sudo mkdir -p /opt/stacks/subtrack/data
   sudo chown 1000:1000 /opt/stacks/subtrack/data
   ```
2. In Dockhand, create a stack from a Git repository: repo URL, branch `main`, compose file `docker-compose.yml`. Add a credential if the repo is private.
3. Add environment variables (from `.env.example`): at minimum `GHCR_OWNER`, `GHCR_REPO`, `HOST_DATA_DIR=/opt/stacks/subtrack/data`, and `PORT` if 3000 is taken.
4. Deploy. The container reports healthy once `/api/health` responds.
5. Auto-deploy (optional): enable the webhook / auto-update option in the stack's Git settings, then add that URL in GitHub under Settings -> Webhooks (push events). The image is rebuilt by Actions, so pull/redeploy after the workflow finishes, or use a Dockhand image auto-update schedule. Data in `HOST_DATA_DIR` is untouched by redeploys.
6. If you would rather build on the server, leave `build: .` as is and redeploy with the build option enabled in Dockhand.

## Reverse proxy / private network
- Nginx Proxy Manager: forward to `<server-ip>:<PORT>`; leave `AUTH_*` empty if Authelia or another SSO sits in front.
- Tailscale Serve: `tailscale serve --bg http://127.0.0.1:3000`
- No public exposure is needed. The app trusts `X-Forwarded-*` headers.

## Backup
Use Settings -> Export JSON, or copy `subtrack.db` from `HOST_DATA_DIR` while the container is stopped.

## Notes
- Month-end due dates are clamped when advanced (Jan 31 becomes Feb 28, then Mar 28).
- Dashboard totals count only active items. Custom cycles use `amount * 30.4375 / days` per month.
