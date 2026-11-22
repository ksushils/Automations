#!/bin/sh
# Roll back the app on the VPS (run as root on the server).
#   sh scripts/rollback-vps.sh                      → run the previous image again (code only; data untouched)
#   sh scripts/rollback-vps.sh /root/wa-backups/predeploy-YYYYMMDD-HHMMSS.db
#                                                   → ALSO put that database snapshot back. Changes made since the
#                                                     snapshot are lost; the current database is kept next to it first.
# Schema changes are additive, so the previous code runs fine on the newer database – only restore data if data was damaged.
set -eu
APP=${APP:-/opt/whatsapp-commerce/whatsapp-commerce}
C=${CONTAINER:-whatsapp-commerce}
IMAGE=${IMAGE:-whatsapp-commerce:latest}
COMPOSE="docker compose -f docker-compose.vps.yml"
cd "$APP"
docker image inspect whatsapp-commerce:previous >/dev/null 2>&1 || { echo "No whatsapp-commerce:previous image (deploy-vps.sh makes one)"; exit 1; }

if [ "${1:-}" ]; then
  SNAP=$1
  [ -f "$SNAP" ] || { echo "No such snapshot: $SNAP"; exit 1; }
  TS=$(date +%Y%m%d-%H%M%S)
  DB=$(docker exec "$C" printenv DATABASE_PATH 2>/dev/null || echo /app/data/whatsapp-commerce.db)
  echo "== keeping the current database as /root/wa-backups/before-rollback-$TS.db"
  docker exec "$C" node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '/app/data/before-rollback-$TS.db'\")" "$DB"
  docker cp "$C:/app/data/before-rollback-$TS.db" /root/wa-backups/
  docker exec "$C" rm -f "/app/data/before-rollback-$TS.db"
  docker stop "$C"
  docker cp "$SNAP" "$C:$DB"
  docker run --rm --volumes-from "$C" alpine sh -c "rm -f '$DB-wal' '$DB-shm'" >/dev/null 2>&1 || true
fi

docker tag whatsapp-commerce:previous "$IMAGE"
$COMPOSE up -d
sleep 5
docker exec "$C" node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>r.text()).then(console.log)"
echo "== rolled back. Remember: the git checkout still has the new commit – run 'git reset --keep <commit>' in /opt/whatsapp-commerce if you want the code to match."
