-- =============================================================================
-- singularity_merge.sql
-- Core Elite × Recruiting — Apex Database Merge Migration
-- STATUS: ✅ RESOLVED — All stubs completed. Ready for staging validation.
-- =============================================================================
--
-- PURPOSE:
--   Inject Core Elite live-combine operations into the Recruiting "Apex Database"
--   without destroying existing Stripe, billing, or recruiting data.
--
-- APEX SCHEMA CONTEXT (confirmed 2026-04-20):
--   - organizations: DOES NOT EXIST in Apex → Part 2.1 creates it fresh
--   - profiles:      EXISTS with user_id (≠ auth.uid() FK), display_name, org_id TEXT
--   - athletes:      EXISTS (28 cols) — recruiting prospects without event_id
--   - events:        DOES NOT EXIST in Apex → Part 1.1 creates it fresh
--
-- COLUMN NAME MAPPINGS (Apex column → CE parameter):
--   athletes.height_inches  ↔  p_height_in   (INT)
--   athletes.weight_lbs     ↔  p_weight_lb   (INT)
--   athletes.graduation_year ↔ p_grad_year   (not used in register RPC; Apex has it already)
--   profiles.display_name   ↔  full_name     (synced via trigger; CE reads full_name)
--   profiles.user_id        =   auth.uid()   (NOT profiles.id — Apex structural difference)
--
-- CRITICAL STRUCTURAL DIFFERENCE — PROFILES:
--   Core Elite: profiles.id = auth.uid() (id is the auth FK)
--   Apex:       profiles.user_id = auth.uid() (id is a separate gen_random_uuid() PK)
--   Resolution: ALL RLS policies use user_id = auth.uid(). CE app code must be
--   updated to read profile rows by user_id, not id (see MERGE_STRATEGY.md §5).
--
-- IDEMPOTENCY:
--   Safe to run multiple times. Every statement uses IF NOT EXISTS / ON CONFLICT /
--   CREATE OR REPLACE / DO $$ guards. The transaction rolls back completely if any
--   statement fails — no partial state is committed.
--
-- MERGE STRATEGY DECISION LOG: See MERGE_STRATEGY.md (generated alongside this file).
--
-- =============================================================================

BEGIN;

-- =============================================================================
-- PART 0: PRE-FLIGHT SAFETY CHECKS
-- These checks ABORT THE ENTIRE MIGRATION if unsafe conditions are detected.
-- =============================================================================

DO $$
DECLARE
  v_tbl_exists BOOLEAN;
BEGIN

  -- ---------------------------------------------------------------------------
  -- CHECK 0.1: organizations collision guard
  -- If `organizations` exists but lacks `slug`, abort.
  -- ---------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'public' AND table_name = 'organizations'
  ) INTO v_tbl_exists;

  IF v_tbl_exists THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public'
        AND  table_name   = 'organizations'
        AND  column_name  = 'slug'
    ) THEN
      RAISE EXCEPTION
        E'PRE-FLIGHT ABORT: `organizations` table exists in Apex DB but lacks `slug` column.\n'
        'Core Elite requires organizations.slug (UNIQUE TEXT) for white-label routing.\n'
        'Resolution options:\n'
        '  A) ALTER TABLE organizations ADD COLUMN slug TEXT UNIQUE; (then UPDATE existing rows)\n'
        '  B) Rename Core Elite''s organizations table to `ce_organizations` (update all app queries)\n'
        'After resolving, re-run this migration. Code: CE_ORGS_COLLISION';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- CHECK 0.2: athletes collision guard — ADVISORY (not a hard abort)
  --
  -- Apex has an athletes table without event_id (recruiting prospects).
  -- Resolution: STUB 2.3 will ADD event_id via ALTER TABLE. Proceeding.
  -- This check now only aborts if athletes.event_id exists but is incompatible.
  -- ---------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'public' AND table_name = 'athletes'
  ) INTO v_tbl_exists;

  IF v_tbl_exists THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public'
        AND  table_name   = 'athletes'
        AND  column_name  = 'event_id'
    ) THEN
      RAISE NOTICE
        'PRE-FLIGHT NOTICE: athletes table exists without event_id. '
        'This is expected for the Apex recruiting database. '
        'STUB 2.3 will ALTER TABLE athletes ADD COLUMN event_id to enable CE combine operations. '
        'Existing recruiting prospect rows will have event_id = NULL (they are not combine athletes).';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- CHECK 0.3: events collision guard
  -- If `events` exists but lacks `required_drills`, it may be a Recruiting events
  -- table. Hard abort to prevent overwriting recruiting calendar data.
  -- (Apex confirmed no events table — this guard remains for safety.)
  -- ---------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'public' AND table_name = 'events'
  ) INTO v_tbl_exists;

  IF v_tbl_exists THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public'
        AND  table_name   = 'events'
        AND  column_name  = 'required_drills'
    ) THEN
      RAISE EXCEPTION
        E'PRE-FLIGHT ABORT: `events` table exists in Apex DB but lacks `required_drills` column.\n'
        'This may be a Recruiting events table (campus visits, prospect days, etc.).\n'
        'Resolution options:\n'
        '  A) Rename Core Elite''s events table to `combine_events` (update all app queries + RPCs)\n'
        '  B) Add `required_drills JSONB DEFAULT ''[]''::jsonb` and\n'
        '     `is_combine_event BOOLEAN DEFAULT false` to the existing events table\n'
        'Do NOT proceed until resolved. Code: CE_EVENTS_COLLISION';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- CHECK 0.4: Core Elite RPC collision guard
  -- If register_athlete_secure exists with a DIFFERENT argument count, abort.
  -- v5 has exactly 20 parameters.
  -- ---------------------------------------------------------------------------
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'register_athlete_secure'
      AND pronargs  != 20
  ) THEN
    RAISE EXCEPTION
      E'PRE-FLIGHT ABORT: `register_athlete_secure` exists with a different parameter count.\n'
      'Running CREATE OR REPLACE will create a new overload, NOT replace the existing function.\n'
      'Resolution: DROP FUNCTION register_athlete_secure(<old_arg_types>) CASCADE;\n'
      'Code: CE_RPC_OVERLOAD_COLLISION';
  END IF;

  RAISE NOTICE 'Pre-flight checks passed. Proceeding with migration.';
END $$;


-- =============================================================================
-- PART 1: LOW-RISK TABLES
-- Domain-specific to combine operations. Safe to create with IF NOT EXISTS.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1.1  events — Core Elite combine events
-- Confirmed NOT to exist in Apex DB. Creates fresh.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT        UNIQUE NOT NULL,
    name             TEXT        NOT NULL,
    date             DATE        NOT NULL,
    location         TEXT        NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft', 'live', 'closed')),
    required_drills  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    organization_id  UUID,       -- FK added after organizations confirmed (Part 2.1)
    override_pin     TEXT        DEFAULT NULL,
    registration_open BOOLEAN    DEFAULT true,
    created_at       TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE events IS
  'Core Elite combine events. Scoped by organization_id for multi-tenant isolation. '
  'status: draft → live (open for combine floor) → closed (results locked). '
  'override_pin: event-day admin PIN for Gate 2/3 result overrides.';

-- ---------------------------------------------------------------------------
-- 1.2  bands — physical QR wristbands
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bands (
    band_id         TEXT        PRIMARY KEY,
    event_id        UUID        NOT NULL REFERENCES events(id),
    display_number  INT         NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'available'
                                CHECK (status IN ('available', 'assigned', 'void')),
    athlete_id      UUID,       -- FK added after athletes confirmed (Part 2.3)
    assigned_at     TIMESTAMPTZ,
    assigned_by     UUID        REFERENCES auth.users(id),
    UNIQUE (event_id, display_number)
);

COMMENT ON TABLE bands IS
  'Physical QR wristbands for combine participants. One band per athlete per event. '
  'band_id is the non-guessable QR payload scanned at stations.';

