-- Migration: 008_add_register_athlete_atomic_rpc.sql
-- Description: Adds an atomic registration RPC for athlete, waiver, claim token, and parent portal creation.

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
    v_token_col TEXT;
    v_used_col_exists BOOLEAN;
    v_parent_portals_exists BOOLEAN;
    v_registration_token_exists BOOLEAN;
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

    SELECT CASE
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'token_claims' AND column_name = 'token'
             ) THEN 'token'
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'token_claims' AND column_name = 'token_hash'
             ) THEN 'token_hash'
             ELSE NULL
           END,
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'token_claims' AND column_name = 'used'
           ),
           EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'parent_portals'
           ),
           EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'athletes' AND column_name = 'registration_token'
           )
      INTO v_token_col, v_used_col_exists, v_parent_portals_exists, v_registration_token_exists;

    IF v_token_col IS NULL THEN
        RAISE EXCEPTION 'token_claims token column not found';
    END IF;

    IF v_registration_token_exists THEN
        EXECUTE '
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
                registration_token
            )
            VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10)
            RETURNING id
        '
        INTO v_athlete_id
        USING
            p_event_id,
            p_athlete->>'first_name',
            p_athlete->>'last_name',
            p_athlete->>'date_of_birth',
            NULLIF(p_athlete->>'grade', ''),
            NULLIF(p_athlete->>'position', ''),
            p_athlete->>'parent_name',
            p_athlete->>'parent_email',
            p_athlete->>'parent_phone',
            p_claim_token;
    ELSE
        INSERT INTO athletes (
            event_id,
            first_name,
            last_name,
            date_of_birth,
            grade,
            position,
            parent_name,
            parent_email,
            parent_phone
        )
        VALUES (
            p_event_id,
            p_athlete->>'first_name',
            p_athlete->>'last_name',
            (p_athlete->>'date_of_birth')::DATE,
            NULLIF(p_athlete->>'grade', ''),
            NULLIF(p_athlete->>'position', ''),
            p_athlete->>'parent_name',
            p_athlete->>'parent_email',
            p_athlete->>'parent_phone'
        )
        RETURNING id INTO v_athlete_id;
    END IF;

    INSERT INTO waivers (
        athlete_id,
        event_id,
        guardian_name,
        guardian_relationship,
        emergency_contact_name,
        emergency_contact_phone,
        signature_data_url,
        injury_waiver_ack,
        media_release,
        data_consent,
        marketing_consent,
        waiver_version
    )
    VALUES (
        v_athlete_id,
        p_event_id,
        p_waiver->>'guardian_name',
        NULLIF(p_waiver->>'guardian_relationship', ''),
        p_waiver->>'emergency_contact_name',
        p_waiver->>'emergency_contact_phone',
        p_waiver->>'signature_data_url',
        COALESCE((p_waiver->>'injury_waiver_ack')::BOOLEAN, FALSE),
        COALESCE((p_waiver->>'media_release')::BOOLEAN, FALSE),
        COALESCE((p_waiver->>'data_consent')::BOOLEAN, FALSE),
        COALESCE((p_waiver->>'marketing_consent')::BOOLEAN, FALSE),
        COALESCE(NULLIF(p_waiver->>'waiver_version', ''), '2026.1')
    );

    IF v_used_col_exists THEN
        EXECUTE format(
            'INSERT INTO token_claims (%I, event_id, athlete_id, expires_at, used) VALUES ($1, $2, $3, $4, FALSE)',
            v_token_col
        )
        USING p_claim_token, p_event_id, v_athlete_id, p_claim_expires_at;
    ELSE
        EXECUTE format(
            'INSERT INTO token_claims (%I, event_id, athlete_id, expires_at) VALUES ($1, $2, $3, $4)',
            v_token_col
        )
        USING p_claim_token, p_event_id, v_athlete_id, p_claim_expires_at;
    END IF;

    IF v_parent_portals_exists AND COALESCE(trim(p_portal_token), '') <> '' THEN
        INSERT INTO parent_portals (athlete_id, event_id, portal_token)
        VALUES (v_athlete_id, p_event_id, p_portal_token);
    END IF;

    RETURN QUERY
    SELECT v_athlete_id, p_claim_token, p_portal_token;
END;
$$;

GRANT EXECUTE ON FUNCTION register_athlete_atomic(UUID, JSONB, JSONB, TEXT, TIMESTAMPTZ, TEXT) TO anon, authenticated;
