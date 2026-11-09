CREATE TABLE IF NOT EXISTS trabajos_cola (
  id            SERIAL PRIMARY KEY,
  url           TEXT        NOT NULL,
  estado        TEXT        NOT NULL DEFAULT 'pendiente'
                CHECK (estado IN ('pendiente','procesando','completado','error')),
  intentos      INTEGER     NOT NULL DEFAULT 0,
  error         TEXT,
  video_id      TEXT,
  video_titulo  TEXT,
  duracion      NUMERIC(10,2),
  palabras_clave JSONB      NOT NULL DEFAULT '[]'::jsonb,
  resumen       TEXT,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vivo_clips (
  id           SERIAL PRIMARY KEY,
  trabajo_id   INTEGER REFERENCES trabajos_cola(id) ON DELETE CASCADE,
  titulo       TEXT        NOT NULL,
  estado       TEXT        NOT NULL DEFAULT 'pendiente'
               CHECK (estado IN ('pendiente','procesando','completado','error')),
  marca_tiempo NUMERIC(10,2) NOT NULL DEFAULT 0,
  marca_fin    NUMERIC(10,2),
  resumen      TEXT,
  archivo      TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cola_estado ON trabajos_cola (estado, id);
CREATE INDEX IF NOT EXISTS idx_clips_trabajo ON vivo_clips (trabajo_id);
CREATE INDEX IF NOT EXISTS idx_clips_created ON vivo_clips (created_at DESC);