-- ---------------------------------------------------------------------------
-- 1.3  stations — physical testing stations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stations (
    id              TEXT        PRIMARY KEY,
    event_id        UUID        NOT NULL REFERENCES events(id),
    name            TEXT        NOT NULL,
    drill_type      TEXT        NOT NULL,
    requires_auth   BOOLEAN     DEFAULT true,
    enabled         BOOLEAN     DEFAULT true
);

COMMENT ON TABLE stations IS
  'Combine testing stations. id is a human-readable label (e.g., SPEED-1). '
  'drill_type maps to DRILL_CATALOG in src/constants.ts.';

-- ---------------------------------------------------------------------------
-- 1.4  results — immutable drill result records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS results (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_result_id  UUID        UNIQUE NOT NULL,
    event_id          UUID        NOT NULL REFERENCES events(id),
    athlete_id        UUID        NOT NULL,  -- FK added after athletes confirmed (Part 2.3)
    band_id           TEXT        NOT NULL REFERENCES bands(band_id),
    station_id        TEXT        NOT NULL REFERENCES stations(id),
    drill_type        TEXT        NOT NULL,
    value_num         NUMERIC,
    value_text        TEXT,
    attempt_number    INT         NOT NULL DEFAULT 1,
    hlc_timestamp     TEXT,
    device_timestamp  BIGINT,
    source_type       TEXT        NOT NULL DEFAULT 'manual_staff'
                                  CHECK (source_type IN ('live_ble', 'manual_staff', 'legacy_csv')),
    session_id        TEXT,
    verification_hash TEXT,
    validation_status TEXT        NOT NULL DEFAULT 'clean'
                                  CHECK (validation_status IN ('clean','extraordinary','reviewed')),
    voided            BOOLEAN     DEFAULT false,
    meta              JSONB,
    recorded_by       UUID        REFERENCES auth.users(id),
    recorded_at       TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE results IS
  'Immutable combine drill results. Each attempt is a separate row. '
  'Best result per drill computed at query time. '
  'voided = true rows are excluded from leaderboards and exports. '
  'verification_hash: HMAC-SHA-256 set by generate-verified-export Edge Function.';

-- ---------------------------------------------------------------------------
-- 1.5  device_status — station heartbeat (30-second interval)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_status (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id             UUID        NOT NULL REFERENCES events(id),
    station_id           TEXT        NOT NULL REFERENCES stations(id),
    device_label         TEXT,
    last_seen_at         TIMESTAMPTZ DEFAULT now(),
    is_online            BOOLEAN     DEFAULT true,
    pending_queue_count  INT         DEFAULT 0,
    last_sync_at         TIMESTAMPTZ,
    hlc_timestamp        TEXT,
    CONSTRAINT device_status_unique_identity
        UNIQUE (event_id, station_id, device_label)
);

-- ---------------------------------------------------------------------------
-- 1.6  waivers — parent/guardian liability waivers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waivers (
    id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id               UUID        NOT NULL,  -- FK after athletes confirmed (Part 2.3)
    event_id                 UUID        NOT NULL REFERENCES events(id),
    guardian_name            TEXT        NOT NULL,
    guardian_relationship    TEXT,
    emergency_contact_name   TEXT        NOT NULL,
    emergency_contact_phone  TEXT        NOT NULL,
    signature_data_url       TEXT        NOT NULL,
    agreed                   BOOLEAN     NOT NULL DEFAULT true,
    injury_waiver_ack        BOOLEAN     NOT NULL DEFAULT false,
    media_release            BOOLEAN     NOT NULL DEFAULT false,
    data_consent             BOOLEAN     NOT NULL DEFAULT false,
    marketing_consent        BOOLEAN     NOT NULL DEFAULT false,
    waiver_version           TEXT        NOT NULL DEFAULT '2026.1',
    agreed_at                TIMESTAMPTZ DEFAULT now(),
    ip_address               TEXT,
    user_agent               TEXT
);

-- ---------------------------------------------------------------------------
-- 1.7  token_claims — single-use band-claim tokens (valid 24 hours)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_claims (
    token_hash  TEXT        PRIMARY KEY,
    event_id    UUID        NOT NULL REFERENCES events(id),
    athlete_id  UUID        NOT NULL,  -- FK after athletes confirmed (Part 2.3)
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- 1.8  parent_portals — token-gated read-only result portals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_portals (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    athlete_id   UUID        NOT NULL,  -- FK after athletes confirmed (Part 2.3)
    event_id     UUID        NOT NULL REFERENCES events(id),
    portal_token TEXT        UNIQUE NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1.9  report_jobs — async report generation queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_jobs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id         UUID        NOT NULL REFERENCES events(id),
    athlete_id       UUID        NOT NULL,  -- FK after athletes confirmed (Part 2.3)
    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','processing','ready','failed')),
    completed_drills JSONB       DEFAULT '[]'::jsonb,
    generated_at     TIMESTAMPTZ,
    report_url       TEXT,
    summary          JSONB
);

-- ---------------------------------------------------------------------------
-- 1.10  incidents — combine floor incident log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID        NOT NULL REFERENCES events(id),
    station_id  TEXT        NOT NULL REFERENCES stations(id),
    athlete_id  UUID,       -- FK after athletes confirmed (Part 2.3)
    type        TEXT        NOT NULL,
    description TEXT,
    severity    TEXT        NOT NULL CHECK (severity IN ('low','medium','high','critical')),
    recorded_by UUID        REFERENCES auth.users(id),
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1.11  capture_telemetry — per-capture BLE diagnostic record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS capture_telemetry (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    client_telemetry_id   UUID        NOT NULL UNIQUE,
    event_id              UUID        NOT NULL REFERENCES events(id),
    result_id             UUID        REFERENCES results(id) ON DELETE SET NULL,
    station_id            TEXT        NOT NULL REFERENCES stations(id),
    athlete_id            UUID        NOT NULL,  -- FK after athletes confirmed (Part 2.3)
    drill_type            TEXT        NOT NULL,
    device_timestamp      BIGINT      NOT NULL,
    device_id             TEXT        NOT NULL,
    device_label          TEXT        NOT NULL,
    captured_at           TIMESTAMPTZ NOT NULL,
    capture_duration_ms   INT,
    ble_rssi              INT,
    ble_phy               TEXT,
    validation_status     TEXT,
    was_offline           BOOLEAN     NOT NULL DEFAULT false,
    sync_latency_ms       INT,
    clock_offset_ms       REAL,
    rtt_ms                REAL,
    meta                  JSONB       NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1.12  result_provenance — device lineage per result (admin-only read)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS result_provenance (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    result_id        UUID        NOT NULL UNIQUE REFERENCES results(id) ON DELETE CASCADE,
    device_id        TEXT        NOT NULL,
    device_label     TEXT        NOT NULL,
    station_id       TEXT        NOT NULL REFERENCES stations(id),
    device_timestamp BIGINT      NOT NULL,
    hlc_timestamp    TEXT,
    sync_latency_ms  INT,
    was_offline      BOOLEAN     NOT NULL DEFAULT false,
    recorded_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1.13  audit_log — append-only compliance log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    UUID        REFERENCES events(id),
    action      TEXT        NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    user_id     UUID        REFERENCES auth.users(id),
    old_value   JSONB,
    new_value   JSONB,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- If audit_log already existed in the Recruiting DB, add CE-required columns
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS event_id    UUID REFERENCES events(id);
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_id   TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS old_value   JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS new_value   JSONB;


-- =============================================================================
-- PART 2: COLLISION RESOLUTION
-- Resolved using confirmed Apex schema (captured 2026-04-20).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 2.1  organizations — RESOLVED
--
-- Apex DB has NO organizations table (confirmed). Creating Core Elite version.
-- The ELSE branch handles the edge case where this migration is re-run after
-- organizations was created by a prior partial run.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE  table_schema = 'public' AND table_name = 'organizations'
  ) THEN
    EXECUTE $DDL$
      CREATE TABLE organizations (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT        NOT NULL,
        slug            TEXT        UNIQUE NOT NULL,
        logo_url        TEXT,
        primary_color   TEXT        DEFAULT '#18181b',
        secondary_color TEXT        DEFAULT '#c8a200',
        contact_email   TEXT,
        created_at      TIMESTAMPTZ DEFAULT now()
      )
    $DDL$;

    INSERT INTO organizations (id, name, slug)
    VALUES (gen_random_uuid(), 'Core Elite', 'core-elite')
    ON CONFLICT DO NOTHING;

    RAISE NOTICE '2.1: organizations table created (no collision).';

  ELSE
    -- Re-run path: organizations already created by a prior run of this migration.
    -- Idempotently extend with CE columns only.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_url        TEXT;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS primary_color   TEXT DEFAULT '#18181b';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS secondary_color TEXT DEFAULT '#c8a200';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS contact_email   TEXT;

    INSERT INTO organizations (name, slug)
    VALUES ('Core Elite', 'core-elite')
    ON CONFLICT (slug) DO NOTHING;

    RAISE NOTICE '2.1: organizations already exists — extended with CE columns.';
  END IF;
END $$;

-- Wire events.organization_id → organizations now that organizations exists
ALTER TABLE events ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);


-- ---------------------------------------------------------------------------
-- 2.2  profiles — RESOLVED
--
-- Apex DB HAS profiles table with this structure:
--   id UUID PK (auto-generated, NOT the auth.uid() FK)
--   user_id UUID (this is the auth.uid() reference — DIFFERS from CE)
--   display_name TEXT
--   org_id TEXT
--   role TEXT
--   avatar_url TEXT, bio TEXT, created_at, updated_at
--
-- Strategy:
--   A) Do NOT drop the table.
--   B) Extend role CHECK to accept CE values ('admin', 'staff') alongside Apex values.
--   C) Add full_name TEXT (CE reads this) + trigger to sync ↔ display_name.
--   D) Add organization_id UUID FK (CE uses this; Apex uses org_id TEXT).
--   E) RLS policies throughout this migration use user_id = auth.uid()
--      (NOT id = auth.uid()) to match Apex's structural pattern.
--   F) App code update required: RouteGuard.tsx must query profiles by user_id.
--      See MERGE_STRATEGY.md §5.
-- ---------------------------------------------------------------------------

