ALTER TABLE vivo_clips
  ADD COLUMN IF NOT EXISTS copy_marketing      JSONB,
  ADD COLUMN IF NOT EXISTS copy_variante       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS distribucion_estado TEXT,
  ADD COLUMN IF NOT EXISTS distribucion_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS distribucion_error  TEXT;
