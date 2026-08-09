FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node app.js constants.js helpers.js repository.js validation.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node views ./views
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "app.js"]
