# Multi-stage Dockerfile para facturacion-api.
#
# Build context: ROOT del repo (no el subdirectorio api/).
# Comando desde la raíz:
#   docker build -f api/Dockerfile -t facturacion-api .
#
# Layout en el container (replica el del repo):
#   /app/                       ← motor xmlgen
#   /app/package.json           (motor)
#   /app/dist/                  (motor compilado)
#   /app/xsd/                   (schemas oficiales SIFEN)
#   /app/xsd-unsigned/          (schemas pre-firma)
#   /app/api/                   ← commercial API
#   /app/api/package.json       (API, con "facturacionelectronicapy-xmlgen": "file:..")
#   /app/api/dist/              (API compilada)
#   /app/api/node_modules/      (incluye symlink a /app/ via file:..)
#
# Este layout es crítico porque:
#   1. `"file:.."` en api/package.json resuelve a /app, donde vive el motor
#   2. xsd-validator.ts usa resolve(__dirname, '../../..', 'xsd-unsigned/...')
#      que desde /app/api/dist/lib llega a /app/xsd-unsigned/

# ============================================================================
# Stage 1: build del motor xmlgen (repo padre)
# ============================================================================
FROM node:20-alpine AS parent-builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json tslint.json ./
COPY src ./src
# --include=dev: los builders SIEMPRE necesitan devDeps (typescript) aunque
# el entorno de build inyecte NODE_ENV=production (Coolify lo hace y sin esto
# `tsc` no existe — deploy fallido 2026-09-08)
RUN npm ci --ignore-scripts --include=dev
RUN npx tsc || npm run build

# ============================================================================
# Stage 2: build del API
# ============================================================================
FROM node:20-alpine AS api-builder
WORKDIR /app

# Motor xmlgen en /app/ (estructura que espera file:..)
# Incluye node_modules del motor porque sus runtime deps (xml2js) son
# requeridas cuando api/src importa facturacionelectronicapy-xmlgen
COPY --from=parent-builder /build/package.json /app/package.json
COPY --from=parent-builder /build/node_modules /app/node_modules
COPY --from=parent-builder /build/dist /app/dist
# XSDs para validación (pre/post firma)
COPY xsd /app/xsd
COPY xsd-unsigned /app/xsd-unsigned

# Strip lifecycle scripts del motor para evitar que npm trate de re-buildear
# la dist/ al resolver file:.. El dist/ ya está pre-compilado en parent-builder
# y las devDeps (typescript, tslint, etc.) no están instaladas en este stage.
RUN node -e "\
const fs=require('fs'); \
const p='/app/package.json'; \
const pkg=JSON.parse(fs.readFileSync(p,'utf8')); \
if(pkg.scripts){ delete pkg.scripts.prepare; delete pkg.scripts.prepublishOnly; delete pkg.scripts.preversion; delete pkg.scripts.version; delete pkg.scripts.postversion; } \
delete pkg.devDependencies; \
fs.writeFileSync(p, JSON.stringify(pkg,null,2));"

# Build del API en /app/api
WORKDIR /app/api
COPY api/package.json api/tsconfig.json ./
RUN npm install --ignore-scripts --include=dev

COPY api/src ./src
RUN npm run build

# ============================================================================
# Stage 3: imagen runtime final
# ============================================================================
FROM node:20-alpine AS runtime
# libxml2-utils: xmllint para validación XSD
# openjdk17-jre-headless: requerido por facturacionelectronicapy-kude (JAR interno)
# tini: init process para manejo correcto de señales
# tzdata: SIFEN valida las horas del XML y de la firma digital contra hora
# paraguaya — el container DEBE correr en America/Asuncion (TZ env var).
# openjdk17-jre COMPLETO (no headless) + fontconfig + ttf-dejavu: el JAR de
# KUDE usa JasperReports, que necesita libfontmanager/AWT para renderizar el
# PDF — con jre-headless falla con "UnsatisfiedLinkError: no fontmanager".
# curl: lo usa el healthcheck de Coolify dentro del container (sin él, el
# deploy queda "unhealthy" con el server andando perfecto)
RUN apk add --no-cache libxml2-utils openjdk17-jre fontconfig ttf-dejavu tini tzdata curl
ENV TZ=America/Asuncion
ENV JAVA_PATH=/usr/lib/jvm/default-jvm/bin/java

# Replicar layout del repo — copiamos desde api-builder que ya tiene el
# package.json del motor con los lifecycle scripts stripped + node_modules
COPY --from=api-builder /app/package.json /app/package.json
COPY --from=api-builder /app/node_modules /app/node_modules
COPY --from=api-builder /app/dist /app/dist
COPY --from=api-builder /app/xsd /app/xsd
COPY --from=api-builder /app/xsd-unsigned /app/xsd-unsigned

# API — instalamos solo deps de producción
WORKDIR /app/api
COPY api/package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=api-builder /app/api/dist ./dist
# Las migrations SQL no pasan por tsc — se copian aparte
COPY api/src/db/migrations ./dist/db/migrations

# Entrypoint
COPY api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Non-root (el user node viene en la imagen base)
RUN chown -R node:node /app
USER node

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/v1/health || exit 1

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["api"]
