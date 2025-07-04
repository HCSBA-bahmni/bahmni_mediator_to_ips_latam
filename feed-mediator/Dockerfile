FROM python:3.11-alpine

WORKDIR /app

# Instala dependencias del sistema necesarias para pip (si alguna librería requiere compilación)
RUN apk add --no-cache gcc musl-dev libffi-dev

# Copia los archivos de la app al contenedor
COPY . .

# Instala las dependencias de Python
RUN pip install --no-cache-dir -r requirements.txt

# Comando de inicio (ajusta si tu archivo principal cambia de nombre)
CMD ["python", "feed-watcher.py"]
