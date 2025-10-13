# Dockerfile (FHIR Event Forwarder Mediator)
FROM node:20-alpine

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copiar definición y deps
COPY package.json ./

# Instalar solo producción
RUN npm install --production

# Copiar código
COPY . .

# Precrear seen.json y dar permisos
RUN touch seen.json && chown appuser:appgroup seen.json

EXPOSE 8014

HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8014/forwardercondition/_health || exit 1

USER appuser

CMD ["npm", "start"]
