# ---------- Etapa 1: herramientas (se descarta, no entra en la imagen final) ----------
FROM debian:bookworm-slim AS herramientas

ARG WHISPER_VERSION=v1.7.6
ARG WHISPER_MODEL_NAME=base-q5_1
ARG GGML_AVX2=ON
ARG YTDLP_CACHE_BUST=0

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch ${WHISPER_VERSION} https://github.com/ggml-org/whisper.cpp.git

WORKDIR /build/whisper.cpp
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF \
      -DGGML_OPENMP=OFF \
      -DGGML_AVX2=${GGML_AVX2} \
      -DGGML_FMA=${GGML_AVX2} \
      -DGGML_F16C=${GGML_AVX2} \
      -DWHISPER_BUILD_TESTS=OFF \
      -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build build --config Release -j 2 --target whisper-cli \
    && sh ./models/download-ggml-model.sh ${WHISPER_MODEL_NAME}

RUN mkdir -p /opt/whisper /opt/fonts \
    && cp build/bin/whisper-cli /opt/whisper/whisper-cli \
    && strip /opt/whisper/whisper-cli \
    && cp models/ggml-${WHISPER_MODEL_NAME}.bin /opt/whisper/modelo.bin \
    && curl -fsSL -o /opt/fonts/Anton-Regular.ttf https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf

RUN echo "yt-dlp refresh ${YTDLP_CACHE_BUST}" \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp

# ---------- Etapa 2: imagen final ----------
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=herramientas /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=herramientas /opt/whisper /opt/whisper
COPY --from=herramientas /opt/fonts /app/fonts

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    TMP_DIR=/tmp/cliplab \
    CPU_THREADS=2 \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    WHISPER_PATH=/opt/whisper/whisper-cli \
    WHISPER_MODEL=/opt/whisper/modelo.bin

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
