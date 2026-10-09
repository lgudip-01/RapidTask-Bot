#!/bin/sh
# Container entrypoint: prepare the volume, restore from backup if the DB is missing, then run
# the server under Litestream (continuous replication) as the unprivileged `node` user.
set -eu

mkdir -p "$(dirname "$DATABASE_PATH")"
chown -R node:node "$(dirname "$DATABASE_PATH")"
cd /app/apps/server

as_node() {
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all "$@"
}

if [ -n "${LITESTREAM_REPLICA_URL:-}" ]; then
  # First boot on a fresh volume: pull the latest replica, if one exists.
  setpriv --reuid=node --regid=node --init-groups --inh-caps=-all \
    litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DATABASE_PATH"
  as_node litestream replicate -config /etc/litestream.yml -exec "node dist/index.js"
else
  echo "LITESTREAM_REPLICA_URL is not set: running WITHOUT continuous backups" >&2
  as_node node dist/index.js
fi
