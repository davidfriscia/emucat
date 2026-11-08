#!/usr/bin/env bash
# Builds the production images and runs them with deploy/compose.yaml against a disposable MariaDB that
# stands in for the host's own server (it is NOT part of the Compose project). Then checks routing,
# caching, health, the container security settings and that media survives replacing the containers.
#
#   bash deploy/test/compose-smoke.sh            (pnpm test:compose)
#
# Everything it creates is named emucat-smoke-<random> and removed at the end. It never touches another
# container, image tag, volume or database.
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1

# Windows paths for the Docker and Git CLIs when run from Git Bash; unchanged elsewhere.
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
repo=$(host_path "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)")
id=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
project=emucat-smoke-$id
db_container=$project-db
work=$(mktemp -d)
pass=0
fail=0
check() {
  local label=$1
  shift
  if "$@"; then
    printf '  ok    %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n' "$label"
    fail=$((fail + 1))
  fi
}

cleanup() {
  set +e
  [[ -n ${COMPOSE_READY:-} ]] && compose down --timeout 5 >/dev/null 2>&1
  docker rm -f "$db_container" >/dev/null 2>&1
  docker image rm "emucat-api:smoke-$id" "emucat-web:smoke-$id" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

commit=$(git -C "$repo" rev-parse HEAD)
built=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "Building images for $commit"
for component in api web; do
  docker build --quiet --file "$repo/deploy/docker/$component.Dockerfile" --target runtime \
    --tag "emucat-$component:smoke-$id" --build-arg "EMUCAT_COMMIT=$commit" \
    --build-arg "EMUCAT_BUILD_TIME=$built" "$repo" >/dev/null
done

echo "Starting a disposable MariaDB (outside Compose, as on a real host)"
root_password=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
app_password=$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')
db_port=$((20000 + RANDOM % 20000))
docker run --detach --name "$db_container" --env "MARIADB_ROOT_PASSWORD=$root_password" \
  --publish "${SMOKE_DB_BIND:-127.0.0.1}:$db_port:3306" mariadb:11.8 >/dev/null
until docker exec "$db_container" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; do sleep 1; done
sed "s/CHANGE_ME/$app_password/" "$repo/deploy/sql/bootstrap.sql" |
  docker exec -i "$db_container" mariadb -uroot "-p$root_password"

mkdir -p "$work/media" "$work/socket"
printf 'smoke-test-deployer-token-0123456789abcdef\n' >"$work/deployer.token"
setup_token=smoke-setup-token-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
cat >"$work/app.env" <<EOF
DB_HOST=host.docker.internal
DB_PORT=$db_port
DB_NAME=emucat-db
DB_USER=emucat-usr
DB_PASSWORD=$app_password
COOKIE_SECURE=false
SETUP_TOKEN=$setup_token
LOG_LEVEL=warn
EOF

http_port=$((40000 + RANDOM % 10000))
export EMUCAT_PROJECT=$project EMUCAT_RELEASE=smoke-$id EMUCAT_ENVIRONMENT=smoke
export EMUCAT_APP_ENV_FILE EMUCAT_MEDIA_DIR EMUCAT_SOCKET_DIR EMUCAT_DEPLOYER_TOKEN_FILE
EMUCAT_APP_ENV_FILE=$(host_path "$work/app.env")
EMUCAT_MEDIA_DIR=$(host_path "$work/media")
EMUCAT_SOCKET_DIR=$(host_path "$work/socket")
EMUCAT_DEPLOYER_TOKEN_FILE=$(host_path "$work/deployer.token")
export EMUCAT_SOCKET_GID=10001 EMUCAT_HTTP_PORT=$http_port EMUCAT_BIND_ADDRESS=127.0.0.1
# Test-only networks, so as not to collide with a real installation on this machine.
export EMUCAT_EDGE_SUBNET=172.31.243.0/24 EMUCAT_INTERNAL_SUBNET=172.31.244.0/24
export EMUCAT_DATABASE_SUBNET=172.31.245.0/24
compose() { docker compose --file "$repo/deploy/compose.yaml" "$@"; }
COMPOSE_READY=1

echo "Applying migrations as a controlled step"
migrate=$(compose run --rm --no-deps -T api node dist/db/migrate-cli.js 2>&1)
echo "$migrate" | sed 's/^/  /'
echo "Starting the application"
compose up --detach --wait --wait-timeout 120 >/dev/null

base=http://127.0.0.1:$http_port
headers() { curl --silent --output /dev/null --dump-header - "$base$1" | tr -d '\r'; }
body() { curl --silent "$base$1"; }
has() { grep -qi -- "$2" <<<"$1"; }

echo "Checks"
check "migrations ran against the external database" has "$migrate" 'Applied [1-9]'
check "no MariaDB service in the Compose project" bash -c "! docker compose --file '$repo/deploy/compose.yaml' config --services | grep -qi maria"
check "the API container is healthy (ready = database and schema)" \
  test "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q api)")" = healthy
