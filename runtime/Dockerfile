FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && usermod -l pwuser -d /home/pwuser -m node

RUN apt-get update \
    && apt-get install -y --no-install-recommends libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/open-dots-computer

COPY package.json package-lock.json ./
ARG PROXY_CA_SHA256=none
RUN --mount=type=secret,id=proxy_ca \
    test -n "$PROXY_CA_SHA256" \
    && if [ -f /run/secrets/proxy_ca ]; then cp /run/secrets/proxy_ca environment-ca-bundle.pem; fi
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --ignore-scripts

COPY driver.mjs trust.mjs ./
RUN mkdir -p /workspace \
    && chown -R pwuser:node /opt/open-dots-computer /workspace

USER pwuser
ENV PORT=3000
ENV WORKSPACE=/workspace
EXPOSE 3000

ENTRYPOINT ["node", "/opt/open-dots-computer/driver.mjs"]
