-- Compose children created before decomposition copied the flag still sit at
-- false under a system-managed parent, which unlocks edit and delete on rows
-- Vardo rewrites on every boot.
UPDATE "app" AS c
SET "is_system_managed" = p."is_system_managed"
FROM "app" AS p
WHERE c."parent_app_id" = p."id"
  AND c."is_system_managed" IS DISTINCT FROM p."is_system_managed";
