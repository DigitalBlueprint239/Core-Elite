# Core Elite Combine Production Remediation Summary (2026-03-24)

## Purpose
This document records the confirmed live Supabase production remediation outcomes and the source-control reconciliation requirement.

## Confirmed Production Runtime Status
- `claim_band_atomic` runtime validated.
- `register_athlete_atomic` runtime validated after production-schema remediation.
- `submit_result_atomic` runtime validated after production-schema remediation.
- `submit_result_atomic` idempotency validated.
- `report_jobs` indexing remediation validated (`idx_report_jobs_event_status_created` exists; no athlete_id-based uniqueness in production).
- Critical path is green in production.

## Source-Control Reconciliation Requirement
GitHub must be restored as source of truth by back-porting the production-safe RPC bodies into repository migrations and removing old schema assumptions from source-controlled SQL.

## Corrective Migration
- Added `migrations/011_reconcile_live_production_rpcs.sql`.
- This migration redefines:
  - `claim_band_atomic(text, text)`
  - `register_athlete_atomic(uuid, jsonb, jsonb, text, timestamptz, text)`
  - `submit_result_atomic(uuid, uuid, uuid, text, text, text, numeric, jsonb, timestamptz)`

## Frontend/Admin Legacy Assumption Checks
Verify no code path still assumes:
- `results.band_id`
- `results.value_num`
- `results.meta`
- `results.recorded_at`
- `report_jobs.athlete_id`
- `report_jobs.report_url`
