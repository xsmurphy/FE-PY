#!/bin/sh
# Entrypoint del contenedor.
#
# Modo:
#   "api"    → corre migrations + arranca el servidor HTTP
#   "worker" → arranca workers BullMQ sin migrations (las corre el api)
#
# Uso en docker-compose:
#   command: ["api"]    # servicio API
#   command: ["worker"] # servicio worker
set -e

MODE="${1:-api}"

case "$MODE" in
  api)
    echo "[entrypoint] Running database migrations..."
    node dist/db/migrate.js
    echo "[entrypoint] Starting API server..."
    exec node dist/server.js
    ;;
  worker)
    echo "[entrypoint] Starting BullMQ worker..."
    exec node dist/queue/worker-server.js
    ;;
  migrate)
    echo "[entrypoint] Running migrations only..."
    exec node dist/db/migrate.js
    ;;
  shell)
    exec /bin/sh
    ;;
  *)
    echo "[entrypoint] Unknown mode: $MODE"
    echo "Usage: $0 [api|worker|migrate|shell]"
    exit 1
    ;;
esac
