# Dockerfile para FHIR Event Forwarder Mediator
FROM node:20-alpine

# 1) Crear usuario no‑root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# 2) Copiar package.json (no asumimos lockfile)
COPY package.json ./

# 3) Instalar sólo production deps
RUN npm install --production

# 4) Copiar el resto del código
COPY . .

# 5) Exponer puerto del Forwarder
EXPOSE 8003

# 6) Healthcheck para Docker/K8s
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8003/forwarder/_health || exit 1

# 7) Ejecutar como usuario no‑root
USER appuser

# 8) Comando de arranque
CMD ["npm", "start"]
