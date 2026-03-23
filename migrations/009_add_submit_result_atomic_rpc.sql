-- Migration: 009_add_submit_result_atomic_rpc.sql
-- Description: Adds an atomic result submission RPC with event/station/band/athlete validation.

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
    v_station RECORD;
    v_band RECORD;
    v_athlete RECORD;
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

    SELECT id
      INTO v_result_id
      FROM results
     WHERE client_result_id = p_client_result_id;

    IF FOUND THEN
        RETURN QUERY SELECT v_result_id, p_client_result_id, FALSE;
        RETURN;
    END IF;

    SELECT *
      INTO v_station
      FROM stations
     WHERE id = p_station_id;

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
      FROM athletes
     WHERE id = p_athlete_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Athlete not found';
    END IF;

    IF v_athlete.event_id <> p_event_id THEN
        RAISE EXCEPTION 'Athlete does not belong to this event';
    END IF;

    IF v_athlete.band_id IS DISTINCT FROM p_band_id THEN
        RAISE EXCEPTION 'Band is not currently assigned to this athlete';
    END IF;

    SELECT *
      INTO v_band
      FROM bands
     WHERE band_id = p_band_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Band not found';
    END IF;

    IF v_band.event_id <> p_event_id THEN
        RAISE EXCEPTION 'Band does not belong to this event';
    END IF;

    IF v_band.athlete_id IS DISTINCT FROM p_athlete_id THEN
        RAISE EXCEPTION 'Band is not assigned to this athlete';
    END IF;

    IF v_band.status <> 'assigned' THEN
        RAISE EXCEPTION 'Band is not in assigned status';
    END IF;

    INSERT INTO results (
        client_result_id,
        event_id,
        athlete_id,
        band_id,
        station_id,
        drill_type,
        value_num,
        meta,
        recorded_by,
        recorded_at
    )
    VALUES (
        p_client_result_id,
        p_event_id,
        p_athlete_id,
        p_band_id,
        p_station_id,
        p_drill_type,
        p_value_num,
        COALESCE(p_meta, '{}'::jsonb),
        auth.uid(),
        COALESCE(p_recorded_at, now())
    )
    ON CONFLICT (client_result_id) DO NOTHING
    RETURNING id INTO v_result_id;

    IF v_result_id IS NULL THEN
        SELECT id
          INTO v_result_id
          FROM results
         WHERE client_result_id = p_client_result_id;

        RETURN QUERY SELECT v_result_id, p_client_result_id, FALSE;
        RETURN;
    END IF;

    RETURN QUERY SELECT v_result_id, p_client_result_id, TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_result_atomic(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, JSONB, TIMESTAMPTZ) TO authenticated;