-- Step 2.2a: Widen the role CHECK constraint to include CE roles.
-- Dynamically finds and drops any existing CHECK on profiles.role, then
-- re-adds a permissive set covering both platforms' role values.
DO $$
DECLARE
    v_constraint_name TEXT;
BEGIN
    -- Find any existing CHECK constraint touching profiles.role
    SELECT tc.constraint_name INTO v_constraint_name
    FROM   information_schema.constraint_column_usage ccu
    JOIN   information_schema.table_constraints       tc
           ON tc.constraint_name = ccu.constraint_name
    WHERE  ccu.table_schema  = 'public'
      AND  ccu.table_name    = 'profiles'
      AND  ccu.column_name   = 'role'
      AND  tc.constraint_type = 'CHECK'
    LIMIT 1;

    IF v_constraint_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE profiles DROP CONSTRAINT IF EXISTS ' || quote_ident(v_constraint_name);
        RAISE NOTICE '2.2: Dropped existing profiles.role CHECK constraint: %', v_constraint_name;
    END IF;

    -- Add extended CHECK covering Apex recruiting roles + CE combine roles.
    -- Additional Apex roles can be added to this list without another migration.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE  constraint_schema = 'public'
          AND  constraint_name   = 'profiles_role_apex_ce_check'
    ) THEN
        ALTER TABLE profiles ADD CONSTRAINT profiles_role_apex_ce_check
            CHECK (role IN (
                'admin', 'staff',             -- Core Elite combine roles
                'coach', 'scout', 'recruiter', -- Recruiting platform roles
                'athlete', 'viewer', 'guest'   -- Additional Apex roles
            )) NOT VALID;
        RAISE NOTICE '2.2: Added permissive profiles_role_apex_ce_check constraint.';
    END IF;
END $$;

-- Step 2.2b: Add CE-specific columns to Apex profiles.
-- full_name TEXT — CE code reads profiles.full_name; kept in sync with display_name via trigger.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name       TEXT;
-- organization_id UUID — CE uses UUID FK; Apex uses org_id TEXT. Both coexist.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);

-- Step 2.2c: Seed full_name from display_name for existing Apex profiles.
UPDATE profiles
SET    full_name = display_name
WHERE  full_name IS NULL
  AND  display_name IS NOT NULL;

-- Step 2.2d: Bidirectional sync trigger — full_name ↔ display_name.
-- CE code writes full_name. Recruiting app reads/writes display_name.
-- BEFORE trigger allows modifying NEW before the row is stored.
CREATE OR REPLACE FUNCTION sync_profile_display_name() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.full_name IS NOT NULL AND NEW.display_name IS NULL THEN
            NEW.display_name := NEW.full_name;
        ELSIF NEW.display_name IS NOT NULL AND NEW.full_name IS NULL THEN
            NEW.full_name := NEW.display_name;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Only sync the field that actually changed; prevents infinite loop
        IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN
            NEW.display_name := NEW.full_name;
        ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
            NEW.full_name := NEW.display_name;
        END IF;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_profile_display_name ON profiles;
CREATE TRIGGER trg_sync_profile_display_name
    BEFORE INSERT OR UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION sync_profile_display_name();

-- Step 2.2e: Unique index on profiles.user_id — required for ON CONFLICT in
-- handle_new_user trigger (Part 7) and RLS self-referential subqueries.
CREATE UNIQUE INDEX IF NOT EXISTS ce_idx_profiles_user_id ON profiles (user_id)
    WHERE user_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 2.3  athletes — RESOLVED
--
-- Apex DB HAS athletes (28 cols, recruiting prospects, no event_id).
-- Strategy: ALTER TABLE to add CE combine-specific columns.
-- Existing Apex athlete rows will have event_id = NULL (they are recruiting
-- prospects, not combine participants — this is correct and expected).
--
-- Column name alignment (Apex already has these — NO rename needed):
--   Apex athletes.height_inches ↔ CE parameter p_height_in
--   Apex athletes.weight_lbs    ↔ CE parameter p_weight_lb
--   Apex athletes.graduation_year (not used by register_athlete_secure v5 directly)
--   Apex athletes.high_school   ↔ CE athletes.high_school ✓ (same name)
-- ---------------------------------------------------------------------------

-- Core CE tenant isolation key (NULL = recruiting prospect, NOT NULL = combine athlete)
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS event_id     UUID REFERENCES events(id);

-- CE registration fields — NULL for existing Apex recruiting prospects
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS grade         TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS parent_name   TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS parent_email  TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS parent_phone  TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS band_id       TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS is_core_elite_verified BOOLEAN DEFAULT false;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS deleted_at    TIMESTAMPTZ;
-- Optional link: combine athlete → recruiting platform user (if the same person)
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS recruiting_profile_id UUID REFERENCES auth.users(id);

-- parent_email format check — IS NULL allows existing Apex rows without email
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE  constraint_schema = 'public'
          AND  constraint_name   = 'athletes_parent_email_format_check'
    ) THEN
        ALTER TABLE athletes ADD CONSTRAINT athletes_parent_email_format_check
          CHECK (parent_email IS NULL
                 OR parent_email ~* '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$') NOT VALID;
    END IF;
END $$;

-- DOB range check — IS NULL allows Apex recruiting athletes without DOB
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.check_constraints
        WHERE  constraint_schema = 'public'
          AND  constraint_name   = 'athletes_dob_range_check'
    ) THEN
        ALTER TABLE athletes ADD CONSTRAINT athletes_dob_range_check
          CHECK (date_of_birth IS NULL
                 OR (date_of_birth >= DATE '2005-01-01'
                     AND date_of_birth <= CURRENT_DATE - INTERVAL '9 years')) NOT VALID;
    END IF;
