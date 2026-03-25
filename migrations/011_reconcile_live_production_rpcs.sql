-- Migration: 011_reconcile_live_production_rpcs.sql
-- Description: Corrective migration to align RPC implementations with production-safe runtime behavior validated on 2026-03-24.
-- Note: This migration intentionally does not rewrite historical migrations 007/008/009.

DROP FUNCTION IF EXISTS claim_band_atomic(TEXT, TEXT);

CREATE OR REPLACE FUNCTION claim_band_atomic(
    p_token TEXT,
    p_band_id TEXT
)
RETURNS TABLE (
    band_id TEXT,
    athlete_id UUID,
    claimed_at TIMESTAMPTZ,
    status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_now TIMESTAMPTZ := now();
    v_claim token_claims%ROWTYPE;
    v_band bands%ROWTYPE;
BEGIN
    IF COALESCE(trim(p_token), '') = '' THEN
        RAISE EXCEPTION 'Claim token is required';
    END IF;

    IF COALESCE(trim(p_band_id), '') = '' THEN
        RAISE EXCEPTION 'Band ID is required';
    END IF;

    SELECT *
      INTO v_claim
      FROM token_claims tc
     WHERE tc.token = p_token
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Claim session not found';
    END IF;

    IF COALESCE(v_claim.used, FALSE) OR v_claim.used_at IS NOT NULL THEN
        RAISE EXCEPTION 'This wristband has already been claimed';
    END IF;

    IF v_claim.expires_at IS NULL OR v_claim.expires_at < v_now THEN
        RAISE EXCEPTION 'Claim session has expired';
    END IF;

    SELECT *
      INTO v_band
      FROM bands b
     WHERE b.band_id = p_band_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid wristband ID';
    END IF;

    IF v_band.status <> 'available' THEN
        RAISE EXCEPTION 'This wristband is already claimed or voided';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM athletes a
         WHERE a.id = v_claim.athlete_id
           AND a.band_id IS NOT NULL
           AND a.band_id <> p_band_id
    ) THEN
        RAISE EXCEPTION 'Athlete already has a wristband';
    END IF;

    UPDATE bands
       SET status = 'claimed',
           athlete_id = v_claim.athlete_id,
           claimed_at = v_now
     WHERE bands.band_id = p_band_id;

    UPDATE athletes
       SET band_id = p_band_id,
           updated_at = v_now
     WHERE athletes.id = v_claim.athlete_id;

    UPDATE token_claims
       SET used = TRUE,
           used_at = v_now,
           band_id = p_band_id
     WHERE token_claims.token = p_token;

    RETURN QUERY
    SELECT b.band_id, b.athlete_id, b.claimed_at, b.status
      FROM bands b
     WHERE b.band_id = p_band_id;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_band_atomic(TEXT, TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS register_athlete_atomic(UUID, JSONB, JSONB, TEXT, TIMESTAMPTZ, TEXT);

CREATE OR REPLACE FUNCTION register_athlete_atomic(
    p_event_id UUID,
    p_athlete JSONB,
    p_waiver JSONB,
    p_claim_token TEXT,
    p_claim_expires_at TIMESTAMPTZ,
    p_portal_token TEXT DEFAULT NULL
)
RETURNS TABLE (
    athlete_id UUID,
    claim_token TEXT,
    portal_token TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_athlete_id UUID;
    v_parent_portals_exists BOOLEAN;
BEGIN
    IF p_event_id IS NULL THEN
        RAISE EXCEPTION 'Event is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'first_name'), '') = '' THEN
        RAISE EXCEPTION 'Athlete first name is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'last_name'), '') = '' THEN
        RAISE EXCEPTION 'Athlete last name is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'date_of_birth'), '') = '' THEN
        RAISE EXCEPTION 'Athlete date of birth is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'parent_name'), '') = '' THEN
        RAISE EXCEPTION 'Parent name is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'parent_email'), '') = '' THEN
        RAISE EXCEPTION 'Parent email is required';
    END IF;

    IF COALESCE(trim(p_athlete->>'parent_phone'), '') = '' THEN
        RAISE EXCEPTION 'Parent phone is required';
    END IF;

    IF COALESCE(trim(p_waiver->>'guardian_name'), '') = '' THEN
        RAISE EXCEPTION 'Guardian name is required';
    END IF;

    IF COALESCE(trim(p_waiver->>'emergency_contact_name'), '') = '' THEN
        RAISE EXCEPTION 'Emergency contact name is required';
    END IF;

    IF COALESCE(trim(p_waiver->>'emergency_contact_phone'), '') = '' THEN
        RAISE EXCEPTION 'Emergency contact phone is required';
    END IF;

    IF COALESCE(trim(p_waiver->>'signature_data_url'), '') = '' THEN
        RAISE EXCEPTION 'Waiver signature is required';
    END IF;

    IF COALESCE((p_waiver->>'injury_waiver_ack')::BOOLEAN, FALSE) = FALSE THEN
        RAISE EXCEPTION 'Injury waiver acknowledgement is required';
    END IF;

    IF COALESCE((p_waiver->>'media_release')::BOOLEAN, FALSE) = FALSE THEN
        RAISE EXCEPTION 'Media release consent is required';
    END IF;

    IF COALESCE((p_waiver->>'data_consent')::BOOLEAN, FALSE) = FALSE THEN
        RAISE EXCEPTION 'Data consent is required';
    END IF;

    IF COALESCE(trim(p_claim_token), '') = '' THEN
        RAISE EXCEPTION 'Claim token is required';
    END IF;

    IF p_claim_expires_at IS NULL OR p_claim_expires_at <= now() THEN
        RAISE EXCEPTION 'Claim token expiration must be in the future';
    END IF;

    INSERT INTO athletes (
        event_id,
        first_name,
        last_name,
        email,
        phone,
        age_group,
        position,
        registration_token
    )
    VALUES (
        p_event_id,
        trim(p_athlete->>'first_name'),
        trim(p_athlete->>'last_name'),
        NULLIF(trim(p_athlete->>'parent_email'), ''),
        NULLIF(trim(p_athlete->>'parent_phone'), ''),
        NULLIF(trim(p_athlete->>'age_group'), ''),
        NULLIF(trim(p_athlete->>'position'), ''),
        p_claim_token
    )
    RETURNING id INTO v_athlete_id;

    INSERT INTO waivers (
        athlete_id,
        event_id,
        signed_by,
        signature_data,
        consented,
        signed_at,
        ip_address,
        media_release,
        data_consent,
        marketing_consent,
        guardian_relationship,
        waiver_version,
        injury_waiver_ack
    )
    VALUES (
        v_athlete_id,
        p_event_id,
        trim(p_waiver->>'guardian_name'),
        trim(p_waiver->>'signature_data_url'),
        TRUE,
        now(),
        NULLIF(trim(p_waiver->>'ip_address'), ''),
        COALESCE((p_waiver->>'media_release')::BOOLEAN, FALSE),
        COALESCE((p_waiver->>'data_consent')::BOOLEAN, FALSE),
        COALESCE((p_waiver->>'marketing_consent')::BOOLEAN, FALSE),
        NULLIF(trim(p_waiver->>'guardian_relationship'), ''),
        COALESCE(NULLIF(trim(p_waiver->>'waiver_version'), ''), '2026.1'),
        COALESCE((p_waiver->>'injury_waiver_ack')::BOOLEAN, FALSE)
    );

    INSERT INTO token_claims (
        token,
        athlete_id,
        expires_at,
        used
    )
    VALUES (
        p_claim_token,
        v_athlete_id,
        p_claim_expires_at,
        FALSE
    );

    SELECT EXISTS (
        SELECT 1
          FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'parent_portals'
    )
      INTO v_parent_portals_exists;

    IF v_parent_portals_exists AND COALESCE(trim(p_portal_token), '') <> '' THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, p_portal_token);
    END IF;

    RETURN QUERY
    SELECT v_athlete_id, p_claim_token, p_portal_token;
END;
$$;

GRANT EXECUTE ON FUNCTION register_athlete_atomic(UUID, JSONB, JSONB, TEXT, TIMESTAMPTZ, TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS submit_result_atomic(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION submit_result_atomic(
    p_client_result_id UUID,
    p_event_id UUID,
    p_athlete_id UUID,
    p_band_id TEXT,
    p_station_id TEXT,
    p_drill_type TEXT,
    p_value_num NUMERIC,
    p_meta JSONB DEFAULT '{}'::jsonb,
    p_recorded_at TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
    result_id UUID,
    client_result_id UUID,
    inserted BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_result_id UUID;
    v_client_result_id_text TEXT := p_client_result_id::TEXT;
    v_station stations%ROWTYPE;
    v_band bands%ROWTYPE;
    v_athlete athletes%ROWTYPE;
    v_event_slug TEXT;
BEGIN
    IF p_client_result_id IS NULL THEN
        RAISE EXCEPTION 'client_result_id is required';
    END IF;

    IF p_event_id IS NULL OR p_athlete_id IS NULL OR COALESCE(trim(p_band_id), '') = '' OR COALESCE(trim(p_station_id), '') = '' THEN
        RAISE EXCEPTION 'event, athlete, band, and station are required';
    END IF;

    IF COALESCE(trim(p_drill_type), '') = '' THEN
        RAISE EXCEPTION 'drill_type is required';
    END IF;

    IF p_value_num IS NULL THEN
        RAISE EXCEPTION 'value_num is required';
    END IF;

    SELECT r.id
      INTO v_result_id
      FROM results r
     WHERE r.client_result_id = v_client_result_id_text;

    IF FOUND THEN
        RETURN QUERY SELECT v_result_id, p_client_result_id, FALSE;
        RETURN;
    END IF;

    SELECT *
      INTO v_station
      FROM stations s
     WHERE s.id = p_station_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Station not found';
    END IF;

    IF v_station.event_id <> p_event_id THEN
        RAISE EXCEPTION 'Station does not belong to this event';
    END IF;

    IF v_station.drill_type <> p_drill_type THEN
        RAISE EXCEPTION 'Drill type does not match station';
    END IF;

    SELECT *
      INTO v_athlete
      FROM athletes a
     WHERE a.id = p_athlete_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Athlete not found';
    END IF;

    IF v_athlete.event_id <> p_event_id THEN
        RAISE EXCEPTION 'Athlete does not belong to this event';
    END IF;

    IF v_athlete.band_id IS DISTINCT FROM p_band_id THEN
        RAISE EXCEPTION 'Band is not currently assigned to this athlete';
    END IF;

    SELECT e.slug
      INTO v_event_slug
      FROM events e
     WHERE e.id = p_event_id;

    IF NOT FOUND OR COALESCE(v_event_slug, '') = '' THEN
        RAISE EXCEPTION 'Event not found';
    END IF;

    SELECT *
      INTO v_band
      FROM bands b
     WHERE b.band_id = p_band_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Band not found';
    END IF;

    IF v_band.event_slug IS DISTINCT FROM v_event_slug THEN
        RAISE EXCEPTION 'Band does not belong to this event';
    END IF;

    IF v_band.athlete_id IS DISTINCT FROM p_athlete_id THEN
        RAISE EXCEPTION 'Band is not assigned to this athlete';
    END IF;

    IF v_band.status <> 'claimed' THEN
        RAISE EXCEPTION 'Band is not in claimed status';
    END IF;

    INSERT INTO results (
        client_result_id,
        athlete_id,
        station_id,
        event_id,
        drill_type,
        value,
        unit,
        attempt_number,
        recorded_by,
        notes,
        synced_at,
        created_at
    )
    VALUES (
        v_client_result_id_text,
        p_athlete_id,
        p_station_id,
        p_event_id,
        p_drill_type,
        p_value_num,
        NULLIF(trim(COALESCE(p_meta->>'unit', '')), ''),
        COALESCE(NULLIF(p_meta->>'attempt_number', '')::INTEGER, 1),
        auth.uid(),
        NULLIF(trim(COALESCE(p_meta->>'note', '')), ''),
        COALESCE(p_recorded_at, now()),
        now()
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_result_id;

    IF v_result_id IS NULL THEN
        SELECT r.id
          INTO v_result_id
          FROM results r
         WHERE r.client_result_id = v_client_result_id_text;

        RETURN QUERY SELECT v_result_id, p_client_result_id, FALSE;
        RETURN;
    END IF;

    RETURN QUERY SELECT v_result_id, p_client_result_id, TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_result_atomic(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB, TIMESTAMPTZ) TO authenticated;
