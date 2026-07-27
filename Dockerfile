# Runs the Wave MCP server over stdio in a container.
#
# Intended for hosts that launch an MCP server as a container rather than a
# local process. Pass credentials at run time; never bake them into an image:
#
#   docker build -t wave-mcp-server .
#   docker run --rm -i -e WAVE_ACCESS_TOKEN=... wave-mcp-server
#
# -i matters: the server speaks JSON-RPC on stdin/stdout.

FROM node:22-alpine

WORKDIR /app

# Install production dependencies against the lockfile first, so a source-only
# change does not invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY index.js ./
COPY scripts/ ./scripts/

# Drop to the unprivileged user the base image already provides.
USER node

# The container has no agent config files to read, so skip that lookup and
# rely on the environment alone.
ENV WAVE_DISABLE_AGENT_CONFIG_FALLBACK=1

ENTRYPOINT ["node", "/app/index.js"]
