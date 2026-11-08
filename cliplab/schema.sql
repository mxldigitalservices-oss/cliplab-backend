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
-- Metadatos ligeros del procesamiento (el video pesado nunca se guarda en la base).
ALTER TABLE clips ADD COLUMN IF NOT EXISTS palabras JSONB;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS tam_bytes BIGINT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS duracion_seg NUMERIC(10,2);
ALTER TABLE clips ADD COLUMN IF NOT EXISTS procesado_ms INT;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS con_subtitulos BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS con_marca BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS archivo_borrado_en TIMESTAMPTZ;
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

ALTER TABLE sesiones ADD COLUMN IF NOT EXISTS expira_en TIMESTAMPTZ;

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

-- Registro de uso de Gemini por rol (nunca se guarda la llave, solo el rol).
CREATE TABLE IF NOT EXISTS gemini_uso (
  id BIGSERIAL PRIMARY KEY,
  rol TEXT NOT NULL,
  modelo TEXT NOT NULL,
  http INT,
  ms INT,
  error TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gemini_uso_idx ON gemini_uso (rol, creado_en DESC);

-- =====================================================================
-- FASE 4: lotes controlados + reciclaje multi-ángulo (idempotente)
-- =====================================================================

-- Lote: agrupa elementos de trabajo (cortes o publicaciones de variantes).
CREATE TABLE IF NOT EXISTS lotes (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'general' CHECK (tipo IN ('general','cortes','reciclaje')),
  clip_id BIGINT REFERENCES clips(id) ON DELETE SET NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','corriendo','pausado','completado','con_errores','cancelado')),
  total INT NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciado_en TIMESTAMPTZ,
  terminado_en TIMESTAMPTZ,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lotes_estado_idx ON lotes (estado, id);

-- Ciclo: bloque de 10 a 20 elementos que se encola y se espera completo antes del siguiente.
CREATE TABLE IF NOT EXISTS lote_ciclos (
  id BIGSERIAL PRIMARY KEY,
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','completado','con_errores')),
  total INT NOT NULL,
  hechos INT NOT NULL DEFAULT 0,
  fallidos INT NOT NULL DEFAULT 0,
  iniciado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminado_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS lote_ciclos_estado_idx ON lote_ciclos (estado, terminado_en DESC);

-- Variante: nuevos metadatos (título, gancho, CTA...) sobre el MISMO video base, con su ventana de salida.
CREATE TABLE IF NOT EXISTS variantes (
  id BIGSERIAL PRIMARY KEY,
  clip_id BIGINT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  lote_id BIGINT NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  gancho TEXT,
  descripcion TEXT,
  cta TEXT,
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  angulo TEXT,
  origen TEXT NOT NULL DEFAULT 'ia' CHECK (origen IN ('ia','plantilla','manual')),
  plataformas TEXT[] NOT NULL,
  estado TEXT NOT NULL DEFAULT 'programada'
    CHECK (estado IN ('programada','en_cola','publicando','publicada','simulada','parcial','incierta','error','cancelada')),
  programada_para TIMESTAMPTZ NOT NULL,
  intentos INT NOT NULL DEFAULT 0,
  aplazos INT NOT NULL DEFAULT 0,
  error TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  iniciado_en TIMESTAMPTZ,
  publicado_en TIMESTAMPTZ,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS variantes_clip_idx ON variantes (clip_id);
CREATE INDEX IF NOT EXISTS variantes_lote_idx ON variantes (lote_id);
CREATE INDEX IF NOT EXISTS variantes_estado_idx ON variantes (estado, programada_para);

-- Elemento de lote: una unidad de trabajo (cortar un clip / publicar una variante).
CREATE TABLE IF NOT EXISTS lote_items (
  id BIGSERIAL PRIMARY KEY,
  lote_id BIGINT NOT NULL REFERENCES lotes(id) ON DELETE CASCADE,
  ciclo_id BIGINT REFERENCES lote_ciclos(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('cortar','publicar_variante')),
  clip_id BIGINT REFERENCES clips(id) ON DELETE CASCADE,
  variante_id BIGINT REFERENCES variantes(id) ON DELETE CASCADE,
  job_id BIGINT,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','encolado','corriendo','hecho','error','aplazado','cancelado')),
  intentos INT NOT NULL DEFAULT 0,
  detalle TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  encolado_en TIMESTAMPTZ,
  iniciado_en TIMESTAMPTZ,
  terminado_en TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS lote_items_lote_idx ON lote_items (lote_id, estado);
CREATE INDEX IF NOT EXISTS lote_items_cola_idx ON lote_items (estado, lote_id, id);
CREATE INDEX IF NOT EXISTS lote_items_ciclo_idx ON lote_items (ciclo_id);
CREATE INDEX IF NOT EXISTS lote_items_job_idx ON lote_items (job_id);
-- Una variante nunca tiene dos elementos vivos a la vez (evita publicar dos veces).
CREATE UNIQUE INDEX IF NOT EXISTS lote_items_variante_viva_idx ON lote_items (variante_id)
  WHERE variante_id IS NOT NULL AND estado IN ('pendiente','encolado','corriendo');

-- Bitácora de transiciones: qué pasó, cuándo y con qué estatus (para el monitoreo).
CREATE TABLE IF NOT EXISTS lote_eventos (
  id BIGSERIAL PRIMARY KEY,
  lote_id BIGINT,
  ciclo_id BIGINT,
  item_id BIGINT,
  variante_id BIGINT,
  evento TEXT NOT NULL,
  estado TEXT,
  detalle TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lote_eventos_lote_idx ON lote_eventos (lote_id, id DESC);
CREATE INDEX IF NOT EXISTS lote_eventos_variante_idx ON lote_eventos (variante_id, id DESC);

-- Las publicaciones de variantes se distinguen de las del clip base (que siguen con variante_id NULL).
ALTER TABLE publicaciones ADD COLUMN IF NOT EXISTS variante_id BIGINT REFERENCES variantes(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS pub_variante_idx ON publicaciones (variante_id, plataforma);
