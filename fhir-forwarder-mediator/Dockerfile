# 1) Imagen base ligera de Node
FROM node:20-alpine

# 2) Crear un usuario no‑root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 3) Directorio de trabajo
WORKDIR /app

# 4) Copiar package.json y lock para aprovechar cache
COPY package.json package-lock.json ./

# 5) Instalar solo dependencias de producción
RUN npm ci --only=production

# 6) Copiar el resto del código
COPY . .

# 7) Exponer el puerto donde escucha tu forwarder
EXPOSE 8003

# 8) Definir un healthcheck para orquestadores
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8003/_health || exit 1

# 9) Ejecutar como usuario no-root
USER appuser

# 10) Comando de arranque
CMD ["npm", "start"]
