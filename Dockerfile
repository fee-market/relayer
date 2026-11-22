# ─── build ───────────────────────────────────────────────────────────────────
# A fixed major, the one the tests run on: a rebuild still picks up its security patches, but never a new major
# by surprise (node:lts moves to the next major the day a new LTS line starts). Raise it on purpose, after testing.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund --loglevel=error || npm install --no-audit --no-fund --loglevel=error
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund --loglevel=error || npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY --from=build /app/dist ./dist
EXPOSE 8787
# Pass secrets via `docker run --env-file .env` — never bake keys into the image.
CMD ["node", "dist/index.js"]
