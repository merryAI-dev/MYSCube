FROM mcr.microsoft.com/playwright:v1.58.2-noble AS builder
WORKDIR /opt/axr
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/workbench/react-compiler-packages.mjs ./server/workbench/react-compiler-packages.mjs
COPY server/workbench/remote-runtime/build-packages.mjs ./server/workbench/remote-runtime/build-packages.mjs
RUN node server/workbench/remote-runtime/build-packages.mjs

FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /opt/axr
COPY --from=builder /opt/axr/node_modules/playwright ./node_modules/playwright
COPY --from=builder /opt/axr/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /opt/axr/server/workbench/remote-runtime/packages.json ./server/workbench/remote-runtime/packages.json
COPY server/workbench/remote-runtime/contract.mjs server/workbench/remote-runtime/worker.mjs ./server/workbench/remote-runtime/
ENV NODE_ENV=production HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 10001:10001
ENTRYPOINT ["node", "--max-old-space-size=96", "/opt/axr/server/workbench/remote-runtime/worker.mjs"]
