-- Migration: 007_add_claim_band_atomic_rpc.sql
-- Description: Adds a production-safe atomic wristband claim RPC with compatibility for schema drift.

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
    v_claim RECORD;
    v_band RECORD;
    v_token_col TEXT;
    v_used_col_exists BOOLEAN;
    v_claimed_at_col TEXT;
    v_band_time_col TEXT;
BEGIN
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
           CASE
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bands' AND column_name = 'claimed_at'
             ) THEN 'claimed_at'
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'bands' AND column_name = 'assigned_at'
             ) THEN 'assigned_at'
             ELSE NULL
           END,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'token_claims' AND column_name = 'claimed_at'
             ) THEN 'claimed_at'
             WHEN EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'token_claims' AND column_name = 'used_at'
             ) THEN 'used_at'
             ELSE NULL
           END
      INTO v_token_col, v_used_col_exists, v_band_time_col, v_claimed_at_col;

    IF v_token_col IS NULL THEN
        RAISE EXCEPTION 'token_claims token column not found';
    END IF;

    IF v_band_time_col IS NULL THEN
        RAISE EXCEPTION 'bands timestamp column not found';
    END IF;

    IF v_claimed_at_col IS NULL THEN
        RAISE EXCEPTION 'token_claims timestamp column not found';
    END IF;

    EXECUTE format(
        'SELECT * FROM token_claims WHERE %I = $1 FOR UPDATE',
        v_token_col
    )
    INTO v_claim
    USING p_token;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Claim session not found';
    END IF;

    IF COALESCE((to_jsonb(v_claim)->>'used')::BOOLEAN, FALSE)
       OR (to_jsonb(v_claim)->>v_claimed_at_col) IS NOT NULL THEN
        RAISE EXCEPTION 'This wristband has already been claimed';
    END IF;

    IF v_claim.expires_at < v_now THEN
        RAISE EXCEPTION 'Claim session has expired';
    END IF;

    SELECT *
      INTO v_band
      FROM bands
     WHERE bands.band_id = p_band_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid wristband ID';
    END IF;

    IF v_band.status <> 'available' THEN
        RAISE EXCEPTION 'This wristband is already assigned or void';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM athletes
         WHERE id = v_claim.athlete_id
           AND band_id IS NOT NULL
           AND band_id <> p_band_id
    ) THEN
        RAISE EXCEPTION 'Athlete already has a wristband';
    END IF;

    EXECUTE format(
        'UPDATE bands
            SET status = $1,
                athlete_id = $2,
                %I = $3
          WHERE band_id = $4',
        v_band_time_col
    ) USING 'assigned', v_claim.athlete_id, v_now, p_band_id;

    UPDATE athletes
       SET band_id = p_band_id
     WHERE id = v_claim.athlete_id;

    IF v_used_col_exists THEN
        EXECUTE format(
            'UPDATE token_claims
                SET used = TRUE,
                    %I = $1
              WHERE %I = $2',
            v_claimed_at_col,
            v_token_col
        ) USING v_now, p_token;
    ELSE
        EXECUTE format(
            'UPDATE token_claims
                SET %I = $1
              WHERE %I = $2',
            v_claimed_at_col,
            v_token_col
        ) USING v_now, p_token;
    END IF;

    RETURN QUERY
    SELECT b.band_id, b.athlete_id, v_now, b.status
      FROM bands b
     WHERE b.band_id = p_band_id;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_band_atomic(TEXT, TEXT) TO anon, authenticated;
