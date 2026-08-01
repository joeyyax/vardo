-- One-time rewrite of stored compose that uses network_mode with a network name.
--
-- The parser corrects this on every read, so runtime is already right. This is
-- for the YAML an operator sees in the editor, and it silences the boot audit.
-- Review the SELECT output before COMMIT.
--
--   psql "$DATABASE_URL" -f scripts/migrate-network-mode.sql
--
-- Only network_mode: vardo-network is rewritten. Widen NETWORK below for a
-- different shared network; host/none/bridge/container:/service: are namespaces
-- and must not be touched.

BEGIN;

CREATE TEMP TABLE network_mode_backup AS
SELECT id, name, compose_content
FROM app
WHERE compose_content ~ '(^|\n)[ \t]+network_mode:[ \t]*"?vardo-network"?[ \t]*(\r?\n|$)';

SELECT name FROM network_mode_backup ORDER BY name;

-- Move the network name into the service's networks list.
UPDATE app SET compose_content = regexp_replace(
  compose_content,
  '(\n[ \t]+)network_mode:[ \t]*"?vardo-network"?[ \t]*(\r?\n|$)',
  '\1networks:\1  - vardo-network\2',
  'g'
)
WHERE id IN (SELECT id FROM network_mode_backup)
  AND compose_content !~ '(^|\n)[ \t]+networks:';

-- Declare the network external so Compose attaches to the existing one.
UPDATE app SET compose_content = rtrim(compose_content, E' \n') || E'\n\nnetworks:\n  vardo-network:\n    external: true\n'
WHERE id IN (SELECT id FROM network_mode_backup)
  AND compose_content !~ '(^|\n)networks:';

-- Expect 0.
SELECT count(*) AS unconverted
FROM app
WHERE compose_content ~ '(^|\n)[ \t]+network_mode:[ \t]*"?vardo-network"?[ \t]*(\r?\n|$)';

-- ROLLBACK;
COMMIT;
