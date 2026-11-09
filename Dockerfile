FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV NODE_ENV=production \
    DATA_DIR=/data \
    YTDLP_BIN=/usr/local/bin/yt-dlp

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY sql ./sql
COPY src ./src
COPY public ./public

CMD ["node", "src/server.js"]
