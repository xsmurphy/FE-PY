# ============ build stage ============
FROM node:20-alpine AS builder
WORKDIR /app

# Copiar el motor xmlgen (referenciado como file:.. en package.json)
COPY --link package.json ./parent/package.json
COPY --link dist ./parent/dist
COPY --link xsd ./parent/xsd
COPY --link xsd-unsigned ./parent/xsd-unsigned

WORKDIR /app/api
COPY --link api/package.json api/tsconfig.json ./
RUN npm install --ignore-scripts

COPY --link api/src ./src
RUN npm run build

# ============ runtime stage ============
FROM node:20-alpine AS runtime
RUN apk add --no-cache libxml2-utils tini
WORKDIR /app

COPY --from=builder /app/parent /app/parent
WORKDIR /app/api
COPY --from=builder /app/api/package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/api/dist ./dist

EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
