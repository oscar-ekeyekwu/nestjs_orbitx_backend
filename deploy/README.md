# OrbitX backend — deploy runbook

This folder holds deploy-time configuration and operator-facing notes for
the OrbitX backend. The app itself is a NestJS service deployed onto a
single Ubuntu host via `docker compose`; this README captures the parts
that aren't in the application code.

## Fresh environment reset (B7)

For pre-launch dev / staging environments — wipe everything and land
back at v1 baseline.

```bash
# 1. Drop the public schema (every table, enum, sequence, index). The
#    FORCE_DB_RESET=true guard is a two-factor against accidental
#    runs against a dev machine pointed at staging.
FORCE_DB_RESET=true npm run db:reset

# 2. Run all migrations forward — InitialV1Migration creates the v1
#    schema; the follow-ups (drop inline vehicle columns, rename
#    membership status) apply in order.
npm run migration:run

# 3. Seed the baseline rows: admin user (from ADMIN_EMAIL +
#    ADMIN_PASSWORD env vars; warns if defaults), system_configs
#    (pricing, USE_MAP_VIEW, VEHICLE_EDIT_GRACE_MODE, LAGOS_SERVICE_BBOX).
#    Idempotent — re-running is safe and won't overwrite admin-tuned
#    config values.
npm run seed:v1
```

`db:reset` refuses to run with `NODE_ENV=production`. Production-side
resets are a separate runbook (not in this repo) and must be reviewed
manually.

## Post-migration verification

The deploy workflow runs `migration:run || true`, which is a known
silent-failure footgun (project-context.md). After every deploy, eyeball
the migrations log AND confirm the latest migration landed by running:

```bash
psql -U orbit_app -d orbitx -c \
  "SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 5;"
```

The most recent entry should match the newest file in
`src/database/migrations/`. If it doesn't, the deploy silently dropped
a migration and the app is running against a stale schema — investigate
before letting traffic flow.

A scripted version of this check lives as a future story (D-or-J track).

## Postgres role split (ARCH-7 — audit immutability)

`approval_decisions` and `transactions` are append-only at the database
layer. The application role is **revoked** from UPDATE and DELETE on
those tables, so even a buggy or malicious code path that tries to
rewrite the audit ledger gets a `permission denied` from Postgres
itself. The error surfaces to the client as
`errorCode: 'SYS_005'` / HTTP 403.

This requires **two Postgres roles** per environment:

| Role | Purpose | Privileges |
| --- | --- | --- |
| `orbit_migrator` | Runs `npm run migration:run` (DDL) | Schema owner. Full privileges on the `orbitx` database. |
| `orbit_app` | Used by the running NestJS service | `INSERT, SELECT` on every table; `UPDATE, DELETE` revoked on `transactions` and `approval_decisions`. |

### Provisioning a fresh environment

Run these as a Postgres superuser (or whatever role owns the cluster)
**before** `migration:run`:

```sql
-- 1. Create the two roles. Pick strong passwords; store in your secrets
--    manager and reference them via env vars (DB_USERNAME / DB_PASSWORD
--    for the app, separate creds for the migrator).
CREATE ROLE orbit_migrator LOGIN PASSWORD '...';
CREATE ROLE orbit_app      LOGIN PASSWORD '...';

-- 2. Create the database owned by the migrator.
CREATE DATABASE orbitx OWNER orbit_migrator;

-- 3. (Inside the orbitx database) grant the app role baseline access.
\c orbitx
GRANT CONNECT ON DATABASE orbitx TO orbit_app;
GRANT USAGE   ON SCHEMA public   TO orbit_app;

-- 4. Default privileges so every future migrator-owned table is readable
--    + insertable by orbit_app out of the box. The migration then
--    REVOKEs UPDATE/DELETE on the two audit tables to land the
--    immutability contract.
ALTER DEFAULT PRIVILEGES FOR ROLE orbit_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orbit_app;
ALTER DEFAULT PRIVILEGES FOR ROLE orbit_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO orbit_app;
```

Then:

```bash
# Migrations as the schema owner — picks up orbitx-backend's ormconfig.ts.
DB_USERNAME=orbit_migrator DB_PASSWORD=... npm run migration:run

# Baseline seed.
DB_USERNAME=orbit_migrator DB_PASSWORD=... npm run seed:v1

# Application runs under the app role going forward.
# Set DB_USERNAME=orbit_app DB_PASSWORD=... in the service env.
```

The `InitialV1Migration` baseline contains a `DO $$ ... END $$` block
that REVOKEs UPDATE/DELETE and re-GRANTs INSERT/SELECT on the audit
tables for `orbit_app`. It no-ops if the role isn't present, so a dev
environment without the split still works.

### Verifying the immutability contract on a fresh deploy

Run this once per environment after `migration:run`:

```bash
psql -U orbit_app -d orbitx -c \
  "UPDATE approval_decisions SET reason='tamper' WHERE id IS NOT NULL;"
# Expect: ERROR:  permission denied for table approval_decisions

psql -U orbit_app -d orbitx -c \
  "DELETE FROM transactions WHERE 1=0;"
# Expect: ERROR:  permission denied for table transactions
```

If either command succeeds, the migration's `DO` block silently skipped
the GRANT/REVOKE (likely because `orbit_app` didn't exist when the
migration ran). Provision the role, then re-run:

```sql
DO $$
BEGIN
  REVOKE UPDATE, DELETE ON TABLE approval_decisions FROM orbit_app;
  REVOKE UPDATE, DELETE ON TABLE transactions       FROM orbit_app;
  GRANT  INSERT, SELECT ON TABLE approval_decisions TO   orbit_app;
  GRANT  INSERT, SELECT ON TABLE transactions       TO   orbit_app;
END
$$;
```

### What the API does when an UPDATE is attempted

Any 42501 (`insufficient_privilege`) error from Postgres that mentions
`approval_decisions` or `transactions` is mapped by
`AllExceptionsFilter` to:

```json
{
  "success": false,
  "errorCode": "SYS_005",
  "message": "Audit table is append-only at the database layer. ...",
  "statusCode": 403
}
```

If you see this in your logs, do **not** patch around it by granting
back UPDATE/DELETE. Instead fix the caller — the audit ledger is meant
to be append-only and the platform's NDPA / DR-A1 / DR-A2 commitments
depend on it.

## Other deploy concerns

- `nginx/` — reverse-proxy + TLS termination config (placeholder; fill in
  as we wire HTTPS).
- Future docs land here as separate `.md` files alongside this one.