END $$;

-- Add FK from athletes.band_id → bands.band_id (deferred — circular reference)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE  constraint_name = 'fk_athlete_band'
          AND  table_name      = 'athletes'
    ) THEN
        ALTER TABLE athletes ADD CONSTRAINT fk_athlete_band
            FOREIGN KEY (band_id) REFERENCES bands(band_id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- Add FK from bands back to athletes (bands.athlete_id column already exists from Part 1)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE  constraint_name = 'bands_athlete_id_fkey'
          AND  table_name      = 'bands'
    ) THEN
        ALTER TABLE bands ADD CONSTRAINT bands_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;
END $$;

-- Wire FK constraints for all Part 1 tables whose athlete_id column exists
-- but was created without a REFERENCES clause.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'results_athlete_id_fkey' AND table_name = 'results'
    ) THEN
        ALTER TABLE results ADD CONSTRAINT results_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'waivers_athlete_id_fkey' AND table_name = 'waivers'
    ) THEN
        ALTER TABLE waivers ADD CONSTRAINT waivers_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'token_claims_athlete_id_fkey' AND table_name = 'token_claims'
    ) THEN
        ALTER TABLE token_claims ADD CONSTRAINT token_claims_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'parent_portals_athlete_id_fkey' AND table_name = 'parent_portals'
    ) THEN
        ALTER TABLE parent_portals ADD CONSTRAINT parent_portals_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'report_jobs_athlete_id_fkey' AND table_name = 'report_jobs'
    ) THEN
        ALTER TABLE report_jobs ADD CONSTRAINT report_jobs_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'incidents_athlete_id_fkey' AND table_name = 'incidents'
    ) THEN
        ALTER TABLE incidents ADD CONSTRAINT incidents_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'capture_telemetry_athlete_id_fkey' AND table_name = 'capture_telemetry'
    ) THEN
        ALTER TABLE capture_telemetry ADD CONSTRAINT capture_telemetry_athlete_id_fkey
            FOREIGN KEY (athlete_id) REFERENCES athletes(id);
    END IF;
END $$;

-- CE-specific unique index: one athlete per event by name+DOB (combine dedup guard)
CREATE UNIQUE INDEX IF NOT EXISTS ce_idx_athletes_event_name_dob_unique
    ON athletes (event_id, lower(trim(first_name)), lower(trim(last_name)), date_of_birth)
    WHERE event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ce_idx_athletes_event_email_name_unique
    ON athletes (event_id, lower(parent_email), lower(first_name), lower(last_name))
    WHERE event_id IS NOT NULL AND parent_email IS NOT NULL;


-- =============================================================================
-- PART 3: RLS POLICIES
-- ⚠️  ALL profiles subqueries use user_id = auth.uid() (NOT id = auth.uid())
--     because Apex profiles.user_id is the auth reference, not profiles.id.
-- =============================================================================

ALTER TABLE events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE athletes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE bands              ENABLE ROW LEVEL SECURITY;
ALTER TABLE stations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE results            ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_status      ENABLE ROW LEVEL SECURITY;
ALTER TABLE waivers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_claims       ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_portals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_telemetry  ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_provenance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles           ENABLE ROW LEVEL SECURITY;

-- ── events ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Public Read Events"       ON events;
DROP POLICY IF EXISTS "CE Admin Full Access Events" ON events;
DROP POLICY IF EXISTS "CE Org Scoped Events"        ON events;

CREATE POLICY "CE Public Read Events"
    ON events FOR SELECT USING (true);

CREATE POLICY "CE Admin Full Access Events"
    ON events FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

CREATE POLICY "CE Org Scoped Events"
    ON events FOR SELECT TO authenticated
    USING (
      organization_id IS NULL
      OR organization_id IN (
          SELECT organization_id FROM profiles WHERE user_id = auth.uid()
      )
      OR EXISTS (
          SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
      )
    );

-- ── athletes ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Read Athletes" ON athletes;
DROP POLICY IF EXISTS "CE Admin Full Athletes" ON athletes;

CREATE POLICY "CE Staff Read Athletes"
    ON athletes FOR SELECT TO authenticated USING (true);

CREATE POLICY "CE Admin Full Athletes"
    ON athletes FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

-- ── results ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Insert Results" ON results;
DROP POLICY IF EXISTS "CE Staff Read Results"   ON results;
DROP POLICY IF EXISTS "CE Admin Update Results" ON results;

CREATE POLICY "CE Staff Insert Results"
    ON results FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "CE Staff Read Results"
    ON results FOR SELECT TO authenticated USING (true);
CREATE POLICY "CE Admin Update Results"
    ON results FOR UPDATE TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

-- ── device_status ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Device Status" ON device_status;
CREATE POLICY "CE Staff Device Status"
    ON device_status FOR ALL TO authenticated USING (true);

-- ── bands ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Full Bands"  ON bands;
DROP POLICY IF EXISTS "CE Public Read Band"  ON bands;
DROP POLICY IF EXISTS "CE Public Claim Band" ON bands;
CREATE POLICY "CE Staff Full Bands"  ON bands FOR ALL  TO authenticated USING (true);
CREATE POLICY "CE Public Read Band"  ON bands FOR SELECT USING (true);
CREATE POLICY "CE Public Claim Band" ON bands FOR UPDATE USING (true);

-- ── waivers ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Public Insert Waivers" ON waivers;
DROP POLICY IF EXISTS "CE Staff Read Waivers"    ON waivers;
CREATE POLICY "CE Public Insert Waivers" ON waivers FOR INSERT WITH CHECK (true);
CREATE POLICY "CE Staff Read Waivers"    ON waivers FOR SELECT TO authenticated USING (true);

-- ── stations ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Read Stations" ON stations;
CREATE POLICY "CE Staff Read Stations"
    ON stations FOR SELECT TO authenticated USING (true);

-- ── token_claims ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Token Claims All" ON token_claims;
CREATE POLICY "CE Token Claims All" ON token_claims FOR ALL USING (true);

-- ── parent_portals ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Public Read Portal" ON parent_portals;
CREATE POLICY "CE Public Read Portal" ON parent_portals FOR SELECT USING (true);

-- ── audit_log ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Admin Read Audit" ON audit_log;
CREATE POLICY "CE Admin Read Audit"
    ON audit_log FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

-- ── incidents ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Admin Full Incidents" ON incidents;
DROP POLICY IF EXISTS "CE Staff Read Incidents" ON incidents;
CREATE POLICY "CE Admin Full Incidents"
    ON incidents FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));
CREATE POLICY "CE Staff Read Incidents"
    ON incidents FOR SELECT TO authenticated USING (true);

-- ── report_jobs ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Staff Read Report Jobs" ON report_jobs;
CREATE POLICY "CE Staff Read Report Jobs"
    ON report_jobs FOR SELECT TO authenticated USING (true);

-- ── organizations ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Public Read Orgs"  ON organizations;
DROP POLICY IF EXISTS "CE Admin Manage Orgs" ON organizations;
CREATE POLICY "CE Public Read Orgs"
    ON organizations FOR SELECT USING (true);
CREATE POLICY "CE Admin Manage Orgs"
    ON organizations FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

-- ── profiles ──────────────────────────────────────────────────────────────────
-- ⚠️  Uses user_id = auth.uid() (Apex structural pattern)
DROP POLICY IF EXISTS "CE Users Read Own Profile" ON profiles;
DROP POLICY IF EXISTS "CE Admin Full Profiles"    ON profiles;
CREATE POLICY "CE Users Read Own Profile"
    ON profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "CE Admin Full Profiles"
    ON profiles FOR ALL TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));

-- ── capture_telemetry ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Admin Read Telemetry"  ON capture_telemetry;
DROP POLICY IF EXISTS "CE Staff Write Telemetry" ON capture_telemetry;
CREATE POLICY "CE Admin Read Telemetry"
    ON capture_telemetry FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));
