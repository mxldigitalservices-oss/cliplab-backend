FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 6 --retry-all-errors --retry-delay 3 -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x /usr/local/bin/yt-dlp
COPY . /tmp/ctx
RUN mkdir -p /app && if [ -d /tmp/ctx/cliplab ]; then cp -a /tmp/ctx/cliplab/. /app/; else cp -a /tmp/ctx/. /app/; fi && rm -rf /tmp/ctx
WORKDIR /app
RUN npm install --omit=dev
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
