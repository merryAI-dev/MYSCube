FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/workbench/package.json server/workbench/package-lock.json ./server/workbench/
RUN npm ci --ignore-scripts --prefix server/workbench
COPY workbench ./workbench
COPY shared ./shared
COPY src/app/components/product-operations/html-preview ./src/app/components/product-operations/html-preview
COPY tsconfig.json ./
COPY server/workbench/deployment/build-metadata.mjs ./server/workbench/deployment/build-metadata.mjs
ARG WORKBENCH_RELEASE_SHA
ARG WORKBENCH_BUILD_CLASS
ARG VITE_WORKBENCH_AUTH_PROJECT_ID
ARG VITE_WORKBENCH_AUTH_API_KEY
ARG VITE_WORKBENCH_AUTH_DOMAIN
ENV VITE_WORKBENCH_AUTH_PROJECT_ID=$VITE_WORKBENCH_AUTH_PROJECT_ID VITE_WORKBENCH_AUTH_API_KEY=$VITE_WORKBENCH_AUTH_API_KEY VITE_WORKBENCH_AUTH_DOMAIN=$VITE_WORKBENCH_AUTH_DOMAIN
RUN WORKBENCH_RELEASE_SHA=$WORKBENCH_RELEASE_SHA WORKBENCH_BUILD_CLASS=$WORKBENCH_BUILD_CLASS node server/workbench/deployment/build-metadata.mjs && npm run workbench:build

FROM node:24-bookworm-slim
WORKDIR /app
ARG WORKBENCH_RELEASE_SHA
ARG WORKBENCH_BUILD_CLASS
LABEL org.opencontainers.image.revision=$WORKBENCH_RELEASE_SHA io.myscube.workbench.classification=$WORKBENCH_BUILD_CLASS
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/workbench-build.json ./workbench-build.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/workbench/node_modules ./server/workbench/node_modules
COPY --from=build /app/dist-workbench ./dist-workbench
COPY package.json package-lock.json ./
COPY server/workbench ./server/workbench
COPY server/bff ./server/bff
COPY server/mcp ./server/mcp
COPY src/app/platform ./src/app/platform
COPY shared ./shared
COPY policies ./policies
USER node
EXPOSE 8080
CMD ["node", "server/workbench/server.mjs"]
