FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json tsup.config.ts ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright-core install --with-deps chromium

COPY --from=builder /app/dist ./dist
COPY README.md ./

ENV NODE_ENV=production
ENV UI_LEVEL_DOCKER=1

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["doctor"]
