# ---- TAR System (Node.js 20 + Express) ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Dependensi dulu (cache layer)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .
RUN apk add --no-cache su-exec \
 && chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /data/uploads && chown -R node:node /app /data

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