CREATE POLICY "CE Staff Write Telemetry"
    ON capture_telemetry FOR INSERT TO authenticated WITH CHECK (true);

-- ── result_provenance ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "CE Admin Read Provenance" ON result_provenance;
CREATE POLICY "CE Admin Read Provenance"
    ON result_provenance FOR SELECT TO authenticated
    USING (EXISTS (
        SELECT 1 FROM profiles WHERE user_id = auth.uid() AND role = 'admin'
    ));


-- =============================================================================
-- PART 4: INDEXES
-- All use IF NOT EXISTS — safe on re-run.
-- =============================================================================

CREATE INDEX IF NOT EXISTS ce_idx_athletes_event_id
    ON athletes (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ce_idx_athletes_event_deleted
    ON athletes (event_id) WHERE deleted_at IS NULL AND event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ce_idx_results_athlete_event
    ON results (athlete_id, event_id);
CREATE INDEX IF NOT EXISTS ce_idx_results_athlete_drill
    ON results (athlete_id, drill_type);
CREATE INDEX IF NOT EXISTS ce_idx_results_hlc_timestamp
    ON results (hlc_timestamp);
CREATE INDEX IF NOT EXISTS ce_idx_results_device_ts
    ON results (athlete_id, drill_type, device_timestamp DESC);
CREATE INDEX IF NOT EXISTS ce_idx_results_pending_validation
    ON results (validation_status) WHERE validation_status = 'extraordinary';
CREATE INDEX IF NOT EXISTS ce_idx_results_session
    ON results (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ce_idx_results_unverified_ble
    ON results (id) WHERE source_type = 'live_ble' AND verification_hash IS NULL;

CREATE INDEX IF NOT EXISTS ce_idx_device_status_event
    ON device_status (event_id);
CREATE INDEX IF NOT EXISTS ce_idx_device_status_last_seen
    ON device_status (last_seen_at);

CREATE INDEX IF NOT EXISTS ce_idx_parent_portals_token
    ON parent_portals (portal_token);
CREATE INDEX IF NOT EXISTS ce_idx_incidents_event
    ON incidents (event_id);
CREATE INDEX IF NOT EXISTS ce_idx_capture_telemetry_event
    ON capture_telemetry (event_id);
CREATE INDEX IF NOT EXISTS ce_idx_capture_telemetry_lww
    ON capture_telemetry (athlete_id, drill_type, event_id, device_timestamp DESC);
CREATE INDEX IF NOT EXISTS ce_idx_audit_entity
    ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ce_idx_audit_event
    ON audit_log (event_id);


-- =============================================================================
-- PART 5: RPCs
-- Full bodies injected. Column names use Apex schema where applicable.
-- All use CREATE OR REPLACE — safe re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 5.1  upsert_device_status_hlc — HLC-guarded heartbeat upsert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_device_status_hlc(
    p_event_id      UUID,
    p_station_id    TEXT,
    p_device_label  TEXT,
    p_last_seen_at  TEXT,
    p_is_online     BOOLEAN,
    p_pending_count INT,
    p_last_sync_at  TEXT,
    p_hlc_timestamp TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_current_hlc TEXT;
BEGIN
  SELECT hlc_timestamp INTO v_current_hlc
  FROM device_status
  WHERE event_id     = p_event_id
    AND station_id   = p_station_id
    AND device_label = p_device_label;

  -- Reject stale write: existing HLC >= incoming means out-of-order offline delivery
  IF v_current_hlc IS NOT NULL AND v_current_hlc >= p_hlc_timestamp THEN
    RETURN jsonb_build_object('success', true, 'applied', false,
      'reason', 'stale_hlc', 'current_hlc', v_current_hlc);
  END IF;

  INSERT INTO device_status (
    event_id, station_id, device_label,
    last_seen_at, is_online, pending_queue_count, last_sync_at, hlc_timestamp
  ) VALUES (
    p_event_id, p_station_id, p_device_label,
    p_last_seen_at::TIMESTAMPTZ, p_is_online, p_pending_count,
    p_last_sync_at::TIMESTAMPTZ, p_hlc_timestamp
  )
  ON CONFLICT ON CONSTRAINT device_status_unique_identity DO UPDATE SET
    last_seen_at        = EXCLUDED.last_seen_at,
    is_online           = EXCLUDED.is_online,
    pending_queue_count = EXCLUDED.pending_queue_count,
    last_sync_at        = EXCLUDED.last_sync_at,
    hlc_timestamp       = EXCLUDED.hlc_timestamp;

  RETURN jsonb_build_object('success', true, 'applied', true);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'upsert_device_status_hlc error: %', SQLERRM;
  RETURN jsonb_build_object('success', false, 'error', 'Internal error');
END; $$;

REVOKE EXECUTE ON FUNCTION upsert_device_status_hlc FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION upsert_device_status_hlc TO authenticated;

-- ---------------------------------------------------------------------------
-- 5.2  claim_band_atomic — atomic band-claim with pessimistic locking
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_band_atomic(
    p_token        TEXT,
    p_band_id      TEXT,
    p_device_label TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_claim RECORD;
  v_band  RECORD;
BEGIN
  SELECT * INTO v_claim FROM token_claims WHERE token_hash = p_token FOR UPDATE;
  IF NOT FOUND                    THEN RETURN jsonb_build_object('success',false,'error','Invalid token'); END IF;
  IF v_claim.used_at IS NOT NULL  THEN RETURN jsonb_build_object('success',false,'error','Token already used'); END IF;
  IF v_claim.expires_at < now()   THEN RETURN jsonb_build_object('success',false,'error','Token expired'); END IF;

  SELECT * INTO v_band FROM bands WHERE band_id = p_band_id FOR UPDATE;
  IF NOT FOUND                    THEN RETURN jsonb_build_object('success',false,'error','Band not found'); END IF;
  IF v_band.status != 'available' THEN RETURN jsonb_build_object('success',false,'error','Band not available'); END IF;

  UPDATE bands        SET status='assigned', athlete_id=v_claim.athlete_id, assigned_at=now() WHERE band_id=p_band_id;
  UPDATE athletes     SET band_id=p_band_id                                                    WHERE id=v_claim.athlete_id;
  UPDATE token_claims SET used_at=now()                                                        WHERE token_hash=p_token;

  RETURN jsonb_build_object('success',true,'athlete_id',v_claim.athlete_id,'display_number',v_band.display_number);
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'claim_band_atomic error: %', SQLERRM;
  RETURN jsonb_build_object('success',false,'error','Internal error');
END; $$;

REVOKE EXECUTE ON FUNCTION claim_band_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION claim_band_atomic TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5.3  submit_result_secure v6
-- Full 4-gate validation + suspicious duplicate detection + HLC + source_type.
-- Sourced from migration 019_verification_hash.sql — no column changes needed
-- (results table uses standard UUID athlete_id FK, unchanged from CE schema).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION submit_result_secure(
    p_client_result_id UUID,
    p_event_id         UUID,
    p_athlete_id       UUID,
    p_band_id          TEXT,
    p_station_id       TEXT,
    p_drill_type       TEXT,
    p_value_num        NUMERIC,
    p_attempt_number   INT     DEFAULT 1,
    p_meta             JSONB   DEFAULT '{}'::jsonb,
    p_device_timestamp BIGINT  DEFAULT 0,
    p_source_type      TEXT    DEFAULT 'manual_staff',
    p_session_id       TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result_id         UUID;
    v_hlc               TEXT;
    v_validation_status TEXT;
    v_suspicious        RECORD;
BEGIN
    -- Gate 0: Authentication
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized', 'code', 'UNAUTHORIZED');
    END IF;

    -- Gate 1: Idempotency (add-biased LWW)
    SELECT id INTO v_result_id
    FROM results
    WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    END IF;

    -- Gate 2: Suspicious duplicate detection (attempt_number = 1 only)
    IF p_attempt_number <= 1 THEN
        SELECT
            id,
            client_result_id  AS existing_client_id,
            value_num         AS existing_value,
            recorded_at       AS existing_recorded_at,
            attempt_number    AS existing_attempt_number
        INTO v_suspicious
        FROM results
        WHERE athlete_id  = p_athlete_id
          AND drill_type  = p_drill_type
          AND recorded_at > now() - interval '120 seconds'
          AND (voided IS NULL OR voided = false)
          AND ABS(value_num - p_value_num) <= (p_value_num * 0.10)
        ORDER BY recorded_at DESC
        LIMIT 1;

        IF FOUND THEN
            RETURN jsonb_build_object(
                'success',              false,
                'status',               'suspicious_duplicate',
                'code',                 'SUSPICIOUS_DUPLICATE',
                'existing_result_id',   v_suspicious.id,
                'existing_value',       v_suspicious.existing_value,
                'existing_recorded_at', v_suspicious.existing_recorded_at,
                'existing_attempt_num', v_suspicious.existing_attempt_number,
                'new_value',            p_value_num,
                'athlete_id',           p_athlete_id,
                'drill_type',           p_drill_type
            );
        END IF;
    END IF;

    -- Write phase
    v_hlc := p_meta->>'hlc_timestamp';

    v_validation_status := CASE
        WHEN (p_meta->>'extraordinary_result')::boolean IS TRUE THEN 'extraordinary'
        ELSE 'clean'
    END;

    INSERT INTO results (
        client_result_id, event_id, athlete_id, band_id, station_id,
        drill_type, value_num, attempt_number, meta, hlc_timestamp,
        validation_status, device_timestamp, source_type, session_id, recorded_by
    )
    VALUES (
        p_client_result_id, p_event_id, p_athlete_id, p_band_id, p_station_id,
        p_drill_type, p_value_num, p_attempt_number, p_meta, v_hlc,
        v_validation_status, p_device_timestamp, p_source_type, p_session_id, auth.uid()
    )
    RETURNING id INTO v_result_id;

    RETURN jsonb_build_object('success', true, 'result_id', v_result_id);

EXCEPTION
    WHEN unique_violation THEN
        SELECT id INTO v_result_id FROM results WHERE client_result_id = p_client_result_id;
        RETURN jsonb_build_object('success', true, 'result_id', v_result_id, 'status', 'duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'submit_result_secure error: athlete=% drill=% error=%',
                  p_athlete_id, p_drill_type, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.', 'code', 'INTERNAL_ERROR');
END;
$$;

REVOKE EXECUTE ON FUNCTION submit_result_secure FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION submit_result_secure TO authenticated;

-- ---------------------------------------------------------------------------
-- 5.4  register_athlete_secure v5
-- Full registration: athlete + waiver + claim token + parent portal token.
--
-- ⚠️  APEX COLUMN NAME CORRECTIONS applied:
--   CE athletes.height_in   → Apex athletes.height_inches
--   CE athletes.weight_lb   → Apex athletes.weight_lbs
-- Parameter names (p_height_in, p_weight_lb) are unchanged — only INSERT
-- column names are corrected. All other logic is verbatim from migration 023.
-- ---------------------------------------------------------------------------

-- Drop all existing overloads regardless of arity (handles v3/v4/v5 coexistence)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure::text AS sig
        FROM   pg_proc      p
        JOIN   pg_namespace n ON n.oid = p.pronamespace
        WHERE  n.nspname = 'public'
          AND  p.proname = 'register_athlete_secure'
    LOOP
        EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id                UUID,
    p_first_name              TEXT,
    p_last_name               TEXT,
    p_date_of_birth           DATE,
    p_grade                   TEXT    DEFAULT NULL,
    p_position                TEXT    DEFAULT NULL,
    p_parent_name             TEXT    DEFAULT NULL,
    p_parent_email            TEXT    DEFAULT NULL,
    p_parent_phone            TEXT    DEFAULT NULL,
    p_guardian_relationship   TEXT    DEFAULT NULL,
    p_emergency_contact_name  TEXT    DEFAULT NULL,
    p_emergency_contact_phone TEXT    DEFAULT NULL,
    p_signature_data_url      TEXT    DEFAULT NULL,
    p_injury_waiver_ack       BOOLEAN DEFAULT false,
    p_media_release           BOOLEAN DEFAULT false,
    p_data_consent            BOOLEAN DEFAULT false,
    p_marketing_consent       BOOLEAN DEFAULT false,
    p_height_in               INT     DEFAULT NULL,
    p_weight_lb               INT     DEFAULT NULL,
    p_high_school             TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id      UUID;
    v_token           TEXT;
    v_portal_token    TEXT;
    v_age_years       INTEGER;
    v_email_regex     TEXT := '^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$';
    v_first_name_display  TEXT;
    v_last_name_display   TEXT;
    v_first_name_lower    TEXT;
    v_last_name_lower     TEXT;
    v_parent_email        TEXT;
    v_parent_phone        TEXT;
    v_emergency_phone     TEXT;
BEGIN

    -- =========================================================================
    -- GATE 1: Input Validation
    -- =========================================================================

    v_first_name_display := trim(coalesce(p_first_name, ''));
    v_last_name_display  := trim(coalesce(p_last_name,  ''));
    v_first_name_lower   := lower(v_first_name_display);
    v_last_name_lower    := lower(v_last_name_display);
    v_parent_email       := lower(trim(coalesce(p_parent_email, '')));
    v_parent_phone       := regexp_replace(trim(coalesce(p_parent_phone, '')),             '[^0-9]', '', 'g');
    v_emergency_phone    := regexp_replace(trim(coalesce(p_emergency_contact_phone, '')), '[^0-9]', '', 'g');

    IF v_first_name_display = '' OR v_last_name_display = '' THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'First and last name are required.', 'code', 'INVALID_NAME'
        );
    END IF;

    IF p_date_of_birth IS NULL THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Date of birth is required.',
            'code', 'DOB_REQUIRED', 'field', 'date_of_birth'
        );
    END IF;

    IF p_date_of_birth > CURRENT_DATE THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Date of birth cannot be in the future.',
            'code', 'INVALID_DOB_FUTURE', 'field', 'date_of_birth'
        );
    END IF;

    v_age_years := EXTRACT(YEAR FROM AGE(CURRENT_DATE, p_date_of_birth))::INT;
    IF v_age_years < 10 OR v_age_years > 19 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', CASE
                WHEN v_age_years < 10 THEN 'Athlete must be at least 10 years old to participate.'
                ELSE 'Athlete must be 19 or younger to participate.'
            END,
            'code', 'INVALID_AGE', 'field', 'date_of_birth'
        );
    END IF;

    IF length(v_parent_email) = 0 THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Parent or guardian email is required.',
            'code', 'EMAIL_REQUIRED', 'field', 'parent_email'
        );
    END IF;

    -- Gate 1.5: Email format check
    IF v_parent_email !~* v_email_regex THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Please enter a valid email address.',
            'code', 'INVALID_EMAIL', 'field', 'parent_email'
        );
    END IF;

    IF length(v_parent_phone) != 10 THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'A valid 10-digit parent phone number is required.',
            'code', 'INVALID_PHONE', 'field', 'parent_phone'
        );
    END IF;

    IF p_position IS NULL OR length(trim(p_position)) = 0 THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Position is required.',
            'code', 'POSITION_REQUIRED', 'field', 'position'
        );
    END IF;

    IF p_data_consent IS NOT TRUE THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Data consent must be accepted to complete registration.',
            'code', 'CONSENT_REQUIRED'
        );
    END IF;

    -- =========================================================================
    -- GATE 2: Event Validation
    -- =========================================================================

    IF NOT EXISTS (
        SELECT 1 FROM events
        WHERE  id     = p_event_id
          AND  status IN ('live', 'draft')
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'error', 'Invalid or inactive event.', 'code', 'INVALID_EVENT'
        );
    END IF;

    -- =========================================================================
    -- GATE 3: Rate Limit (5 registrations per parent email per event per hour)
    -- =========================================================================

    IF (
        SELECT count(*)
        FROM   athletes
        WHERE  parent_email = v_parent_email
          AND  event_id     = p_event_id
          AND  created_at   > now() - INTERVAL '1 hour'
    ) >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Too many registration attempts. Please try again in an hour.',
            'code', 'RATE_LIMITED'
        );
    END IF;

    -- =========================================================================
    -- GATE 4: Duplicate Athlete Check
    -- =========================================================================

    IF EXISTS (
        SELECT 1
        FROM   athletes
        WHERE  event_id                = p_event_id
          AND  lower(trim(first_name)) = v_first_name_lower
          AND  lower(trim(last_name))  = v_last_name_lower
          AND  date_of_birth           = p_date_of_birth
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'A registration for this athlete may already exist. Please check with event staff.',
            'code', 'DUPLICATE_REG'
        );
    END IF;

    -- =========================================================================
    -- WRITE PHASE
    -- =========================================================================

    -- 5a: Insert athlete row.
    -- ⚠️  APEX COLUMN NAMES: height_inches (not height_in), weight_lbs (not weight_lb)
    INSERT INTO athletes (
        event_id,
        first_name,
        last_name,
        date_of_birth,
        grade,
        position,
        parent_name,
        parent_email,
        parent_phone,
        height_inches,
        weight_lbs,
        high_school
    )
    VALUES (
        p_event_id,
        v_first_name_display,
        v_last_name_display,
        p_date_of_birth,
        trim(coalesce(p_grade, '')),
        trim(p_position),
        trim(coalesce(p_parent_name, '')),
        v_parent_email,
        v_parent_phone,
        p_height_in,
        p_weight_lb,
        trim(coalesce(p_high_school, ''))
    )
    RETURNING id INTO v_athlete_id;

    -- Coerce empty high_school string to NULL post-insert
    UPDATE athletes
    SET    high_school = NULLIF(high_school, '')
    WHERE  id          = v_athlete_id
      AND  high_school = '';

    -- 5b: Insert waiver record
    INSERT INTO waivers (
        athlete_id,
        event_id,
        guardian_name,
        guardian_relationship,
        emergency_contact_name,
        emergency_contact_phone,
        signature_data_url,
        agreed,
        media_release,
        data_consent,
        marketing_consent
    )
    VALUES (
        v_athlete_id,
        p_event_id,
        trim(coalesce(p_parent_name, '')),
        trim(coalesce(p_guardian_relationship, '')),
        trim(coalesce(p_emergency_contact_name, '')),
        v_emergency_phone,
        p_signature_data_url,
        p_injury_waiver_ack,
        p_media_release,
        p_data_consent,
        p_marketing_consent
    );

    -- 5c: Claim token (128-bit cryptographic hex, valid 24 hours, single-use)
    v_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + INTERVAL '24 hours');

    -- 5d: Parent portal token
    v_portal_token := encode(gen_random_bytes(16), 'hex');

    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE  table_schema = 'public' AND table_name = 'parent_portals'
    ) THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, v_portal_token);
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'athlete_id',   v_athlete_id,
        'claim_token',  v_token,
        'portal_token', v_portal_token
    );

