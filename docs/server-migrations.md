# Applying database migrations from the server

**Status:** active procedure
**Applies to:** `212.227.44.13`, checkout at `/opt/tugpt`
**Staging project ref:** `rbiumegrwtavmljxbknp`

---

## 0. Why this document exists

On 2026-08-19 the first end-to-end milestone-1 run completed and reported
success against a staging database that was **missing migration
`20260819000001`**. `pnpm exec supabase db push` had failed on the server with:

```
Cannot find project ref. Have you run supabase link?
```

Nothing downstream treated that as fatal. The harness printed
`[WARN] could not read failed_jobs: column provider_error_detail does not exist`
and carried on to a green result.

Two things came out of that:

1. This document — one procedure, no linking step, no interactive prompts.
2. A hard gate in the harness preflight (§4). It now refuses to run when the
   checkout contains migrations the database does not have.

---

## 1. Recommended: push with an explicit connection string

`supabase db push --db-url` bypasses `supabase link` entirely. Nothing is
stored in `supabase/.temp/`, no Supabase **access token** is needed, and there
is no interactive prompt — which is what makes it the right choice for a
headless box.

```bash
cd /opt/tugpt
set -a; . /etc/tugpt/migrate.env; set +a

# Always look before you leap.
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run

# Apply.
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
```

`--dry-run` prints the migrations that *would* be applied. If it prints
nothing, the database is already current; if it prints something unexpected,
stop and read §6 before applying.

### 1.1 The credential file

Create `/etc/tugpt/migrate.env`, alongside the existing `worker.env` and
`web.env`:

```bash
sudo install -m 0600 -o root -g root /dev/null /etc/tugpt/migrate.env
sudo tee /etc/tugpt/migrate.env >/dev/null <<'EOF'
# Database owner connection string for schema migrations.
# NOT read by any service. Used only by an operator running `supabase db push`.
SUPABASE_DB_URL='postgresql://postgres.rbiumegrwtavmljxbknp:PASSWORD@POOLER_HOST:5432/postgres'
EOF
```

Deliberately a separate file from `worker.env` / `web.env`: the workers must
never hold a credential that can alter the schema. Nothing loads
`migrate.env` at boot; no systemd unit references it.

**Root-owned, mode 0600.** It holds the database owner password.

### 1.2 Filling in the two placeholders

Both come from the Supabase dashboard →
**Project Settings → Database → Connection string → URI**:

| Placeholder | Where it comes from |
|---|---|
| `POOLER_HOST` | The host in the **Session pooler** URI, e.g. `aws-0-<region>.pooler.supabase.com`. The region is project-specific — copy it, don't guess. |
| `PASSWORD` | The database password. Not the anon key, not the service-role key, not a personal access token. If nobody has it, use **Reset database password** on that page. |

Two rules that cause most first-attempt failures:

- **Percent-encode the password.** The CLI requires it (`--db-url string
  (must be percent-encoded)`). `@ : / ? # [ ] %` and friends must be escaped —
  a literal `@` in the password will split the URI at the wrong place and
  produce a confusing host-not-found error. Generate the encoded form with:
  ```bash
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' 'the-password'
  ```
- **Port 5432, session mode — not 6543.** The transaction-mode pooler on 6543
  does not support the session-scoped operations a migration needs (advisory
  locks, some prepared statements). Migrations run through it fail in
  non-obvious ways.

The direct host, `db.rbiumegrwtavmljxbknp.supabase.co:5432`, also works and is
marginally simpler. Prefer the pooler anyway: on current Supabase projects the
direct host resolves to IPv6 only unless the IPv4 add-on is enabled, and a
VPS without IPv6 egress gets `dial tcp: network is unreachable`. If you see
that error against the direct host, switch to the session pooler rather than
buying anything.

### 1.3 Single-quote the variable

```bash
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"    # correct
pnpm exec supabase db push --db-url $SUPABASE_DB_URL      # wrong — word-splits
```