check "the web container is healthy" \
  test "$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q web)")" = healthy
check "GET / serves the app shell" has "$(body /)" 'id="root"'
check "the app shell is revalidated, not cached" has "$(headers /)" 'cache-control: no-cache'
check "a VM detail route falls back to the app (SPA)" has "$(body /vms/qemu/Win98)" 'id="root"'
asset=$(body / | grep -o '/assets/[^"]*\.js' | head -n 1)
check "hashed assets are cached immutably" has "$(headers "$asset")" 'immutable'
check "a missing asset is a 404, not the app" has "$(headers /assets/missing.js)" 'HTTP/1.1 404'
check "/api/v1/ready reaches the API and is ready" has "$(body /api/v1/ready)" '"status":"ready"'
check "/api/v1/info is the API" has "$(body /api/v1/info)" '"name":"EmuCat"'
check "unknown API routes answer from the API" has "$(body /api/v1/nope)" '"code":"not_found"'
ws=$(curl --silent --output /dev/null --write-out '%{http_code}' --http1.1 -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXk=' \
  "$base/api/v1/agent/ws" || true)
echo "  (handshake answered $ws)"
check "the agent WebSocket handshake reaches the API (401 without a credential)" test "$ws" = 401

api=$(compose ps -q api)
web=$(compose ps -q web)
inspect() { docker inspect --format "$2" "$1"; }
check "API runs as UID 10001, not root" test "$(inspect "$api" '{{.Config.User}}')" = 10001:10001
check "API root filesystem is read-only" test "$(inspect "$api" '{{.HostConfig.ReadonlyRootfs}}')" = true
check "web root filesystem is read-only" test "$(inspect "$web" '{{.HostConfig.ReadonlyRootfs}}')" = true
check "no container is privileged" test "$(inspect "$api" '{{.HostConfig.Privileged}}')$(inspect "$web" '{{.HostConfig.Privileged}}')" = falsefalse
check "all capabilities dropped" has "$(inspect "$api" '{{.HostConfig.CapDrop}}')" 'ALL'
mounts=$(inspect "$api" '{{range .Mounts}}{{.Destination}}:{{.RW}} {{end}}')
check "no Docker socket in the API" bash -c "! grep -q docker.sock <<<'$mounts'"
check "API mounts only media, the socket directory and its token, the last two read-only" \
  test "$(tr ' ' '\n' <<<"$mounts" | grep -v '^$' | sort | tr '\n' ' ')" = \
  "/data/storage:true /run/emucat-deployer:false /run/secrets/deployer_token:false "
check "the API port is not published" test -z "$(inspect "$api" '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}}{{end}}{{end}}')"
check "the ingress is bound to the configured address only" \
  has "$(docker port "$web")" "127.0.0.1:$http_port"
check "the API reports its build commit" has "$(inspect "$api" '{{range .Config.Env}}{{println .}}{{end}}')" "EMUCAT_BUILD_COMMIT=$commit"

echo "Signing in as the first administrator, through the proxy"
jar=$(host_path "$work/cookies")
setup=$(curl --silent --cookie-jar "$jar" -H 'content-type: application/json' -H "origin: $base" \
  -d "{\"setupToken\":\"$setup_token\",\"username\":\"admin\",\"displayName\":\"Smoke\",\"password\":\"smoke test password 1\"}" \
  "$base/api/v1/setup")
check "setup and sign-in work behind the proxy" has "$setup" '"csrfToken"'
version=$(curl --silent --cookie "$jar" "$base/api/v1/admin/system/version")
check "the version endpoint reports the build commit" has "$version" "\"buildCommit\":\"$commit\""
updates=$(curl --silent --cookie "$jar" "$base/api/v1/admin/system/updates")
check "with no deployment service running, updates say so" has "$updates" '"service":"unavailable"'
check "anonymous update requests are refused" test \
  "$(curl --silent --output /dev/null --write-out '%{http_code}' -X POST -H "origin: $base" "$base/api/v1/admin/system/updates")" = 401

echo "Replacing the containers"
docker exec "$api" node -e "require('fs').writeFileSync('/data/storage/survives.txt','kept')"
compose up --detach --wait --wait-timeout 120 --force-recreate >/dev/null
check "media written by the API is on the host" test "$(cat "$work/media/survives.txt")" = kept
check "media survives replacing the containers" \
  test "$(docker exec "$(compose ps -q api)" node -e "process.stdout.write(require('fs').readFileSync('/data/storage/survives.txt','utf8'))")" = kept
check "the API cannot write outside its mounts" \
  bash -c "! docker exec '$(compose ps -q api)' node -e \"require('fs').writeFileSync('/app/x','x')\" 2>/dev/null"

echo
echo "$pass passed, $fail failed"
((fail == 0))
