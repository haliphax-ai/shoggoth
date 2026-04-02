# Shoggoth runtime image: daemon runs as `shoggoth` (default UID 1000) after entrypoint; agent worker pool `agent` (default UID 900).
# SHOGGOTH_UID defaults to 1000 (common host user) so the host user has daemon-level file access by default.
# AGENT_UID defaults to 900 to reduce collision risk with real host users.
# Entrypoint (root) creates layout, fixes volume perms, then setpriv drops to shoggoth while retaining spawn caps.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build && npm prune --omit=dev

# Extract short git commit hash from build context
COPY .git/HEAD ./.git-meta/HEAD
COPY .git/refs/ ./.git-meta/refs/
COPY .git/packed-ref[s] ./.git-meta/
RUN HASH=$(cat .git-meta/HEAD); \
    if echo "$HASH" | grep -q "^ref:"; then \
      REF=$(echo "$HASH" | sed 's/ref: //'); \
      if [ -f ".git-meta/$REF" ]; then \
        HASH=$(cat ".git-meta/$REF"); \
      elif [ -f ".git-meta/packed-refs" ]; then \
        HASH=$(grep " $REF\$" ".git-meta/packed-refs" | cut -d' ' -f1 || echo "unknown"); \
      else \
        HASH="unknown"; \
      fi; \
    fi; \
    printf "%.7s" "$HASH" > /app/.git-hash

FROM node:22-bookworm-slim
ARG SHOGGOTH_UID=1000
ARG AGENT_UID=900
RUN groupadd --system --gid ${SHOGGOTH_UID} shoggoth \
  && useradd --system --uid ${SHOGGOTH_UID} --gid shoggoth --home-dir /var/lib/shoggoth --shell /usr/sbin/nologin shoggoth \
  && groupadd --system --gid ${AGENT_UID} agent \
  && useradd --system --uid ${AGENT_UID} --gid agent --home-dir /var/lib/shoggoth/agent-stub --shell /usr/sbin/nologin agent

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./
COPY --from=build /app/.git-hash ./.git-hash
COPY scripts ./scripts
COPY templates/agent-workspace /app/templates/agent-workspace
COPY migrations /app/migrations
COPY docs /app/docs
# Ensure all app files are world-readable (build context from agent workspaces may have restrictive ACL-derived permissions)
RUN chmod -R a+rX /app
COPY docker/entrypoint.sh /usr/local/bin/shoggoth-entrypoint.sh
COPY docker/shoggoth-wrapper.sh /usr/local/bin/shoggoth
RUN chmod 0755 /usr/local/bin/shoggoth-entrypoint.sh /usr/local/bin/shoggoth

ENV NODE_ENV=production
USER root
ENTRYPOINT ["/usr/local/bin/shoggoth-entrypoint.sh"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node --import tsx/esm packages/cli/src/cli.ts system health || exit 1
CMD ["node", "--import", "tsx/esm", "packages/daemon/src/index.ts"]