---

## 2. Alternative: link the project

Works, but needs an extra secret and writes state into the checkout. Use it
only if §1 is blocked for some reason.

```bash
cd /opt/tugpt
export SUPABASE_ACCESS_TOKEN='sbp_...'          # personal access token
pnpm exec supabase link --project-ref rbiumegrwtavmljxbknp
pnpm exec supabase db push --linked
```

- `SUPABASE_ACCESS_TOKEN` is a **personal access token** from
  <https://supabase.com/dashboard/account/tokens> — a different credential
  from the database password and from the service-role key. It grants
  management-API access to every project the issuing account can see, which is
  a considerably larger blast radius than a single database password. That is
  the main reason §1 is preferred.
- `link` still prompts for the database password unless `-p` is passed, so
  this path does not actually avoid needing it.
- It writes `supabase/.temp/` into the checkout. That directory is
  git-ignored; do not commit it, and expect `git pull` to be unaffected by it.
- Export the token for the command only. Do not add it to any file under
  `/etc/tugpt/`, and do not put it in a shell rc file.

---

## 3. What to run right now

**The dry run is the authority on what is outstanding — not this document.**
This section used to list the specific migrations the staging database was
behind by. That list was correct on the day it was written and wrong one commit
later, when `20260819000003` landed and nobody came back to edit it. A runbook
that inventories a moving target is a runbook that lies; `--dry-run` reads the
ledger and cannot go stale.

```bash
cd /opt/tugpt
git fetch origin && git checkout main && git pull --ff-only
pnpm install --frozen-lockfile
set -a; . /etc/tugpt/migrate.env; set +a
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL" --dry-run
pnpm exec supabase db push --db-url "$SUPABASE_DB_URL"
```

Then restart the workers so they pick up the new code, and verify (§4):

```bash
sudo systemctl restart tugpt.service          # recreates the whole compose stack
docker compose -p tugpt ps --status running --services \
  | grep -E '^(whatsapp-worker|draft-worker)$'   # both must print
```

`tugpt.service` is the only unit on this host; its `ExecStart` is
`docker compose … up -d --build --remove-orphans`, so a restart is what picks up
new code. There are no `tugpt-draft-worker` / `tugpt-whatsapp-worker` units —
see `docs/production_environment.md` §5.1.

---

## 4. Verifying — the gate

The milestone-1 harness preflight now proves the database matches the
checkout, and **fails the run** if it does not:

```bash
cd /opt/tugpt
pnpm --filter @tugpt/worker exec tsx src/e2e/milestone1.ts preflight \
  --env-file /etc/tugpt/worker.env --env-file /etc/tugpt/web.env
```

It checks two things:

1. **Ledger diff** — fatal, *except* that it can be skipped. Every `.sql` file
   in `supabase/migrations` must have a row in
   `supabase_migrations.schema_migrations`. This is generic — adding a migration
   file extends the check automatically, with no code change. The ledger lives
   in a schema PostgREST does not expose, so it is read through
   `applied_migration_versions()`, a `SECURITY DEFINER` function granted to
   `service_role` only. It returns version and name; never the migration SQL.

   **The exception matters.** If the harness cannot locate a
   `supabase/migrations` directory above itself — running from a `dist/` build
   shipped without `supabase/`, for instance — it prints
   `[WARN] Could not locate a supabase/migrations directory ... skipping the
   migration-ledger diff` and carries on. The effect probes still run and are
   still fatal, but the layer that catches a *missing* migration is gone. On the
   VPS the harness runs from the checkout, so this does not apply; if you ever
   see that warning, the ledger was not checked and the run proves less than it
   appears to.
