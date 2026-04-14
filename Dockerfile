# ---- Build + Test Stage ----
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json vitest.config.ts ./
COPY src/ ./src/
COPY tests/ ./tests/

# Testes — se falharem, o build para e o deploy NÃO acontece
RUN npx vitest run

# Build TypeScript
RUN npx tsc

# ---- Production Stage ----
FROM node:20-bookworm-slim AS runner

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copia o JavaScript compilado
COPY --from=builder /app/dist ./dist

# Garante que o diretório de dados existe
RUN mkdir -p /app/data /app/data/photos

CMD ["node", "dist/index.js"]
