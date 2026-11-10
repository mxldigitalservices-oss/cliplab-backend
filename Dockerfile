# --- Motor local: compila whisper.cpp sobre Ubuntu 22.04 (misma glibc que la imagen final) ---
FROM ubuntu:22.04 AS whisper
ARG WHISPER_MODEL_SIZE=base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /opt/whisper.cpp
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
    && cmake --build build -j2 --config Release
RUN sh ./models/download-ggml-model.sh ${WHISPER_MODEL_SIZE}

FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# --- Motor local: ffmpeg, fuentes para libass, whisper-cli y modelo ---
ARG WHISPER_MODEL_SIZE=base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 fontconfig fonts-montserrat fonts-dejavu-core \
    && fc-cache -f && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper.cpp/models/ggml-${WHISPER_MODEL_SIZE}.bin /models/model.bin
ENV WHISPER_BIN=whisper-cli WHISPER_MODEL=/models/model.bin WHISPER_LANG=es SUB_FONT=Montserrat

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini fonts-dejavu-core python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir yt-dlp
COPY . /tmp/ctx
RUN mkdir -p /app && if [ -d /tmp/ctx/cliplab ]; then cp -a /tmp/ctx/cliplab/. /app/; else cp -a /tmp/ctx/. /app/; fi && rm -rf /tmp/ctx
WORKDIR /app
RUN npm install --omit=dev
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "pip3 install -U --no-cache-dir yt-dlp >/dev/null 2>&1; exec node src/server.js"]
