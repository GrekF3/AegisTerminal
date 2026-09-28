# Hedge server

Production FastAPI service for desktop licence verification, admin user management, downloads and updates.

1. Copy `.env.example` to `.env` and replace both secrets.
2. Run `docker compose up -d --build`.
3. Bootstrap the first admin with `docker compose run --rm hedge-api python bootstrap_admin.py`.

The desktop admin API uses a short-lived bearer token returned only after an admin key is verified with the registered device fingerprint. User access keys remain directly viewable to an authenticated administrator, as required by the desktop UI.

## Health checks and proxy 404s

Traefik removes the API router when Docker marks `hedge_api` unhealthy. A plain-text
`404 page not found` on both `/healthz` and `/verify` can therefore be a container
health failure, not a missing FastAPI route. Check the container health history and
the direct container `/healthz` response before changing API URLs.

The probe uses `python -S` with a small HTTP socket request, verifies HTTP 200 and
allows 30 seconds for process scheduling, with a 5-second socket timeout. This
avoids the previous five-second process-start deadline under VPS CPU starvation.
It does not fix exhausted host capacity: sustained high `st` in `vmstat` requires
attention from the hosting provider. Keep the existing data volumes and change
only the `hedge-api` service when applying health configuration.
