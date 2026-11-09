FROM mcr.microsoft.com/playwright:v1.49.1-jammy
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common curl ca-certificates tini fonts-dejavu-core ffmpeg && \
    add-apt-repository ppa:deadsnakes/ppa && apt-get update && \
    apt-get install -y --no-install-recommends python3.11 python3.11-dev && \
    update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11 && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --upgrade pip && pip3 install --no-cache-dir --upgrade yt-dlp
COPY . /app
WORKDIR /app
RUN npm install --omit=dev
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "pip3 install -U --no-cache-dir yt-dlp >/dev/null 2>&1; exec node src/server.js"]
