FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
COPY README.md SECURITY.md LICENSE KUKLABS_IDENTITY.md ./

RUN mkdir -p /app/data/repos /app/data/tmp \
  && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "server.mjs"]
