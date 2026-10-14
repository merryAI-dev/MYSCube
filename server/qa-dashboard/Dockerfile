FROM node:24-slim
WORKDIR /app/qa-dashboard
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY operations.mjs server.mjs user-entry.mjs stages.mjs index.html ./
COPY shared-qa ../qa-shared
ENV NODE_ENV=production
USER node
CMD ["node","server.mjs"]
