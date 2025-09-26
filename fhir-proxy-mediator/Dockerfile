# Usa una versión ligera y moderna de Node
FROM node:20-alpine

# Crea un usuario no-root (opcional pero recomendable)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# 1) Copia primero sólo package.json + lock para aprovechar el cache de npm
COPY package.json package-lock.json ./

# 2) Instala dependencias de producción
RUN npm ci --only=production

# 3) Copia el resto del código
COPY . .

# 4) Expone el puerto donde corre tu proxy
EXPOSE 7000

# 5) Define un healthcheck para orquestadores
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:7000/proxy/_health || exit 1

# 6) Cambia a usuario no-root
USER appuser

# 7) Comando de arranque
CMD ["npm", "start"]