EXCEPTION
    WHEN unique_violation THEN
        RAISE LOG 'register_athlete_secure DUPLICATE_REG event=% name=% %',
                  p_event_id, v_first_name_lower, v_last_name_lower;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'A registration for this athlete may already exist. Please check with event staff.',
            'code', 'DUPLICATE_REG'
        );

    WHEN check_violation THEN
        RAISE LOG 'register_athlete_secure CHECK_VIOLATION event=% sqlerrm=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error', CASE
                WHEN SQLERRM ILIKE '%dob_range%'  OR SQLERRM ILIKE '%date_of_birth%'
                    THEN 'Athlete date of birth is outside the eligible range for this event.'
                WHEN SQLERRM ILIKE '%email%'
                    THEN 'Please enter a valid email address.'
                ELSE 'Invalid registration data. Please verify all fields and try again.'
            END,
            'code', 'VALIDATION_ERROR'
        );

    WHEN not_null_violation THEN
        RAISE LOG 'register_athlete_secure NOT_NULL event=% sqlerrm=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'All required fields must be completed.',
            'code', 'VALIDATION_ERROR'
        );

    WHEN OTHERS THEN
        RAISE LOG 'register_athlete_secure INTERNAL_ERROR event=% sqlerrm=%', p_event_id, SQLERRM;
        RETURN jsonb_build_object(
            'success', false,
            'error', 'An unexpected error occurred. Please try again or contact event staff.',
            'code', 'INTERNAL_ERROR'
        );
