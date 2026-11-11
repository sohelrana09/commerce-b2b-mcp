# commerce-b2b-mcp: the MCP server over Streamable HTTP with OAuth, against the mock store.
#
#   docker build -t commerce-b2b-mcp .
#   docker run --rm commerce-b2b-mcp demo                       # the RFQ demo, then exit
#   docker run --rm -p 8080:8080 -e COMMERCE_MOCK_PASSWORD='choose-a-demo-password' commerce-b2b-mcp
#                                                               # MCP endpoint: http://localhost:8080/mcp
#
# For a real store, set COMMERCE_BACKEND=paas and the PaaS settings from the README,
# and put TLS in front with COMMERCE_PUBLIC_URL set to the https origin.

# Pinned by digest; Dependabot proposes updates. To refresh by hand: docker buildx imagetools inspect node:22-alpine
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
ENV NODE_ENV=production \
    COMMERCE_BACKEND=mock \
    COMMERCE_TRANSPORT=http \
    COMMERCE_HTTP_HOST=0.0.0.0 \
    COMMERCE_HTTP_PORT=8080 \
    COMMERCE_PUBLIC_URL=http://localhost:8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "dist/index.js"]
