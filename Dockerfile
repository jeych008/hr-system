FROM node:22-bookworm-slim

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip fonts-noto-cjk fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN test -f package-lock.json || (echo "package-lock.json is required for production builds" >&2; exit 1)
RUN npm ci --omit=dev

COPY requirements-pdf.txt ./
RUN pip3 install --no-cache-dir --break-system-packages \
  --index-url https://mirrors.aliyun.com/pypi/simple \
  -r requirements-pdf.txt

COPY backend ./backend
COPY frontend ./frontend

USER node
EXPOSE 5177
CMD ["node", "backend/server.js"]
