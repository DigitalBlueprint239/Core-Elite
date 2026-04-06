-- =============================================================================
-- MIGRATION 011: Rate Limiting — Registration & Band Claim RPCs
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--   register_athlete_secure  — adds max-5-per-email-per-hour rate limit
--   claim_band_atomic        — verifies expires_at check is present (already is;
--                              this migration documents and enforces it explicitly)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- register_athlete_secure (v2 — adds rate limit)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_athlete_secure(
    p_event_id               UUID,
    p_first_name             TEXT,
    p_last_name              TEXT,
    p_date_of_birth          DATE,
    p_grade                  TEXT,
    p_position               TEXT,
    p_parent_name            TEXT,
    p_parent_email           TEXT,
    p_parent_phone           TEXT,
    p_guardian_relationship  TEXT,
    p_emergency_contact_name TEXT,
    p_emergency_contact_phone TEXT,
    p_signature_data_url     TEXT,
    p_injury_waiver_ack      BOOLEAN,
    p_media_release          BOOLEAN,
    p_data_consent           BOOLEAN,
    p_marketing_consent      BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_athlete_id   UUID;
    v_token        TEXT;
    v_portal_token TEXT;
BEGIN
    -- Validate event exists and is accepting registrations
    IF NOT EXISTS (SELECT 1 FROM events WHERE id = p_event_id AND status IN ('live', 'draft')) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid or inactive event ID');
    END IF;

    -- Rate limit: max 5 registrations per email per hour
    -- Prevents automated abuse and accidental double-submission floods.
    IF (
        SELECT count(*)
        FROM athletes
        WHERE parent_email = lower(trim(p_parent_email))
          AND created_at > now() - interval '1 hour'
    ) >= 5 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error',   'Too many registration attempts. Please try again later.'
        );
    END IF;

    -- Insert athlete
    INSERT INTO athletes (
        event_id, first_name, last_name, date_of_birth, grade, position,
        parent_name, parent_email, parent_phone
    )
    VALUES (
        p_event_id,
        trim(p_first_name),
        trim(p_last_name),
        p_date_of_birth,
        p_grade,
        p_position,
        trim(p_parent_name),
        lower(trim(p_parent_email)),
        trim(p_parent_phone)
    )
    RETURNING id INTO v_athlete_id;

    -- Insert waiver
    INSERT INTO waivers (
        athlete_id, event_id, guardian_name, guardian_relationship,
        emergency_contact_name, emergency_contact_phone, signature_data_url,
        agreed
    )
    VALUES (
        v_athlete_id, p_event_id,
        trim(p_parent_name),
        trim(p_guardian_relationship),
        trim(p_emergency_contact_name),
        trim(p_emergency_contact_phone),
        p_signature_data_url,
        p_injury_waiver_ack
    );

    -- Generate claim token (128-bit hex — infeasible to enumerate)
    v_token := encode(gen_random_bytes(16), 'hex');

    INSERT INTO token_claims (token_hash, event_id, athlete_id, expires_at)
    VALUES (v_token, p_event_id, v_athlete_id, now() + interval '24 hours');

    -- Generate parent portal token
    v_portal_token := encode(gen_random_bytes(16), 'hex');

    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'parent_portals') THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, v_portal_token);
    END IF;

    RETURN jsonb_build_object(
        'success',      true,
        'athlete_id',   v_athlete_id,
        'claim_token',  v_token,
        'portal_token', v_portal_token
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- -----------------------------------------------------------------------------
-- claim_band_atomic (v2 — explicit expiry guard, documented)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_band_atomic(
    p_token        TEXT,
    p_band_id      TEXT,
    p_device_label TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_claim_row RECORD;
    v_band_row  RECORD;
BEGIN
    -- 1. Lock token row — prevents concurrent double-claim on the same token
    SELECT * INTO v_claim_row
    FROM token_claims
    WHERE token_hash = p_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid token');
    END IF;

    -- 2. Already used?
    IF v_claim_row.used_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Token already used');
    END IF;

    -- 3. Expiry check — explicit guard per spec §4 commit 2
    IF v_claim_row.expires_at < now() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Token expired');
    END IF;

    -- 4. Lock band row — prevents two athletes claiming the same band
    SELECT * INTO v_band_row
    FROM bands
    WHERE band_id = p_band_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Band not found');
    END IF;

    IF v_band_row.status != 'available' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Band not available');
    END IF;

    -- 5. Atomic assignments
    UPDATE bands
    SET status      = 'assigned',
        athlete_id  = v_claim_row.athlete_id,
        assigned_at = now()
    WHERE band_id = p_band_id;

    UPDATE athletes
    SET band_id = p_band_id
    WHERE id = v_claim_row.athlete_id;

    UPDATE token_claims
    SET used_at = now()
    WHERE token_hash = p_token;

    RETURN jsonb_build_object(
        'success',        true,
        'athlete_id',     v_claim_row.athlete_id,
        'display_number', v_band_row.display_number
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
