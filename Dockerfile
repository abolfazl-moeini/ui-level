FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist
COPY README.md ./

ENV NODE_ENV=production
ENV UI_LEVEL_DOCKER=1

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["doctor"]
