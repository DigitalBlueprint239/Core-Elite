-- Migration: 007_atomic_band_claim.sql
-- Description: Replaces the multi-step client-side band claim flow with a single atomic RPC.
-- This eliminates race conditions where two users might claim the same band simultaneously,
-- and prevents partial failures (e.g., band assigned but token not consumed).

CREATE OR REPLACE FUNCTION public.claim_band_atomic(
  p_token text,
  p_band_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim record;
  v_band record;
  v_now timestamptz := now();
BEGIN
  -- 1. Lock and validate the token claim
  SELECT * INTO v_claim
  FROM token_claims
  WHERE token_hash = p_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'invalid_token',
      'message', 'Claim session not found.'
    );
  END IF;

  IF v_claim.used_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'token_already_used',
      'message', 'This registration link has already been used.'
    );
  END IF;

  IF v_claim.expires_at < v_now THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'expired_token',
      'message', 'This claim link has expired.'
    );
  END IF;

  -- 2. Lock and validate the band
  SELECT * INTO v_band
  FROM bands
  WHERE band_id = p_band_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'band_not_found',
      'message', 'That wristband number was not found.'
    );
  END IF;

  IF v_band.status != 'available' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'band_unavailable',
      'message', 'This wristband is already assigned.'
    );
  END IF;

  -- 3. Execute the atomic updates
  -- Note: We update bands first, then athletes, to satisfy the circular FK if deferred,
  -- or just to maintain the same order the client used.

  UPDATE bands
  SET 
    status = 'assigned',
    athlete_id = v_claim.athlete_id,
    assigned_at = v_now
  WHERE band_id = p_band_id;

  UPDATE athletes
  SET band_id = p_band_id
  WHERE id = v_claim.athlete_id;

  UPDATE token_claims
  SET used_at = v_now
  WHERE token_hash = p_token;

  -- 4. Return success payload
  RETURN jsonb_build_object(
    'success', true,
    'code', 'success',
    'athlete_id', v_claim.athlete_id,
    'band_id', p_band_id,
    'display_number', v_band.display_number
  );

EXCEPTION WHEN OTHERS THEN
  -- Catch any unexpected DB errors (e.g., constraint violations) and return a safe payload
  -- The transaction will automatically roll back.
  RETURN jsonb_build_object(
    'success', false,
    'code', 'claim_failed',
    'message', SQLERRM
  );
END;
$$;

-- Grant execute permission to authenticated and anon roles
GRANT EXECUTE ON FUNCTION public.claim_band_atomic(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_band_atomic(text, text) TO anon;
