FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server/bff ./server/bff
COPY server/qa-authority ./server/qa-authority
ENV NODE_ENV=production
USER node
CMD ["node", "server/qa-authority/server.mjs"]
