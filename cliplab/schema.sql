DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clips' AND column_name = 'youtube_url') THEN
    DROP TABLE IF EXISTS publicaciones, clips CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS fuentes (
  id BIGSERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  video_id TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  error TEXT,
  plataformas TEXT[] NOT NULL DEFAULT '{}',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clips (
  id BIGSERIAL PRIMARY KEY,
  fuente_id BIGINT NOT NULL REFERENCES fuentes(id) ON DELETE CASCADE,
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  titulo TEXT NOT NULL,
  gancho TEXT,
  descripcion TEXT,
  cta TEXT,
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  inicio_seg NUMERIC(10,2) NOT NULL,
  fin_seg NUMERIC(10,2) NOT NULL,
  categoria TEXT,
  angulo TEXT,
  puntaje SMALLINT,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  archivo TEXT,
  error TEXT,
  auto_plataformas TEXT[] NOT NULL DEFAULT '{}',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clips_token_idx ON clips (token);
CREATE INDEX IF NOT EXISTS clips_fuente_idx ON clips (fuente_id);

CREATE TABLE IF NOT EXISTS publicaciones (
  id BIGSERIAL PRIMARY KEY,
  clip_id BIGINT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  plataforma TEXT NOT NULL,
  estado TEXT NOT NULL,
  detalle TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pub_clip_idx ON publicaciones (clip_id, plataforma);

CREATE TABLE IF NOT EXISTS sesiones (
  plataforma TEXT PRIMARY KEY,
  datos TEXT NOT NULL,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_test TIMESTAMPTZ,
  test_ok BOOLEAN,
  test_detalle TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  ref_id BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  estado TEXT NOT NULL DEFAULT 'pendiente',
  intentos INT NOT NULL DEFAULT 0,
  max_intentos INT NOT NULL DEFAULT 3,
  ejecutar_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciado_en TIMESTAMPTZ,
  error TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_cola_idx ON jobs (estado, ejecutar_en);
