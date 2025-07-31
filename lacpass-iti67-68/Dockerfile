# 1) Usa una versión ligera y moderna de Node.js
FROM node:20-alpine

# 2) Crea un usuario no-root (opcional pero recomendable)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# 3) Establece el directorio de trabajo
WORKDIR /app

# 4) Copia primero sólo package.json y package-lock.json para aprovechar la cache
COPY package.json package-lock.json ./

# 5) Instala dependencias de producción
RUN npm ci --only=production

# 6) Copia el resto del código de la aplicación
COPY . .

# 7) Expose the port where the mediator listens
EXPOSE 8006

# 8) Define a healthcheck para orquestadores
HEALTHCHECK --interval=30s --timeout=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:8006/lacpass/_health || exit 1

# 9) Cambia a usuario no-root para mayor seguridad
USER appuser

# 10) Comando de arranque
CMD ["npm", "start"]
