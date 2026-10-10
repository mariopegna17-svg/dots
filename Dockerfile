# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS web
WORKDIR /build/client
ENV NEXT_TELEMETRY_DISABLED=1 API_INTERNAL_URL=http://127.0.0.1:8000
COPY client/package.json client/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS whatsapp
WORKDIR /build/whatsapp
COPY whatsapp/package.json whatsapp/package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund
COPY whatsapp/*.mjs ./

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS api
WORKDIR /build/server
COPY server/requirements.lock ./
RUN --mount=type=secret,id=proxy_ca \
    python -m venv /opt/venv && \
    if [ -f /run/secrets/proxy_ca ]; then export PIP_CERT=/run/secrets/proxy_ca; fi; \
    /opt/venv/bin/pip install --no-cache-dir --require-hashes -r requirements.lock

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      cp /run/secrets/proxy_ca /usr/local/share/ca-certificates/build-proxy.crt && update-ca-certificates; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 1000 dots && useradd --uid 1000 --gid dots --create-home dots
WORKDIR /app
# Assemble one runtime layer; copying the growing runtime in separate layers
# consumes excessive space on development builders with the VFS storage driver.
RUN --mount=type=bind,from=web,source=/usr/local/bin/node,target=/mnt/node \
    --mount=type=bind,from=api,source=/opt/venv,target=/mnt/venv \
    --mount=type=bind,from=whatsapp,source=/build/whatsapp,target=/mnt/whatsapp \
    --mount=type=bind,from=web,source=/build/client,target=/mnt/client \
    --mount=type=bind,source=server/app,target=/mnt/server-app \
    --mount=type=bind,source=scripts/production.py,target=/mnt/production.py \
    cp /mnt/node /usr/local/bin/node && cp -a /mnt/venv /opt/venv && \
    mkdir -p /app/client/.next /app/server/app /app/scripts && \
    cp -a /mnt/whatsapp /app/whatsapp && \
    cp -a /mnt/client/.next/standalone/. /app/client/ && \
    cp -a /mnt/client/.next/static /app/client/.next/static && \
    cp -a /mnt/client/public /app/client/public && \
    cp -a /mnt/server-app/. /app/server/app/ && \
    cp /mnt/production.py /app/scripts/production.py && chown -R dots:dots /app
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production DATA_DIR=/home/dots/data \
    COMPUTER_PROVIDER=remote PORT=10000
USER dots
EXPOSE 10000
CMD ["python", "/app/scripts/production.py"]