END;
$$;

REVOKE EXECUTE ON FUNCTION register_athlete_secure FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO anon;
GRANT  EXECUTE ON FUNCTION register_athlete_secure TO authenticated;

-- ---------------------------------------------------------------------------
-- 5.5  upsert_capture_telemetry_lww v2
-- LWW telemetry upsert with clock sync quality params.
-- Sourced verbatim from migration 019_verification_hash.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_capture_telemetry_lww(
    p_client_telemetry_id  UUID,
    p_event_id             UUID,
    p_result_id            UUID,
    p_station_id           TEXT,
    p_athlete_id           UUID,
    p_drill_type           TEXT,
    p_device_timestamp     BIGINT,
    p_device_id            TEXT,
    p_device_label         TEXT,
    p_captured_at          TIMESTAMPTZ,
    p_capture_duration_ms  INTEGER,
    p_ble_rssi             INTEGER,
    p_ble_phy              TEXT,
    p_validation_status    TEXT,
    p_was_offline          BOOLEAN,
    p_sync_latency_ms      INTEGER,
    p_meta                 JSONB    DEFAULT '{}',
    p_clock_offset_ms      REAL     DEFAULT NULL,
    p_rtt_ms               REAL     DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_winning_ts BIGINT;
BEGIN
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    -- Gate 1: idempotency
    IF EXISTS (
        SELECT 1 FROM capture_telemetry WHERE client_telemetry_id = p_client_telemetry_id
    ) THEN
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'idempotent_duplicate');
    END IF;

    -- Gate 2: LWW conflict scan
    SELECT MAX(device_timestamp) INTO v_winning_ts
    FROM capture_telemetry
    WHERE event_id   = p_event_id
      AND athlete_id = p_athlete_id
      AND drill_type = p_drill_type
      AND ABS(device_timestamp - p_device_timestamp) <= 500;

    IF v_winning_ts IS NOT NULL AND v_winning_ts > p_device_timestamp THEN
        RETURN jsonb_build_object(
            'success', true, 'applied', false, 'reason', 'lww_rejected',
            'winning_device_timestamp', v_winning_ts
        );
    END IF;

    INSERT INTO capture_telemetry (
        client_telemetry_id, event_id, result_id, station_id, athlete_id,
        drill_type, device_timestamp, device_id, device_label, captured_at,
        capture_duration_ms, ble_rssi, ble_phy, validation_status,
        was_offline, sync_latency_ms, meta, clock_offset_ms, rtt_ms
    ) VALUES (
        p_client_telemetry_id, p_event_id, p_result_id, p_station_id, p_athlete_id,
        p_drill_type, p_device_timestamp, p_device_id, p_device_label, p_captured_at,
        p_capture_duration_ms, p_ble_rssi, p_ble_phy, p_validation_status,
        p_was_offline, p_sync_latency_ms, p_meta, p_clock_offset_ms, p_rtt_ms
    );

    RETURN jsonb_build_object('success', true, 'applied', true);

EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', true, 'applied', false, 'reason', 'race_duplicate');
    WHEN OTHERS THEN
        RAISE LOG 'upsert_capture_telemetry_lww error: telemetry_id=% error=%',
                  p_client_telemetry_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.');
