# Shoggoth runtime image: daemon runs as `shoggoth` (UID 900) after entrypoint; agent worker pool `agent` (UID 901).
# Entrypoint (root) creates layout, fixes volume perms, then setpriv drops to shoggoth while retaining spawn caps.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
RUN npm ci
COPY tsconfig.base.json ./
# `npm run build` = authn `node-gyp-build` + workspace `tsc --noEmit` (no JS emit). Runtime uses `tsx` + `src/*.ts`; keep `tsx` in root `dependencies` after prune.
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN groupadd --system --gid 900 shoggoth \
  && useradd --system --uid 900 --gid shoggoth --home-dir /var/lib/shoggoth --shell /usr/sbin/nologin shoggoth \
  && groupadd --system --gid 901 agent \
  && useradd --system --uid 901 --gid agent --home-dir /var/lib/shoggoth/agent-stub --shell /usr/sbin/nologin agent

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./
COPY scripts ./scripts
COPY templates/agent-workspace /app/templates/agent-workspace
COPY migrations /app/migrations
# Layered JSON defaults (same as repo config/example-overlay). Baked in so bind mounts from the daemon host are not required.
COPY config/example-overlay/ /etc/shoggoth/config.d/
# Readiness compose exec smoke scripts (tests/readiness-compose.test.mjs); avoid bind-mounting ./tests (daemon path mismatch on some hosts).
COPY tests/scripts /app/tests/scripts
COPY docker/entrypoint.sh /usr/local/bin/shoggoth-entrypoint.sh
COPY docker/shoggoth-wrapper.sh /usr/local/bin/shoggoth
RUN chmod 0755 /usr/local/bin/shoggoth-entrypoint.sh /usr/local/bin/shoggoth

ENV NODE_ENV=production
USER root
ENTRYPOINT ["/usr/local/bin/shoggoth-entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "packages/daemon/src/index.ts"]