2. **Effect probes** — fatal. Specific objects are queried directly, because a
   ledger row proves a migration was *recorded*, not that it *took effect* — the
   two diverge after a partially applied migration or a ledger row inserted by
   hand to unstick a push.

   There are exactly two, and **both belong to `20260819000001`**:
   `failed_jobs.provider_error_detail` and the four-argument
   `archive_draft_failed_job` overload. `20260819000002` is proved indirectly —
   the ledger read itself fails if its RPC is absent. **`20260819000003` has no
   probe**, so a recorded-but-ineffective apply of it would pass this gate; what
   it changes is `private.store_draft` writing `provider` and `model` onto the
   job row, so the symptom would be per-model attribution coming back NULL.
   Adding that probe is worth doing, and deliberately not being done in the same
   change as this correction: a new probe that is wrong fails the gate and blocks
   a rebuild.

The **schema-gate lines** of a clean run — an excerpt, not the whole output.
Preflight also prints a `=== PREFLIGHT ===` banner, three `[info]` lines about
the resolved credentials, and `[ok]` lines for the service-role connection, the
`whatsapp_integration` check, the test organization and `preflight complete`.
Those are not reproduced here; do not read extra lines as a problem.

Since 2026-09-03 it also reports the age of each FX rate, for example
`[ok]   EUR->USD rate is from 2026-09-02 (1 days old)`. Past the freshness
threshold that line becomes a `[WARN]` asking for a refresh from the ECB daily
reference rate. **It never fails the gate.** Provider spend keeps converting at
the old rate, because an old official rate beats refusing enforcement, and the
rate and its date are stored on every converted row so staleness can move an
enforcement decision but never corrupt a recorded total.

Refreshing is a manual monthly job by decision, which is exactly why the
reminder lives in a gate that runs on every deploy rather than in someone's
calendar. To refresh, insert a row into `fx_rates` with the new rate, its ECB
reference date, and a source naming both.

<!-- schema-gate-sample:start -->

```
  [ok]   all 55 migration(s) in this checkout are applied (database has 55, latest 20260905000001)
  [ok]   20260819000001: failed_jobs.provider_error_detail column — column is selectable
  [ok]   20260819000001: archive_draft_failed_job 4-argument overload (extended error-code allowlist) — signature present, returned P3B07 DRAFT_JOB_NOT_FOUND
  [ok]   database schema matches this checkout
```

<!-- schema-gate-sample:end -->

The count and the latest version above are real values, and
`apps/worker/tests/server-migrations-doc.test.ts` asserts they match
`supabase/migrations` in this checkout — which is the only reason this block
is still true. It has now gone stale twice and been caught by that test both
times, and mechanically since: it said 37 / `20260819000002` until
2026-08-25, 38 / `20260819000003` until `20260826000001` (the draft-quota-period
lifecycle) landed, 39 / `20260826000001` until `20260830000001` (the
organization locale column) landed, 40 / `20260830000001` until
`20260830000002` (the Spanish AI seed defaults), 41 / `20260830000002` until
`20260901000001` (the conversation activity-ordering column), and 42 /
`20260901000001` until the four September-2 branches merged together and took
it to 46 / `20260903000001`, 46 / `20260903000001` until `20260903000002`
(provider usage and cost), 47 / `20260903000002` until `20260903000003`
(secret storage), 48 / `20260903000003` until `20260903000004` (the
voice-transcription flag and the Gladia rate), 49 / `20260903000004` until
`20260903000005` (multi-currency and the Langdock rates), 50 /
`20260903000005` until `20260903000006` (FX conversion), 51 / `20260903000006`
until `20260903000007` (the FX status RPC the preflight gate reads), 52 /
`20260903000007` until `20260903000008` (the transcript ingest path), and 53 /
`20260903000008` until `20260904000001` (revoking TRUNCATE, TRIGGER and
REFERENCES from the browser roles). No correction has ever been noticed by a human
reading the document; every one of them was this test failing a build.

A note on that four-branch step, because the list above was briefly wrong in a
way worth recording. Each of those branches appended its own increment to this
history from its own base, so the merge concatenated four sequences that each
skipped the other three: the prose read "43 / `20260902000002`" while the
sample block above it correctly read 46. The guard test checks the block and
not the prose, so nothing failed. **A hand-maintained narrative beside a
machine-checked value will drift, and only the checked half will say so** —
which is an argument for keeping the narrative short rather than for adding a
second checker to police it.

