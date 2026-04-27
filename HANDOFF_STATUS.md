# Core Elite — Handoff Status

> Last updated: 2026-04-23
>
> Operational snapshot for on-call engineers and new staff. Reflects
> the state of the codebase after Missions Q.3, R, R.2, S, T, U, V.
> Pair with `ARCHITECTURE.md` (structure) and `FINAL_SIGNOFF_AUDIT.md`
> (compliance evidence). Update this file whenever a shippable mission
> lands.

---

## Current branch

`main` — all recent missions have been merged into the mainline
working tree. No long-lived feature branches outstanding.

Recent commit narrative (newest first):

1. **Mission V — Compliance Sweep.** `security.yml` workflow, APM
   layer + Supabase RPC instrumentation, docs sync (this file,
   `FINAL_SIGNOFF_AUDIT.md`, `ARCHITECTURE.md`).
2. **Mission U — Hardware Link.** npm workspaces linked; mock BLE
   laser-trip simulator; shared HLC core; PowerSync mobile init stub;
   laser-trip pipeline test (3 cases, all passing).
3. **Mission T — Virtualization Engine.** `AthletesTab` + `ResultsTab`
   rewritten with `@tanstack/react-virtual` + zinc-950 dark mode.
4. **Mission S — RPC Versioning Matrix.** JSONB router + `_v5`/`_v6`
   internal implementations + `failed_rpc_logs` DLQ + named-param
   adapter pinned to `_v:'6'`.
5. **Mission R + R.2 — Film Fusion.** `film_url` column + `parseFilmUrl`
   helper + `<FilmEmbed>` + `<AthleteScoutView>` bento grid.
6. **Mission Q.3 — Physics Engine.** Weight-adjusted positional
   benchmarks + `[ SENSOR NULL ]` state + `[ MASS ADJUSTED ]` header.

---

## What is live

### Web application

- **Vite 6 / React 19** production bundle. `npm run build` produces
  the dist tree served by Netlify (`vercel.json` is legacy).
- **Admin Ops** (`/admin/ops`) — fully virtualized roster and results
  tables. Scroll through 2k rows on iPad without frame drops.
- **Film Fusion** (`/scout/:athleteId`) — ProgressionMatrix + film
  bento grid, dark-mode. Null film state rendered as
  `NO FILM LINKED` placeholder.
- **APM** — active in prod only. Requires `VITE_APM_ENDPOINT` to flow
  events; otherwise `initAPM()` early-returns with no transport set.

### Supabase

- **RPC router** `submit_result_secure(JSONB)` dispatches to
  `_v5`/`_v6`. Named-param callers still work (12-param adapter
  packs args into JSONB with `_v:'6'`).
- **Dead-letter queue** `failed_rpc_logs` — admin-read-only table
  populated on `INVALID_PAYLOAD`, `MISSING_REQUIRED_KEYS`,
  `DEPRECATED_VERSION`, `UNKNOWN_VERSION`. No payload is ever silently
  dropped.
- **Registration** via `register_athlete_secure_v6` — `film_url` is
  an optional `TEXT` column, normalised server-side.

### Mobile workspace

- Three packages linked as npm workspaces: `@core-elite/native-ble`,
  `@core-elite/powersync`, `@core-elite/field-ops`.
- Baseline (mock) path compiles and runs in vitest; production
  (`react-native`-bound) path requires RN toolchain to typecheck.
- `startLaserTripPipeline(listener, hlc, sink)` is the integration
  point — subscribe once, every simulated trip becomes an HLC-stamped
  outbox entry.

### CI/CD

- **`.github/workflows/security.yml`** — `npm audit` + Trivy on every
  PR to `main` and weekly. High/critical findings block merge;
  moderate/low are informational. Weekly cron runs Mon 07:00 UTC so
  freshly-disclosed CVEs get caught even when no PRs are open.
- No other workflows are currently active. Tests are intended to run
  locally via `npx vitest run`; a CI test job is an open item.

---

## Known prerequisites before shipping

1. **Set `VITE_APM_ENDPOINT`** in the production environment or the
   APM layer stays inert. The endpoint should accept
   `POST application/json` with the `APMEvent` shape defined in
   `src/lib/apm.ts`.
2. **Deploy migrations 024 + 025** (supabase/migrations/):
   - `20260422000024_rpc_versioning_matrix.sql`
   - `20260423000025_rpc_versioning_align_v5_v6.sql`
   The router is idempotent — re-running either migration is safe.
3. **PowerSync service endpoint** (`VITE_POWERSYNC_URL`) is still
   unset. Mobile packages compile without it; a real sync stream
   requires the service to be deployed first.

---

## Known gaps (tracked in `FINAL_SIGNOFF_AUDIT.md` → "Open items")

- Production `native-ble` tsconfig is excluded from `lint:mobile`
  until `react-native` types are installed.
- `src/types/supabase.ts` is hand-authored — swap for
  `npx supabase gen types typescript --local` output once Docker +
  local Supabase are up on the builder box.
- APM vendor selection not finalized. `BeaconTransport` writes to
  `VITE_APM_ENDPOINT`; Sentry / LogRocket adoption just requires a
  new `APMTransport` implementation.

---

## How to verify the current state

```bash
# Web app typecheck
npx tsc --noEmit

# Mobile workspace typecheck (three targeted tsconfigs)
npm run lint:mobile

# Full test suite (94+ tests, includes APM, HLC, LWW, laser-trip pipeline)
npx vitest run

# Production build
npm run build
```

All four commands should exit 0 on `main`. If any fail, the
working tree is ahead of what this document describes — update both.

---

## Who touched what (for blame context)

The recent mission series was executed autonomously by a pair-programming
agent against explicit `CONTEXT / DIRECTIVE / EXECUTION STEPS` prompts.
Commit attributions follow the standard `Kevin Jones` author identity
with `Co-Authored-By: Claude Opus 4.7` trailers. See
`git log --oneline -20` for the full narrative.
