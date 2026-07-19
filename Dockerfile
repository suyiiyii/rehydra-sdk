FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --omit=optional

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN groupadd --system rehydra \
    && useradd --system --gid rehydra --create-home rehydra

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER rehydra

EXPOSE 8787

# The upstream URL is supplied at runtime via REHYDRA_UPSTREAM.
CMD ["node", "dist/cli/bin.js", "proxy", "auto", "--host", "0.0.0.0", "--port", "8787", "--ner", "disabled", "--types", "API_KEY", "--secrets", "--quiet"]
