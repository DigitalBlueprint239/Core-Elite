# MERGE_STRATEGY.md
## Core Elite × Recruiting — Apex Database Singularity

**Generated:** 2026-04-20  
**Author:** Kevin Jones + Claude (Mission H)  
**Status:** ✅ Stubs resolved — ready for staging validation

---

## 1. Executive Summary

`singularity_merge.sql` merges the Core Elite live-combine database schema into the Recruiting "Apex Database" as a single idempotent transaction. The merge does **not** drop or rename any existing Apex table. It extends, not replaces.

| Table | Apex State | Strategy | Risk |
|---|---|---|---|
| `organizations` | Does not exist | **CREATE** fresh | None |
| `events` | Does not exist | **CREATE** fresh | None |
| `profiles` | EXISTS — structural diff | **ALTER** + trigger | Medium — see §5 |
| `athletes` | EXISTS — recruiting prospects | **ALTER** + add CE cols | Medium — see §4 |
| 13 combine tables | Do not exist | **CREATE** fresh | None |

---

## 2. Pre-Flight Guards

The migration opens with 4 checks that `RAISE EXCEPTION` (aborting the entire transaction) if unsafe conditions are found:

| Check | Condition That Aborts |
|---|---|
| 0.1 | `organizations` exists but lacks `slug` column |
| 0.2 | Advisory only — `athletes` without `event_id` emits NOTICE, proceeds |
| 0.3 | `events` exists but lacks `required_drills` column |
| 0.4 | `register_athlete_secure` exists with ≠ 20 parameters |

Checks 0.1 and 0.3 protect against silent data collisions with Apex's recruiting calendar or org data. Check 0.2 was downgraded from EXCEPTION to NOTICE because the confirmed Apex `athletes` table (recruiting prospects) is safe to extend — it will never have `event_id` set for its existing rows.

---

## 3. Organizations (§2.1)

**Decision: CREATE fresh.**

Apex confirmed no `organizations` table. Core Elite's version is created with:

- `id UUID PK`
- `slug TEXT UNIQUE` — white-label routing key (required by CHECK 0.1 guard)
- `name`, `logo_url`, `primary_color`, `secondary_color`, `contact_email`

A seed row `('Core Elite', 'core-elite')` is inserted on first run via `ON CONFLICT DO NOTHING`.

The `events.organization_id UUID REFERENCES organizations(id)` FK is wired after organizations is confirmed to exist.

---

## 4. Athletes (§2.3) — Key Decisions

**Decision: ALTER TABLE (extend, not replace).**

Apex `athletes` is a recruiting prospects table with 28 columns (height_inches, weight_lbs, graduation_year, gpa, profile_id, etc.). Dropping or renaming it would destroy recruiting data.

### Column Name Alignment

| Apex Column | CE Parameter | Notes |
|---|---|---|
| `height_inches INT` | `p_height_in` | Already exists in Apex — no ALTER needed |
| `weight_lbs INT` | `p_weight_lb` | Already exists in Apex — no ALTER needed |
| `graduation_year INT` | (not in register RPC) | Already exists in Apex — no ALTER needed |
| `high_school TEXT` | `p_high_school` | Same name ✓ |

### Columns Added to Apex athletes

| Column | Type | Purpose |
|---|---|---|
| `event_id` | `UUID REFERENCES events(id)` | CE tenant isolation key. NULL = recruiting prospect |
| `date_of_birth` | `DATE` | Required for CE age gate + duplicate guard |
| `grade` | `TEXT` | Grade level (8th, 9th, etc.) |
| `parent_name` | `TEXT` | Required for CE registration |
| `parent_email` | `TEXT` | Required for CE registration + rate limit |
| `parent_phone` | `TEXT` | Required for CE registration |
| `band_id` | `TEXT → FK bands` | QR wristband assignment |
| `is_core_elite_verified` | `BOOLEAN DEFAULT false` | Combine verification flag |
| `deleted_at` | `TIMESTAMPTZ` | Soft-delete (CE never hard-deletes athletes) |
| `recruiting_profile_id` | `UUID REFERENCES auth.users` | Optional link CE athlete ↔ recruiting user |

