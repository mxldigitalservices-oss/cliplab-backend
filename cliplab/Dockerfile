FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini fonts-dejavu-core \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY schema.sql ./
COPY assets ./assets
COPY src ./src
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