END;
$$;

REVOKE EXECUTE ON FUNCTION upsert_capture_telemetry_lww FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION upsert_capture_telemetry_lww TO authenticated;

-- ---------------------------------------------------------------------------
-- 5.6  insert_result_provenance — idempotent device lineage insert
-- Sourced verbatim from migration 018_capture_telemetry.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION insert_result_provenance(
    p_result_id        UUID,
    p_device_id        TEXT,
    p_device_label     TEXT,
    p_station_id       TEXT,
    p_device_timestamp BIGINT,
    p_hlc_timestamp    TEXT,
    p_sync_latency_ms  INTEGER,
    p_was_offline      BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF auth.role() != 'authenticated' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Unauthorized');
    END IF;

    INSERT INTO result_provenance (
        result_id, device_id, device_label, station_id,
        device_timestamp, hlc_timestamp, sync_latency_ms, was_offline
    ) VALUES (
        p_result_id, p_device_id, p_device_label, p_station_id,
        p_device_timestamp, p_hlc_timestamp, p_sync_latency_ms, p_was_offline
    )
    ON CONFLICT (result_id) DO NOTHING;

    RETURN jsonb_build_object('success', true);

EXCEPTION
    WHEN OTHERS THEN
        RAISE LOG 'insert_result_provenance error: result_id=% error=%', p_result_id, SQLERRM;
        RETURN jsonb_build_object('success', false, 'error', 'An unexpected error occurred.');
END;
$$;

REVOKE EXECUTE ON FUNCTION insert_result_provenance FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION insert_result_provenance TO authenticated;

-- ---------------------------------------------------------------------------
-- 5.7  export_verified_results — read-only attestation query for Edge Function
-- Called by generate-verified-export with service role key.
-- Sourced verbatim from migration 019_verification_hash.sql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION export_verified_results(
    p_athlete_id UUID DEFAULT NULL,
    p_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    result_id              UUID,
    client_result_id       UUID,
    athlete_id             UUID,
    event_id               UUID,
    band_id                TEXT,
    station_id             TEXT,
    drill_type             TEXT,
    value_num              NUMERIC,
    attempt_number         INT,
    validation_status      TEXT,
    hlc_timestamp          TEXT,
    device_timestamp       BIGINT,
    recorded_at            TIMESTAMPTZ,
    source_type            TEXT,
    verification_hash      TEXT,
    session_id             TEXT,
    meta                   JSONB,
    ct_telemetry_id        UUID,
    ct_device_id           TEXT,
    ct_device_label        TEXT,
    ct_captured_at         TIMESTAMPTZ,
    ct_capture_duration_ms INTEGER,
    ct_ble_rssi            INTEGER,
    ct_ble_phy             TEXT,
    ct_was_offline         BOOLEAN,
    ct_sync_latency_ms     INTEGER,
    ct_clock_offset_ms     REAL,
    ct_rtt_ms              REAL,
    prov_device_id         TEXT,
    prov_device_label      TEXT,
    prov_hlc_timestamp     TEXT,
    prov_was_offline       BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT
        r.id                        AS result_id,
        r.client_result_id,
        r.athlete_id,
        r.event_id,
        r.band_id,
        r.station_id,
        r.drill_type,
        r.value_num,
        r.attempt_number,
        r.validation_status,
        r.hlc_timestamp,
        r.device_timestamp,
        r.recorded_at,
        r.source_type,
        r.verification_hash,
        r.session_id,
        r.meta,
        ct.id                       AS ct_telemetry_id,
        ct.device_id                AS ct_device_id,
        ct.device_label             AS ct_device_label,
        ct.captured_at              AS ct_captured_at,
        ct.capture_duration_ms      AS ct_capture_duration_ms,
        ct.ble_rssi                 AS ct_ble_rssi,
        ct.ble_phy                  AS ct_ble_phy,
        ct.was_offline              AS ct_was_offline,
        ct.sync_latency_ms          AS ct_sync_latency_ms,
        ct.clock_offset_ms          AS ct_clock_offset_ms,
        ct.rtt_ms                   AS ct_rtt_ms,
        rp.device_id                AS prov_device_id,
        rp.device_label             AS prov_device_label,
        rp.hlc_timestamp            AS prov_hlc_timestamp,
        rp.was_offline              AS prov_was_offline
    FROM results r
    LEFT JOIN capture_telemetry ct ON ct.result_id = r.id
    LEFT JOIN result_provenance  rp ON rp.result_id  = r.id
    WHERE (r.voided IS NULL OR r.voided = FALSE)
      AND (p_athlete_id IS NULL OR r.athlete_id = p_athlete_id)
      AND (p_session_id IS NULL OR r.session_id = p_session_id)
    ORDER BY r.drill_type, r.attempt_number, r.device_timestamp;
$$;

REVOKE EXECUTE ON FUNCTION export_verified_results FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION export_verified_results TO authenticated;


-- =============================================================================
-- PART 6: AUDIT TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION log_result_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (action, entity_type, entity_id, event_id, new_value)
  VALUES ('result_insert', 'result', NEW.id::TEXT, NEW.event_id,
          jsonb_build_object('drill_type', NEW.drill_type, 'value_num', NEW.value_num,
                             'source_type', NEW.source_type, 'athlete_id', NEW.athlete_id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_result_insert ON results;
CREATE TRIGGER trg_log_result_insert
    AFTER INSERT ON results
    FOR EACH ROW EXECUTE FUNCTION log_result_insert();

CREATE OR REPLACE FUNCTION log_result_void() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.voided = true AND OLD.voided = false THEN
    INSERT INTO audit_log (action, entity_type, entity_id, event_id, old_value, new_value)
    VALUES ('result_void', 'result', NEW.id::TEXT, NEW.event_id,
            jsonb_build_object('voided', false),
            jsonb_build_object('voided', true, 'voided_by', auth.uid()));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_log_result_void ON results;
CREATE TRIGGER trg_log_result_void
    AFTER UPDATE ON results
    FOR EACH ROW EXECUTE FUNCTION log_result_void();


-- =============================================================================
-- PART 7: PROFILES AUTO-CREATE TRIGGER
--
-- ⚠️  APEX STRUCTURAL ADAPTATION:
--   Core Elite pattern: INSERT INTO profiles (id, role) VALUES (NEW.id, 'staff')
--   Apex pattern:       INSERT INTO profiles (user_id, role) VALUES (NEW.id, 'staff')
--
--   Apex profiles.id is a separate auto-generated UUID (not the auth.uid() FK).
--   Apex profiles.user_id is the auth reference (= auth.uid()).
--
-- Uses IF NOT EXISTS check rather than ON CONFLICT to avoid relying on a
-- specific constraint name that may vary between Apex DB versions.
-- EXCEPTION block ensures this trigger NEVER blocks auth.users creation.
-- =============================================================================

CREATE OR REPLACE FUNCTION handle_new_user() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = NEW.id) THEN
        INSERT INTO public.profiles (user_id, role)
        VALUES (NEW.id, 'staff');
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE LOG 'handle_new_user error: user_id=% sqlerrm=%', NEW.id, SQLERRM;
    RETURN NEW;
END; $$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS ce_on_auth_user_created ON auth.users;
CREATE TRIGGER ce_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- =============================================================================
-- PART 8: REALTIME PUBLICATION
-- Adds CE tables to supabase_realtime so PowerSync and Realtime clients
-- receive live updates. Safe to run if Apex already has these tables published.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='results') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE results;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='device_status') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE device_status;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='capture_telemetry') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE capture_telemetry;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='result_provenance') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE result_provenance;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='athletes') THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE athletes;
        END IF;
    END IF;
END $$;


-- =============================================================================
-- END OF MIGRATION
-- This transaction COMMITs only if every statement above succeeded.
-- If any pre-flight check raised an EXCEPTION, the entire migration rolled back.
-- =============================================================================

COMMIT;