### Constraint Design

All new CHECK constraints use `IS NULL OR (...)` to allow existing Apex recruiting rows (which will have NULL for all CE-specific columns) to pass validation. Constraints apply fully to new CE combine athletes where the columns are populated.

```sql
-- Correct for merged table:
CHECK (date_of_birth IS NULL OR (date_of_birth >= '2005-01-01' AND ...))

-- NOT this (would reject all existing Apex rows on next ANALYZE):
CHECK (date_of_birth >= '2005-01-01' AND ...)
```

### Unique Indexes

Both unique indexes on athletes are partial (`WHERE event_id IS NOT NULL`) so they only enforce uniqueness for CE combine athletes, not recruiting prospects:

```sql
CREATE UNIQUE INDEX ce_idx_athletes_event_name_dob_unique
    ON athletes (event_id, lower(first_name), lower(last_name), date_of_birth)
    WHERE event_id IS NOT NULL;
```

---

## 5. Profiles (§2.2) — Critical Structural Difference

**Decision: ALTER TABLE + bidirectional sync trigger.**

### The id vs user_id Problem

| System | How profiles identifies the auth user |
|---|---|
| Core Elite | `profiles.id = auth.uid()` — `id` is the PK AND the auth FK |
| Apex | `profiles.user_id = auth.uid()` — `id` is a separate auto-UUID PK |

This is the **highest-risk difference** in the entire merge. Every Core Elite component that queries profiles must be updated.

### Impact Inventory

| Component | Current CE code | Required change |
|---|---|---|
| All RLS policies | `WHERE id = auth.uid()` | → `WHERE user_id = auth.uid()` ✅ done in migration |
| `handle_new_user` trigger | `INSERT (id, role) VALUES (NEW.id, ...)` | → `INSERT (user_id, role) VALUES (NEW.id, ...)` ✅ done |
| `RouteGuard.tsx` | `supabase.from('profiles').select().eq('id', user.id)` | → `.eq('user_id', user.id)` ⚠️ **app code update required** |
| `AdminDashboard.tsx` | Any profile self-lookup | → use `user_id` column ⚠️ **app code update required** |
| `CoachPortal.tsx` | Any profile self-lookup | → use `user_id` column ⚠️ **app code update required** |

**The migration handles all SQL-layer changes. TypeScript app code must be updated separately before deploying to Apex.**

### full_name ↔ display_name Sync

CE code reads `profiles.full_name`. Apex has `profiles.display_name`. Both columns now exist. A `BEFORE INSERT OR UPDATE` trigger (`trg_sync_profile_display_name`) keeps them in sync bidirectionally:

- CE writes `full_name` → trigger copies to `display_name`
- Recruiting app writes `display_name` → trigger copies to `full_name`
- On INSERT where only one is set → trigger fills in the other

### organization_id vs org_id

| System | Column | Type |
|---|---|---|
| Core Elite | `organization_id` | `UUID REFERENCES organizations(id)` |
| Apex | `org_id` | `TEXT` (free-form string) |

Both columns are preserved. `organization_id UUID` is added to Apex profiles. Existing Apex `org_id TEXT` values are not migrated automatically — they may store string identifiers that don't map 1:1 to the new `organizations` UUID PKs. This migration is intentionally conservative: link profiles to organizations manually after verifying `org_id` values against the seeded organizations table.

### Role System

The Apex `profiles.role` CHECK constraint (if any) is dropped and replaced with a permissive set covering both platforms:

```
'admin', 'staff'             — Core Elite combine roles
'coach', 'scout', 'recruiter' — Recruiting platform roles
'athlete', 'viewer', 'guest'  — Additional Apex roles
```

Add additional Apex roles to `profiles_role_apex_ce_check` if the Apex app uses values not in this list.

---

## 6. RPC Adaptations

### register_athlete_secure v5 — Column Corrections

The only change from `migrations/023_register_athlete_biometrics_rpc.sql` is in the `INSERT INTO athletes` column list:

