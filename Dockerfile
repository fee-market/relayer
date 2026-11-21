# ─── build ───────────────────────────────────────────────────────────────────
# node:lts tracks the current Active LTS and picks up security patches on rebuild.
FROM node:lts-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:lts-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error || npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY --from=build /app/dist ./dist
EXPOSE 8787
# Pass secrets via `docker run --env-file .env` — never bake keys into the image.
CMD ["node", "dist/index.js"]