A stale database aborts with `REFUSING TO RUN`, followed by:

- **the list of missing migrations** — bare versions, comma-separated. No
  explanation of what each one's absence breaks: `consequence` text exists only
  for the effect probes below, and only `20260819000001` has any. If the ledger
  diff names a version you do not recognise, `git log --oneline -- supabase/migrations`
  is the fastest way to find out what it did.
- **what a failed probe breaks** — the `consequence:` line, for probe failures
  only.
- **the command from §1**, including the `set -a; . /etc/tugpt/migrate.env`
  line and a pointer back to §5 about the bookkeeping row.

The probes are read-only. The `archive_draft_failed_job` probe calls the RPC
with a random job id, which the function rejects with `P3B07` before it writes
anything; the raise aborts the transaction.

To check the ledger by hand:

```bash
# NEXT_PUBLIC_SUPABASE_URL, not SUPABASE_URL — the unprefixed name is defined
# nowhere in this project, and sourcing worker.env leaves it empty, so the
# request goes to "/rest/v1/..." with no host and fails without saying why.
curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/rpc/applied_migration_versions" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{}' | tail -c 400
```

---

## 5. psql fallback — and the bookkeeping row

Applying a migration with `psql` alone is **not equivalent** to
`supabase db push`. `push` does two things: it runs the SQL, and it records the
version in `supabase_migrations.schema_migrations`. Skip the second and the
next `push` will try to re-apply the same file, and the preflight ledger diff
will keep reporting it missing.

If you must use psql (e.g. the CLI is unavailable), do both, in one
transaction:

```bash
psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 <<SQL
\i supabase/migrations/20260819000002_expose_applied_migration_versions.sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260819000002', 'expose_applied_migration_versions')
ON CONFLICT (version) DO NOTHING;
SQL
```

`--single-transaction` matters: without it a failure halfway leaves the
schema partly changed with no ledger row and no clean way back.

Prefer §1. This is a fallback, not a shortcut.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find project ref. Have you run supabase link?` | `db push` with no `--db-url`, `--linked` or `--local`, in an unlinked checkout | Use `--db-url` (§1) |
| `dial tcp ...: network is unreachable` | Direct host is IPv6-only; the VPS has no IPv6 egress | Use the session pooler host (§1.2) |
| `failed SASL auth` / `password authentication failed` | Wrong password, or unencoded special characters | Re-encode (§1.2); reset the password if unknown |
| `Found local migration files to be inserted before the last migration on remote database` | The remote has a migration newer than one you are pushing — usually a hand-applied change or a diverged branch | Do **not** reach for `--include-all` reflexively. Read the list, work out how the remote got ahead, then decide |
| Push succeeds but preflight still fails a probe | Ledger row present, object absent — a partial apply | Re-run the specific migration's SQL (§5), keeping the existing ledger row |
| `permission denied for schema supabase_migrations` when querying by hand | Expected. Nothing in this repo grants `service_role` access to that schema, and `config.toml` does not expose it to PostgREST either — so both a direct `psql` query and a REST call fail, for different reasons | Use `applied_migration_versions()` (§4) |

---

## 7. Rules

- **Migrations are applied from `main`, never from a feature branch.** The
  server tracks `main`; applying a branch's migration produces a database no
  merged commit describes.
- **Never edit a migration that has been applied.** Write a new one. The CLI
  keys the ledger on the version timestamp and will not notice the change.
- **Nothing that runs unattended holds the migration credential.** No systemd
  unit, no worker, no CI job reads `/etc/tugpt/migrate.env`.
- **Anything destructive** — a `DROP`, a data-losing rewrite, a credential
  rotation — is escalated to the owner before it is run, per the standing
  directive. This document covers additive migrations only.
