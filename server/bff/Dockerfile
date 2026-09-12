FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY policies ./policies
COPY src/app/policies ./src/app/policies

ENV NODE_ENV=production
ENV BFF_WORKERS_ENABLED=false
ENV BFF_SCHEDULER_OWNER=disabled
ENV BFF_HOST=0.0.0.0
ENV BFF_PORT=8080
ENV BFF_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173

EXPOSE 8080

CMD ["node", "server/bff/server.mjs"]