| Migration 023 (CE DB) | singularity_merge.sql (Apex DB) |
|---|---|
| `height_in,` | `height_inches,` |
| `weight_lb,` | `weight_lbs,` |

Parameter names (`p_height_in`, `p_weight_lb`) are unchanged. The calling code in `Register.tsx` requires no modification.

### submit_result_secure v6 — No Changes

The `results` table uses standard UUID FKs. No column name differences between CE and Apex schemas. Body copied verbatim from migration 019.

---

## 7. What This Migration Does NOT Touch

| Apex Component | Reason Left Alone |
|---|---|
| Stripe billing tables | No overlap with CE schema |
| Recruiting prospect pipeline tables | Domain separation |
| Apex `profiles.org_id TEXT` | Preserved alongside new `organization_id UUID` |
| Apex `athletes` recruiting columns (gpa, profile_id, etc.) | No CE overlap |
| Apex auth configuration | Supabase Auth is shared infrastructure |
| Apex Edge Functions | CE Edge Functions are deployed separately |

---

## 8. Deployment Checklist

### Pre-deployment (staging)
- [ ] Clone Apex Database to a staging environment
- [ ] Run `singularity_merge.sql` against staging
- [ ] Verify pre-flight checks emit only NOTICE (not EXCEPTION) for athletes
- [ ] Verify all 13 CE tables created successfully
- [ ] Verify `athletes` has new CE columns (`event_id`, `date_of_birth`, etc.)
- [ ] Verify `profiles` has `full_name`, `organization_id`, `profiles_role_apex_ce_check`
- [ ] Verify `organizations` table created with seed row
- [ ] Verify trigger `trg_sync_profile_display_name` fires correctly
- [ ] Run a test registration via `register_athlete_secure` RPC — confirm `height_inches`/`weight_lbs` populated
- [ ] Confirm existing Apex `profiles` rows have `full_name` seeded from `display_name`
- [ ] Confirm existing Apex `athletes` rows have `event_id = NULL` (not rejected by constraints)

### App code updates required before production deploy
- [ ] `src/components/RouteGuard.tsx` — change profile lookup from `.eq('id', user.id)` to `.eq('user_id', user.id)`
- [ ] `src/pages/AdminDashboard.tsx` — update any profile self-query to use `user_id`
- [ ] `src/pages/CoachPortal.tsx` — update any profile self-query to use `user_id`
- [ ] Search codebase for `profiles.select` + `.eq('id'` pattern — audit all call sites

### Production deploy
- [ ] Run `singularity_merge.sql` against Apex production DB in a maintenance window
- [ ] Confirm COMMIT with no rollback
- [ ] Deploy updated CE app code pointing to Apex Supabase project URL
- [ ] Smoke test: staff login → RouteGuard → AdminDashboard
- [ ] Smoke test: athlete registration → band claim → result submission
- [ ] Monitor `audit_log` for unexpected errors in first 30 minutes

---

## 9. Rollback Plan

The migration runs inside a single `BEGIN...COMMIT` transaction. If any statement fails:
- The entire transaction rolls back automatically
- No partial state is committed to the Apex DB
- The Apex DB is unchanged from its pre-migration state

If the migration commits successfully but app issues are found post-deploy:
1. Revert app code to the previous build
2. The SQL changes (ALTER TABLE ADD COLUMN) can remain — they are additive and non-breaking for the Recruiting app
3. Drop CE-specific policies with `DROP POLICY IF EXISTS "CE ..." ON <table>` if needed

---

## 10. Future Considerations

| Item | Recommendation |
|---|---|
| `profiles.org_id` migration | After confirming Apex `org_id` values, write a one-time UPDATE to populate `organization_id` UUIDs from the organizations table |
| Athlete deduplication | If the same person appears as both an Apex recruiting prospect and a CE combine athlete, use `recruiting_profile_id` FK on `athletes` to link them |
| PowerSync activation | See `packages/powersync/MIGRATION_PLAN.md` — can be activated after this merge is stable |
| React Native field ops | See `packages/field-ops/README.md` — compatible with merged Apex schema; no additional column changes needed |
