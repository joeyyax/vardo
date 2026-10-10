#!/usr/bin/env bash
# Redis durability check against the real image and docker-compose.yml. Needs Docker; skips without it.
# Usage: scripts/test-redis-durability.sh   (pnpm test:redis)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=vardo-redis-test
NAME=vardo-redis-test
VOLUME="${PROJECT}_redis_data"
IMAGE=$(grep -m1 'image: redis/redis-stack-server' "$ROOT/docker-compose.yml" | awk '{print $2}')
PASS=testpw

if ! docker info > /dev/null 2>&1; then echo "SKIP: Docker unavailable"; exit 0; fi
if ! docker image inspect "$IMAGE" > /dev/null 2>&1 && ! docker pull -q "$IMAGE" > /dev/null 2>&1; then
  echo "SKIP: $IMAGE unavailable"; exit 0
fi

WORK=$(mktemp -d)
FAILS=0

cat > "$WORK/override.yml" <<EOF
services:
  redis:
    container_name: $NAME
    ports: !reset []
EOF

compose() {
  REDIS_PASSWORD=$PASS DB_PASSWORD=x docker compose -p "$PROJECT" \
    -f "$ROOT/docker-compose.yml" -f "$WORK/override.yml" "$@"
}

rcli() { docker exec -e REDISCLI_AUTH="$PASS" "$NAME" redis-cli "$@"; }

cleanup() {
  docker rm -f "$NAME" > /dev/null 2>&1
  docker volume rm "$VOLUME" > /dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

fresh_volume() {
  docker rm -f "$NAME" > /dev/null 2>&1
  docker volume rm "$VOLUME" > /dev/null 2>&1
  docker volume create --label "com.docker.compose.project=$PROJECT" \
    --label com.docker.compose.volume=redis_data "$VOLUME" > /dev/null
}

# The previous compose: stock entrypoint, snapshots only.
start_legacy() {
  docker rm -f "$NAME" > /dev/null 2>&1
  docker run -d --name "$NAME" -v "$VOLUME:/data" \
    -e REDIS_PASSWORD="$PASS" \
    -e REDIS_ARGS="--maxmemory 384mb --maxmemory-policy volatile-lru --requirepass $PASS" \
    "$IMAGE" > /dev/null
  wait_ready
}

start_new() {
  docker rm -f "$NAME" > /dev/null 2>&1
  compose up -d --no-deps redis > /dev/null 2>&1
  wait_ready
}

wait_ready() {
  for _ in $(seq 1 60); do
    rcli ping 2> /dev/null | grep -q PONG && return 0
    sleep 1
  done
  echo "  redis never became ready"; return 1
}

wait_aof() {
  local info
  for _ in $(seq 1 60); do
    info=$(rcli info persistence 2> /dev/null)
    if grep -q '^aof_enabled:1' <<< "$info" && grep -q '^aof_rewrite_in_progress:0' <<< "$info" \
      && grep -q '^aof_last_bgrewrite_status:ok' <<< "$info"; then return 0; fi
    sleep 1
  done
  echo "  AOF never settled"; return 1
}

seed() {
  rcli set str hello > /dev/null
  rcli hset hash a 1 b 2 > /dev/null
  rcli rpush list x y z > /dev/null
  rcli sadd set m n > /dev/null
  rcli zadd zset 1 a 2 b > /dev/null
  rcli xadd stream 1-1 f v > /dev/null
  rcli xadd stream 2-1 f v > /dev/null
  rcli ts.add ts 1000 5 > /dev/null
  rcli ts.add ts 2000 7 > /dev/null
  rcli json.set doc '$' '{"a":1}' > /dev/null
}

# One line per type; equal lines mean equal data.
fingerprint() {
  printf 'dbsize=%s str=%s hash=%s list=%s set=%s zset=%s stream=%s ts=%s json=%s' \
    "$(rcli dbsize)" "$(rcli get str)" "$(rcli hlen hash)" "$(rcli llen list)" "$(rcli scard set)" \
    "$(rcli zcard zset)" "$(rcli xlen stream)" "$(rcli ts.get ts | tr '\n' ',')" "$(rcli json.get doc '$')"
}

EXPECT="dbsize=8 str=hello hash=2 list=3 set=2 zset=2 stream=2 ts=2000,7, json=[{\"a\":1}]"

check() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS $label: $got"
  else
    echo "  FAIL $label"; echo "    want: $want"; echo "    got:  $got"
    FAILS=$((FAILS + 1))
  fi
}

echo "== image $IMAGE"

echo "== 1. old setup loses writes on docker stop (baseline)"
fresh_volume; start_legacy
seed; rcli save > /dev/null
rcli set late 1 > /dev/null
docker stop "$NAME" > /dev/null
start_legacy
check "late write after stop, legacy" "$(rcli exists late)" "0"

echo "== 2. upgrade: RDB-only volume, new compose"
fresh_volume; start_legacy
seed; rcli save > /dev/null
before=$(fingerprint)
echo "  before: $before"
start_new; wait_aof
check "all keys after upgrade" "$(fingerprint)" "$before"
check "expected key set" "$(fingerprint)" "$EXPECT"
check "base file exists" "$(docker exec "$NAME" sh -c 'grep -c " type b" /data/appendonlydir/appendonly.aof.manifest')" "1"

echo "== 3. stop keeps writes made seconds before"
rcli set late 1 > /dev/null
rcli xadd stream 3-1 f v > /dev/null
docker stop "$NAME" > /dev/null
start_new
check "late write after stop" "$(rcli exists late)" "1"
check "stream after stop" "$(rcli xlen stream)" "3"

echo "== 4. restart keeps writes"
rcli set late2 1 > /dev/null
docker restart "$NAME" > /dev/null; wait_ready
check "late write after restart" "$(rcli exists late2)" "1"

echo "== 5. kill -9 loses at most a second"
rcli set late3 1 > /dev/null
sleep 2
docker kill "$NAME" > /dev/null
start_new
check "write 2s before kill" "$(rcli exists late3)" "1"

echo "== 6. restart is idempotent"
before=$(fingerprint)
docker restart "$NAME" > /dev/null; wait_ready
check "unchanged after another restart" "$(fingerprint)" "$before"

echo "== 7. interrupted bootstrap (manifest without a base) recovers from dump.rdb"
fresh_volume; start_legacy
seed; rcli save > /dev/null
docker rm -f "$NAME" > /dev/null
docker run --rm -v "$VOLUME:/data" alpine sh -c \
  'mkdir -p /data/appendonlydir && : > /data/appendonlydir/appendonly.aof.1.incr.aof && printf "file appendonly.aof.1.incr.aof seq 1 type i\n" > /data/appendonlydir/appendonly.aof.manifest'
start_new; wait_aof
check "all keys" "$(fingerprint)" "$EXPECT"

echo "== 8. fresh install"
fresh_volume; start_new; wait_aof
check "empty" "$(rcli dbsize)" "0"
rcli set k v > /dev/null
docker stop "$NAME" > /dev/null
start_new
check "write survives stop" "$(rcli get k)" "v"

echo
if [ "$FAILS" -eq 0 ]; then echo "OK"; else echo "$FAILS FAILED"; exit 1; fi
