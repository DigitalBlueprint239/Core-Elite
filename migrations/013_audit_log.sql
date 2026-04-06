-- =============================================================================
-- MIGRATION 013: Audit Logging
-- Core Elite Combine 2026
-- =============================================================================
--
-- CHANGES:
--   audit_log table — immutable record of all mutations to core entities
--   Postgres triggers: result INSERT → 'result_submitted', result UPDATE voided → 'result_voided'
--   RLS: admin-only read; no direct writes from client (triggers only)
--   3 covering indexes for event/entity/user query patterns
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Audit log table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID REFERENCES events(id),
  user_id     UUID REFERENCES auth.users(id),
  action      TEXT NOT NULL,       -- 'result_submitted' | 'result_voided' | 'band_claimed' | 'band_voided' | 'athlete_registered'
  entity_type TEXT NOT NULL,       -- 'result' | 'band' | 'athlete' | 'waiver'
  entity_id   TEXT NOT NULL,
  old_value   JSONB,
  new_value   JSONB,
  device_info TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. RLS — admin-only read; no public policy (triggers bypass RLS)
-- -----------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin Read Audit"
  ON audit_log FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- -----------------------------------------------------------------------------
-- 3. Covering indexes
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_audit_event  ON audit_log(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);

-- -----------------------------------------------------------------------------
-- 4. Trigger: auto-log result submissions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_result_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (event_id, user_id, action, entity_type, entity_id, new_value)
  VALUES (
    NEW.event_id,
    NEW.recorded_by,
    'result_submitted',
    'result',
    NEW.id::text,
    jsonb_build_object(
      'drill_type', NEW.drill_type,
      'value_num',  NEW.value_num,
      'station_id', NEW.station_id
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_result_audit ON results;
CREATE TRIGGER trg_result_audit
  AFTER INSERT ON results
  FOR EACH ROW EXECUTE FUNCTION log_result_insert();

-- -----------------------------------------------------------------------------
-- 5. Trigger: auto-log result voids
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_result_void() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.voided IS DISTINCT FROM NEW.voided AND NEW.voided = true THEN
    INSERT INTO audit_log (event_id, user_id, action, entity_type, entity_id, old_value, new_value)
    VALUES (
      NEW.event_id,
      auth.uid(),
      'result_voided',
      'result',
      NEW.id::text,
      jsonb_build_object('value_num', OLD.value_num),
      jsonb_build_object('voided', true)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_result_void_audit ON results;
CREATE TRIGGER trg_result_void_audit
  AFTER UPDATE ON results
  FOR EACH ROW EXECUTE FUNCTION log_result_void();
