#!/bin/sh
# Safe deploy on the VPS (run as root on the server):  sh /opt/whatsapp-commerce/whatsapp-commerce/scripts/deploy-vps.sh
#  1. snapshot the live database (VACUUM INTO) and copy it to /root/wa-backups
#  2. keep the running image as whatsapp-commerce:previous
#  3. merge origin/main into the server branch, build the new image
#  4. run the full test suite INSIDE the new image – stop here (nothing restarted) if any test fails
#  5. restart, then wait for /health – if it doesn't come back OK, switch back to the previous image automatically
# Touches only this app's container and image. Never restarts Traefik or other apps.
set -eu
REPO=${REPO:-/opt/whatsapp-commerce}
APP=$REPO/whatsapp-commerce
C=${CONTAINER:-whatsapp-commerce}
IMAGE=${IMAGE:-whatsapp-commerce:latest}
COMPOSE="docker compose -f docker-compose.vps.yml"
TS=$(date +%Y%m%d-%H%M%S)
cd "$APP"

health() { docker exec "$C" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})" 2>/dev/null; }

echo "== 1. database snapshot"
DB=$(docker exec "$C" printenv DATABASE_PATH 2>/dev/null || echo /app/data/whatsapp-commerce.db)
docker exec "$C" node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '/app/data/predeploy-$TS.db'\")" "$DB"
mkdir -p /root/wa-backups
docker cp "$C:/app/data/predeploy-$TS.db" /root/wa-backups/
docker exec "$C" rm -f "/app/data/predeploy-$TS.db"
echo "   saved /root/wa-backups/predeploy-$TS.db"

echo "== 2. remember the running version"
PREV=$(git -C "$REPO" rev-parse HEAD)
docker tag "$IMAGE" whatsapp-commerce:previous
echo "   previous commit $PREV, image tagged whatsapp-commerce:previous"

echo "== 3. merge and build"
git -C "$REPO" fetch -q origin
git -C "$REPO" merge --no-edit origin/main
$COMPOSE build -q

echo "== 4. tests inside the new image"
OUT=$(docker run --rm -v "$APP/test:/app/test" -v "$APP/shopify-app:/app/shopify-app" "$IMAGE" sh -c "node --test --no-warnings test/*.test.js" 2>&1 || true)
echo "$OUT" | grep -E "^# (tests|pass|fail)" || true
if ! echo "$OUT" | grep -q "^# fail 0"; then
  echo "!! tests failed – NOT restarting. Putting the previous image and commit back."
  echo "$OUT" | grep -E "^not ok" | head -20
  docker tag whatsapp-commerce:previous "$IMAGE"
  git -C "$REPO" reset --keep "$PREV"
  exit 1
fi

echo "== 5. restart and health check"
$COMPOSE up -d
i=0
until health; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "!! /health did not come back OK – rolling back to the previous image"
    docker tag whatsapp-commerce:previous "$IMAGE"
    git -C "$REPO" reset --keep "$PREV"
    $COMPOSE up -d
    sleep 5; health || true
    exit 1
  fi
  sleep 2
done
docker image prune -f >/dev/null
echo "== deployed $(git -C "$REPO" rev-parse --short HEAD) (rollback: sh scripts/rollback-vps.sh)"
