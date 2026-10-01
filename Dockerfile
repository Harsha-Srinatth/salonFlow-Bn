FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Own the files as the unprivileged `node` user the process runs as.
COPY --chown=node:node . .

USER node

EXPOSE 8080

# Readiness (not just "process is up"): fails when the database is unreachable or the pool is
# wedged, so an orchestrator restarts or stops routing to a broken instance.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
