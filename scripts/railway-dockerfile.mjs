import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const f = 'Dockerfile';
const s = readFileSync(f, 'utf8');
if (/whisper/i.test(s)) { console.log('El Dockerfile ya menciona whisper. Nada que hacer.'); process.exit(0); }

const froms = s.match(/^FROM\s+/gm) || [];
const fromRe = /^FROM\s+mcr\.microsoft\.com\/playwright[^\n]*$/m;
if (froms.length !== 1 || !fromRe.test(s)) {
  console.error('El Dockerfile no tiene exactamente un FROM de Playwright. No se modificó nada.');
  process.exit(1);
}

const etapa = `# --- Motor local: compila whisper.cpp sobre Ubuntu 22.04 (misma glibc que la imagen final) ---
FROM ubuntu:22.04 AS whisper
ARG WHISPER_MODEL_SIZE=base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \\
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /opt/whisper.cpp
RUN cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \\
    && cmake --build build -j2 --config Release
RUN sh ./models/download-ggml-model.sh \${WHISPER_MODEL_SIZE}

`;

const bloque = `
# --- Motor local: ffmpeg, fuentes para libass, whisper-cli y modelo ---
ARG WHISPER_MODEL_SIZE=base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 fontconfig fonts-montserrat fonts-dejavu-core \\
    && fc-cache -f && rm -rf /var/lib/apt/lists/*
COPY --from=whisper /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /opt/whisper.cpp/models/ggml-\${WHISPER_MODEL_SIZE}.bin /models/model.bin
ENV WHISPER_BIN=whisper-cli WHISPER_MODEL=/models/model.bin WHISPER_LANG=es SUB_FONT=Montserrat
`;

copyFileSync(f, 'Dockerfile.bak-railway');
const nuevo = etapa + s.replace(fromRe, (m) => m + '\n' + bloque);
writeFileSync(f, nuevo);
console.log('Dockerfile actualizado (copia en Dockerfile.bak-railway).');
