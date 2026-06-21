# syntax=docker/dockerfile:1

# ---- Stage 1: build (install deps, compile TS -> dist) ----
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so the npm ci layer is cached across source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy sources and compile with tsc.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules retains tsx so `npm run migrate` (tsx src/scripts/migrate.ts) works
# under the docker-compose `migrate && start` command.
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

EXPOSE 8787
CMD ["node", "dist/index.js"]
