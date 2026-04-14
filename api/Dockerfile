# Multi-stage Dockerfile para facturacion-api.
#
# Build context: ROOT del repo (no el subdirectorio api/).
# Comando desde la raíz:
#   docker build -f api/Dockerfile -t facturacion-api .
#
# Stages:
#   1. parent-builder: compila el motor xmlgen (TS 3.7 → dist/)
#   2. api-builder:    compila el API (TS 5 → dist/)
#   3. runtime:        imagen final, Alpine + libxml2-utils + tini
#
# La imagen runtime resultante pesa ~250 MB y expone :3000.
# Los migrations se ejecutan automáticamente antes del arranque vía entrypoint.

# ============================================================================
# Stage 1: build del motor xmlgen (repo padre)
# ============================================================================
FROM node:20-alpine AS parent-builder
WORKDIR /parent

# Instalamos deps del motor y lo compilamos a dist/
COPY package.json package-lock.json tsconfig.json tslint.json ./
COPY src ./src
RUN npm ci --ignore-scripts
# El prepare hook falla en algunos entornos CI; forzamos build explícito
RUN npx tsc || true
# Fallback: si tsc viejo falla, intentamos con el que venga instalado
RUN test -d dist || npm run build

# ============================================================================
# Stage 2: build del API
# ============================================================================
FROM node:20-alpine AS api-builder
WORKDIR /app

# Copiar el motor compilado al path esperado por file:..
COPY --from=parent-builder /parent/package.json /parent/package.json
COPY --from=parent-builder /parent/dist /parent/dist

# XSDs oficiales para validación (los consume el API en runtime)
COPY xsd /parent/xsd
COPY xsd-unsigned /parent/xsd-unsigned

# Build del API
WORKDIR /app/api
COPY api/package.json api/tsconfig.json ./
RUN npm install --ignore-scripts

COPY api/src ./src
RUN npm run build

# ============================================================================
# Stage 3: imagen runtime final
# ============================================================================
FROM node:20-alpine AS runtime
# libxml2-utils: xmllint para validación XSD
# openjdk17-jre-headless: requerido por facturacionelectronicapy-kude (JAR interno)
# tini: init process para manejo correcto de señales
RUN apk add --no-cache libxml2-utils openjdk17-jre-headless tini
ENV JAVA_PATH=/usr/lib/jvm/default-jvm/bin/java

# Motor padre (solo lo necesario para runtime)
WORKDIR /parent
COPY --from=parent-builder /parent/package.json /parent/package.json
COPY --from=parent-builder /parent/dist /parent/dist
COPY --from=api-builder /parent/xsd /parent/xsd
COPY --from=api-builder /parent/xsd-unsigned /parent/xsd-unsigned

# API compilada
WORKDIR /app/api
COPY api/package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=api-builder /app/api/dist ./dist
# Las migrations SQL no pasan por tsc — las copiamos aparte
COPY api/src/db/migrations ./dist/db/migrations

# Entrypoint script
COPY api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root
USER node

# Healthcheck básico
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/v1/health || exit 1

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["api"]
