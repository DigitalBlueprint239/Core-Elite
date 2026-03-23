# Core Elite Combine Launch Readiness Runbook

## Scope
This runbook is for deploying and validating the hardened Core Elite Combine workflow end to end:
- athlete registration
- waiver capture
- token issuance
- band claim
- result submission
- offline retry / dead-letter visibility
- report job creation and readiness
- admin dashboard verification

---

## 1. Production prerequisites
- Confirm production Supabase project URL and anon key are configured in the frontend deployment environment.
- Confirm at least one event exists and exactly one intended event is `status = 'live'`.
- Confirm `bands` are preloaded for the active event.
- Confirm staff accounts can sign in at `/staff/login`.
- Confirm admin account can sign in at `/admin/dashboard`.
- Confirm a dedicated smoke-test athlete email/phone can be used safely.
- Confirm a small set of test wristbands is reserved for smoke testing.

---

## 2. Migration deployment order
Apply numbered SQL migrations in ascending order.

### Existing production project
If the project already has the seeded schema, apply any missing migrations in this order:
1. `migrations/003_device_status_updates.sql`
2. `migrations/004_parent_portal_and_reports.sql`
3. `migrations/005_incident_logging.sql`
4. `migrations/006_waiver_enhancements.sql`
5. `migrations/007_add_claim_band_atomic_rpc.sql`
6. `migrations/008_add_register_athlete_atomic_rpc.sql`
7. `migrations/009_add_submit_result_atomic_rpc.sql`
8. `migrations/010_fix_report_jobs_uniqueness.sql`

### Fresh environment
If this is a fresh project:
1. Apply `supabase_schema.sql`.
2. Apply `module1_migration.sql` if that environment still depends on it.
3. Apply any numbered migrations that are not already represented in the schema, in ascending order.

### Post-migration verification SQL
Run these after deployment:

```sql
-- Confirm RPCs exist
select proname
from pg_proc
where proname in ('register_athlete_atomic', 'claim_band_atomic', 'submit_result_atomic')
order by proname;

-- Confirm report_jobs uniqueness assumption is enforced
select indexname, indexdef
from pg_indexes
where tablename = 'report_jobs'
  and indexname = 'idx_report_jobs_athlete_unique';

-- Confirm no duplicate report jobs remain
select athlete_id, count(*)
from report_jobs
group by athlete_id
having count(*) > 1;
```

---

## 3. Frontend deployment order
1. Deploy database migrations first.
2. Verify the three RPCs exist before shipping frontend code.
3. Deploy frontend bundle.
4. After frontend deployment, perform the smoke test below before opening the event broadly.

---

## 4. End-to-end smoke test order
Perform these in order using one dedicated smoke-test athlete.

### A. Registration + waiver + token issuance
1. Open `/register` for the live event.
2. Complete athlete information.
3. Sign the waiver and submit.
4. Confirm navigation reaches `/claim-band?athleteToken=...`.

#### SQL verification
```sql
-- Replace with the smoke-test athlete email
select id, event_id, first_name, last_name, band_id, registration_token, created_at
from athletes
where parent_email = 'smoke-test@example.com'
order by created_at desc
limit 1;

select athlete_id, event_id, guardian_name, injury_waiver_ack, media_release, data_consent, waiver_version, created_at
from waivers
where athlete_id = '<ATHLETE_ID>';

select athlete_id, event_id, expires_at, used, used_at, token, token_hash
from token_claims
where athlete_id = '<ATHLETE_ID>';
```

Expected:
- one athlete row created
- one waiver row created
- one token claim row created
- token is unused before claim

### B. Band claim
1. Use the claim page reached from registration.
2. Scan or manually enter a reserved smoke-test band.
3. Confirm claim success screen appears.

#### SQL verification
```sql
select band_id, status, athlete_id, claimed_at, assigned_at
from bands
where band_id = '<BAND_ID>';

select id, band_id
from athletes
where id = '<ATHLETE_ID>';

select athlete_id, used, used_at, token, token_hash
from token_claims
where athlete_id = '<ATHLETE_ID>';
```

Expected:
- `bands.status = 'assigned'`
- `bands.athlete_id` points to athlete
- `athletes.band_id` matches the claimed band
- token claim is marked used

### C. Result submission
1. Sign in as staff at `/staff/login`.
2. Open the intended station route.
3. Scan the claimed smoke-test band.
4. Submit at least one valid result.
5. Confirm station UI returns to ready state and pending sync does not grow unexpectedly while online.

#### SQL verification
```sql
select client_result_id, athlete_id, band_id, station_id, drill_type, value_num, recorded_at
from results
where athlete_id = '<ATHLETE_ID>'
order by recorded_at desc;
```

Expected:
- one or more results exist for the athlete
- station/event/band/athlete values match

### D. Offline retry / dead-letter visibility
1. In staff station mode, disconnect network.
2. Scan a previously cached athlete and submit a result.
3. Confirm pending queue count increases.
4. Restore network.
5. Confirm queued item syncs automatically or via `Sync Now`.
6. If a forced failure is being tested, confirm the station shows the sync attention banner and failed-item retry control.

#### SQL / admin verification
```sql
select event_id, station_id, device_label, pending_queue_count, last_sync_at, last_seen_at, is_online
from device_status
order by last_seen_at desc;
```

Expected:
- pending queue grows offline
- pending queue returns to normal after sync
- stale/failed sync states are visible in station UI and admin station health

### E. Report job creation / readiness
1. Submit all required drill results for the smoke-test athlete.
2. Confirm a `report_jobs` row exists for that athlete.
3. If report generation workers are active, verify status transitions to `ready` and `report_url` is populated.
4. Open the parent portal and confirm report status matches DB state.

#### SQL verification
```sql
select required_drills
from events
where id = '<EVENT_ID>';

select athlete_id, event_id, status, report_url, created_at, updated_at
from report_jobs
where athlete_id = '<ATHLETE_ID>';
```

Expected:
- one report job row per athlete
- row begins as `pending`
- later transitions to `ready` when generation completes

### F. Admin dashboard verification
1. Sign in at `/admin/dashboard`.
2. Confirm the dashboard reflects:
   - athlete count increment
   - waiver count increment
   - assigned band count increment
   - result count increment
   - athlete completion based on event `required_drills`
   - report readiness once available
3. Export CSV and confirm the smoke-test athlete row contains actual result values.

---

## 5. Recommended deployment / smoke-test order
1. Backup or snapshot production database.
2. Apply migrations in ascending order.
3. Run post-migration SQL verification.
4. Deploy frontend.
5. Run registration -> claim -> result smoke test.
6. Run offline retry visibility smoke test.
7. Run report job + parent portal verification.
8. Verify admin dashboard counts and CSV export.
9. Clean up smoke-test athlete/band only if your operational policy requires cleanup.

---

## 6. Final launch blockers to check manually
- A report generation worker/process must exist if `report_jobs.status` is expected to move beyond `pending`.
- Reserved smoke-test wristbands must not collide with live athlete inventory.
- Staff and admin accounts must be created before event day.
- If the event uses more than one live station device, verify each station emits `device_status` updates.
- If multiple live events are expected, confirm operators understand that some admin counts are global rather than event-scoped.
