-- An upsert of an existing app (same org and name) isn't a new prefix; let ON CONFLICT handle it.
CREATE OR REPLACE FUNCTION "guard_app_volume_prefix"() RETURNS trigger AS $$
DECLARE prefix text := NEW."name" || '-production';
BEGIN
  IF EXISTS (
    SELECT 1 FROM "app"
    WHERE "name" = NEW."name" AND "organization_id" = NEW."organization_id"
  ) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(prefix));
  IF "volume_prefix_in_use"(prefix, NULL) THEN
    RAISE EXCEPTION 'Volume prefix "%_" is already used by another app and environment', prefix USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
