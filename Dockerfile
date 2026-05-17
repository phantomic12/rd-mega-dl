FROM node:22-slim

WORKDIR /app

# better-sqlite3 v12 ships prebuilt binaries for linux-x64 (glibc) — no build tools needed
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js worker.js db.js ./
COPY public/ ./public/

# Create data dir for SQLite
RUN mkdir -p /app/data /app/downloads
VOLUME ["/app/data", "/app/downloads"]

EXPOSE 3000

ENV DB_PATH=/app/data/downloads.db
ENV RD_API_KEY=""

CMD ["node", "index.js"]
