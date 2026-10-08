CREATE FUNCTION "volume_prefix_in_use"(prefix text, except_env text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "environment" e JOIN "app" a ON a."id" = e."app_id"
    WHERE a."name" || '-' || e."name" = prefix AND e."id" IS DISTINCT FROM except_env
  );
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE FUNCTION "guard_env_volume_prefix"() RETURNS trigger AS $$
DECLARE prefix text;
BEGIN
  SELECT "name" || '-' || NEW."name" INTO prefix FROM "app" WHERE "id" = NEW."app_id";
  PERFORM pg_advisory_xact_lock(hashtext(prefix));
  IF "volume_prefix_in_use"(prefix, NEW."id") THEN
    RAISE EXCEPTION 'Volume prefix "%_" is already used by another app and environment', prefix USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "environment_volume_prefix_guard" BEFORE INSERT OR UPDATE OF "name", "app_id" ON "environment"
  FOR EACH ROW EXECUTE FUNCTION "guard_env_volume_prefix"();
--> statement-breakpoint
CREATE FUNCTION "guard_app_volume_prefix"() RETURNS trigger AS $$
DECLARE prefix text := NEW."name" || '-production';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(prefix));
  IF "volume_prefix_in_use"(prefix, NULL) THEN
    RAISE EXCEPTION 'Volume prefix "%_" is already used by another app and environment', prefix USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "app_volume_prefix_guard" BEFORE INSERT ON "app"
  FOR EACH ROW EXECUTE FUNCTION "guard_app_volume_prefix"();
