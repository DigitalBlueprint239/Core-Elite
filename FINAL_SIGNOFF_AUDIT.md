# Core Elite — Final Sign-off Audit

> Last updated: 2026-04-23 · Mission V (Compliance Sweep)
>
> This file is the single source of truth for D1 University infosec
> sign-off. Every row links to the artefact (migration, workflow, test,
> or doc) that proves the control is in place. When a control is
> added, removed, or materially changed, update this file in the same
> commit — reviewers treat stale rows as unsigned.

---

## 1. Authentication & authorization

| Control | Status | Evidence |
|---|---|---|
| Email/password auth with JWT refresh | ✅ | `ARCHITECTURE.md` §5 |
| PKCE OAuth callback route | ✅ | `src/pages/auth/AuthCallback.tsx` |
| `RouteGuard` blocks unauthenticated + non-admin paths | ✅ | `src/components/RouteGuard.tsx` |
| Admin role enforced server-side via RLS, not UI | ✅ | RLS matrix in `ARCHITECTURE.md` §5 |
| Offline override PIN — PBKDF2 hashed, stored in `event_config` | ✅ | `src/lib/overridePin.ts`, migration 020 |

## 2. Data integrity

| Control | Status | Evidence |
|---|---|---|
| HLC-ordered writes — one clock algorithm, shared format | ✅ | `src/lib/hlc.ts`, `packages/powersync/src/hlc.ts` |
| Add-biased LWW with `DuplicateChallenge` resolution UI | ✅ | `src/lib/lww.ts`, `useOfflineSync` hook |
| Verification-hash-signed CSV exports (HMAC-SHA-256) | ✅ | `supabase/functions/generate-verified-export` |
| RPC versioning matrix — router + DLQ for unmatched payloads | ✅ | `supabase/migrations/20260422000024_rpc_versioning_matrix.sql`, `…20260423000025_rpc_versioning_align_v5_v6.sql` |
| `failed_rpc_logs` DLQ — admin-read-only RLS | ✅ | Same migrations §1 |

## 3. Compliance gates in CI

| Control | Status | Evidence |
|---|---|---|
| `npm audit --audit-level=high` on every PR to `main` | ✅ | `.github/workflows/security.yml` — job `npm-audit` |
| Cross-ecosystem CVE scan (Trivy) w/ SARIF upload | ✅ | Same workflow — job `trivy` |
| Weekly scheduled sweep (Mon 07:00 UTC) | ✅ | Same workflow — `schedule: cron` |
| Principle-of-least-privilege `permissions:` block | ✅ | Same workflow — top-level `permissions` |
| `contents: read`, `security-events: write` only | ✅ | Same workflow |

## 4. Observability

| Control | Status | Evidence |
|---|---|---|
| APM layer — prod-only, sampled, vendor-agnostic | ✅ | `src/lib/apm.ts`, test suite `src/lib/__tests__/apm.test.ts` |
| Supabase RPC round-trips wrapped with latency beacons | ✅ | `src/lib/supabase.ts` — `instrumentRpc()` |
| SPA route transitions beaconed | ✅ | `<RouteTiming>` in `src/App.tsx` |
| PerformanceObserver — `longtask` + `LCP` | ✅ | `src/lib/apm.ts` — `initAPM()` |
| APM disabled outside prod or via `VITE_APM_DISABLED=1` | ✅ | Test: *"is inert outside prod"* |
| Slow-query thresholds documented (RPC 300ms, SELECT 500ms, render 100ms) | ✅ | `APM_THRESHOLDS` export + `ARCHITECTURE.md` §10 |

## 5. Scalability + performance

| Control | Status | Evidence |
|---|---|---|
| DOM-virtualized admin roster (AthletesTab) | ✅ | `src/pages/admin-ops/AthletesTab.tsx` — `@tanstack/react-virtual` |
| DOM-virtualized results ledger (ResultsTab) | ✅ | `src/pages/admin-ops/ResultsTab.tsx` |
| 10k fetch cap with DEV-mode over-cap warning | ✅ | `FETCH_CAP` constant in both tabs |
| Memoized filtered lists to prevent virtualizer remeasure | ✅ | `useMemo` blocks in both tabs |
| `contain: strict` on scroll container | ✅ | Both tabs' scroll-viewport div |

## 6. Athlete intake surface

| Control | Status | Evidence |
|---|---|---|
| Registration via `register_athlete_secure` RPC (no direct table writes) | ✅ | Migrations 023 / 024 |
| Film URL capture — optional, validated server-side | ✅ | `supabase/migrations/20260422000022_profiles_film_url.sql`, `…023_register_athlete_film_url.sql` |
| Film playback via typed `parseFilmUrl()` (Hudl / YouTube / Vimeo) | ✅ | `src/lib/hudl.ts`, `src/components/FilmEmbed.tsx` |
| Scout view — ProgressionMatrix + Film bento grid | ✅ | `src/components/AthleteScoutView.tsx` |

## 7. Mobile baseline

| Control | Status | Evidence |
|---|---|---|
| npm workspaces linked at root | ✅ | `package.json` — `"workspaces": ["packages/*"]` |
| Mock BLE laser-trip simulator (pure TS) | ✅ | `packages/native-ble/src/mock.ts`, `stub.ts` |
| Shared HLC core — byte-identical web ↔ mobile format | ✅ | `packages/powersync/src/hlc.ts` + `src/lib/hlc.ts` |
| PowerSync mobile init scaffold — `initMobilePowerSync()` | ✅ | `packages/powersync/src/native-init.ts` |
| End-to-end laser-trip pipeline test (3 cases) | ✅ | `packages/field-ops/src/mobile/__tests__/laserTrip.test.ts` |
| Targeted typecheck — `npm run lint:mobile` | ✅ | `package.json` scripts |

## 8. Documentation singularity

| Control | Status | Evidence |
|---|---|---|
| `ARCHITECTURE.md` reflects v5/v6 router + virtualization + mobile baseline | ✅ | §4 (RPC Matrix), §2 (apm.ts, hudl.ts), §8 (workspaces), §10 (compliance) |
| `FINAL_SIGNOFF_AUDIT.md` — this file | ✅ | *you are here* |
| `HANDOFF_STATUS.md` — operational state snapshot | ✅ | `HANDOFF_STATUS.md` |
| Env var table complete (APM + mobile) | ✅ | `ARCHITECTURE.md` §9 |

---

## Open items

- [ ] Install `react-native` + `@types/react-native` so
      `packages/native-ble/tsconfig.json` (the production variant) joins
      `npm run lint:mobile`.
- [ ] Regenerate `src/types/supabase.ts` from a live Supabase instance
      and replace the hand-authored shim.
- [ ] Replace `BeaconTransport` with the chosen vendor SDK (Sentry or
      LogRocket) and backfill the `APMTransport` adapter in
      `src/lib/apm.ts`.

---

## Change log

| Date | Mission | Change |
|---|---|---|
| 2026-04-23 | V | Initial sign-off audit — compliance / APM / docs sync |
| 2026-04-23 | U | Mobile workspace baseline linked |
| 2026-04-23 | T | Admin tabs virtualized |
| 2026-04-23 | S | RPC versioning matrix + DLQ |
| 2026-04-22 | R + R.2 | Film Fusion — url capture + playback |
| 2026-04-22 | Q.3 | Weight-adjusted progression matrix + null states |
