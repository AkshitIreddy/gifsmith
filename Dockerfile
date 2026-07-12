# Hermetic gifsmith rendering in a container — Chromium + ffmpeg + fonts, no
# host browser needed. Renders are already isolated (a throwaway profile); this
# takes it further, giving a reproducible, host-independent sandbox for CI.
#
# Build:  docker build -t gifsmith .
# Run:    docker run --rm -v "$PWD:/work" -w /work gifsmith \
#           gifsmith render demo.config.mjs
#
# Inside a container Chromium's own sandbox can't initialize, so pass
# `chromiumSandbox: false` in your target (or `--no-sandbox` args). gifsmith
# still renders in an isolated profile regardless.
FROM node:20-slim

# Chromium + ffmpeg + a font that covers emoji/CJK so demos render correctly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    GIFSMITH_NO_SANDBOX=1

# Install gifsmith globally so the `gifsmith` CLI is on PATH.
RUN npm install -g gifsmith

WORKDIR /work
ENTRYPOINT []
CMD ["gifsmith", "doctor"]
