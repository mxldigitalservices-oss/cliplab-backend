FROM mcr.microsoft.com/playwright:v1.49.1-jammy
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini fonts-dejavu-core python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir yt-dlp
COPY . /app
WORKDIR /app
RUN npm install --omit=dev
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "pip3 install -U --no-cache-dir yt-dlp >/dev/null 2>&1; exec node src/server.js"]
