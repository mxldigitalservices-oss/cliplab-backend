#!/usr/bin/env bash
# ClipLab · PASO 1 — Higiene, seguridad y limpieza estructural
# Ejecutar en la RAÍZ del clon local de cliplab-backend. No hace push: tú revisas y publicas.
#   CONSOLIDAR=0 bash paso1-higiene.sh   → no sube cliplab/ a la raíz (se queda en cliplab/)
set -euo pipefail
CONSOLIDAR="${CONSOLIDAR:-1}"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "✖ Ejecuta esto dentro del repo."; exit 1; }
cd "$(git rev-parse --show-toplevel)"
[ -d cliplab/src ] || { echo "✖ No existe cliplab/src: ¿ya consolidaste o estás en otra carpeta?"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✖ Hay cambios sin commit. Haz commit o 'git stash' primero."; exit 1; }

commit() { git diff --cached --quiet || git commit -q -m "$1"; }
quitar() { git rm -r -q -f --ignore-unmatch -- "$@" >/dev/null 2>&1 || true; rm -rf -- "$@"; }

# ───────── FASE 0 · Respaldo y rama de trabajo ─────────
RAMA_ORIG="$(git rev-parse --abbrev-ref HEAD)"
git branch -f respaldo-pre-paso1 >/dev/null
BUNDLE="../cliplab-respaldo-$(date +%Y%m%d-%H%M).bundle"
git bundle create "$BUNDLE" --all >/dev/null 2>&1 && echo "✔ Respaldo completo: $BUNDLE (contiene secretos: guárdalo fuera de GitHub y bórralo tras la Fase 5)"
git switch -C paso1-higiene >/dev/null 2>&1

# ───────── FASE 1 · Seguridad: secretos, swaps y comprimidos ─────────
echo "▶ Fase 1: secretos y comprimidos"
# MXL Lab es otro proyecto (Flask/Mongo/Redis): se copia fuera del repo antes de borrarlo.
if [ -d "MXL Lab" ]; then
  DEST="../mxl-lab-extraido"
  if [ ! -e "$DEST" ]; then cp -a "MXL Lab" "$DEST"; rm -f "$DEST/mxl-lab.zip"; echo "✔ MXL Lab copiado a $DEST"; fi
fi
quitar cliplab/cookies cliplab/src/.cookies-repo.js.swp "MXL Lab"

# Barrido genérico: swaps de editor, respaldos y comprimidos que sigan versionados
while IFS= read -r -d '' f; do quitar "$f"; echo "  - $f"; done < <(
  git ls-files -z | grep -zE '(\.swp|\.swo|\.bak|\.old|\.orig|~|\.zip|\.tar|\.tgz|\.gz|\.7z|\.rar|\.DS_Store)$' || true)
git add -A; commit "chore(seguridad): retira cookies de sesión, swap de editor y comprimidos del repo"

# ───────── FASE 2 · Purga de scripts de consola, duplicados y heredados ─────────
echo "▶ Fase 2: purga de obsoletos"
quitar Dockerfile cookies-repo.js generar_audio_gtts.py requirements.txt cliplab-backend   # restos de la raíz (gTTS = servicio externo de Google)
quitar cliplab/FORCE_DEPLOY cliplab/test-conn.cjs cliplab/cookies-repo.js                  # marcadores y pruebas de consola
quitar cliplab/scripts/probar-gemini.js                                                    # prueba de llaves Gemini
quitar cliplab/public                                                                      # UI legacy: el servidor sirve src/public
quitar cliplab/src/analisis_marketing.js cliplab/src/auditoria_maestra.js cliplab/src/investigacion_profunda.js  # informes de consola, nadie los importa
quitar cliplab/src/public/js/panel.js                                                    # copia rota de src/panel.js (backend) dentro de public/, con parche CLAUDET
quitar cliplab/src/engine                                                                  # CommonJS dentro de un paquete ESM: no puede cargarse
if cmp -s cliplab/src/app.js cliplab/src/public/app.js; then quitar cliplab/src/app.js; else echo "  ! src/app.js difiere de src/public/app.js: NO se borra"; fi
( cd cliplab && node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.scripts["gemini:probar"];fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")' )
git add -A; commit "chore(limpieza): elimina scripts de consola obsoletos, duplicados y restos heredados"

# ───────── FASE 3 · Consolidar: cliplab/ sube a la raíz ─────────
APP="cliplab"
if [ "$CONSOLIDAR" = "1" ]; then
  echo "▶ Fase 3: consolidando estructura"
  shopt -s dotglob nullglob
  for f in cliplab/*; do
    b="$(basename "$f")"
    [ -e "$b" ] && { echo "✖ Colisión con $b en la raíz"; exit 1; }
    git mv "$f" "$b" 2>/dev/null || mv "$f" "$b"
  done
  rmdir cliplab 2>/dev/null || true
  shopt -u dotglob nullglob
  APP="."
  git add -A; commit "refactor(estructura): sube cliplab/ a la raíz del repositorio"
fi

# ───────── FASE 4 · .gitignore, .dockerignore y base de directorios ─────────
echo "▶ Fase 4: ignorados y directorios base"
cd "$APP"
cat > .gitignore << 'EOF'
# Dependencias
node_modules/

# Secretos y sesiones: NUNCA al repositorio
.env
.env.*
!.env.example
cookies/
cookies*.txt
*cookies*.json
sesion-*.json
*.pem
*.key

# Datos generados por el motor
/data/*
!/data/.gitkeep
/clips/*
!/clips/.gitkeep
*.mp4
*.mp3
*.vtt

# Editor / sistema
*.swp
*.swo
*~
.DS_Store
Thumbs.db

# Respaldos y comprimidos
*.bak
*.old
*.orig
*.zip
*.tar
*.tgz
*.gz
*.7z
*.rar

# Logs
*.log
npm-debug.log*
EOF
cat > .dockerignore << 'EOF'
.git
node_modules
.env
.env.*
cookies
data
clips
tests
docs
*.md
*.log
EOF
mkdir -p data clips assets docs scripts
touch data/.gitkeep clips/.gitkeep assets/.gitkeep
git add -A -f .gitignore .dockerignore data/.gitkeep clips/.gitkeep assets/.gitkeep
git add -A; commit "chore: .gitignore y .dockerignore endurecidos; base de directorios"

# ───────── VERIFICACIÓN ─────────
echo; echo "═══ VERIFICACIÓN ═══"
node --input-type=module -e '
import fs from "node:fs"; import path from "node:path";
const files=[], bad=[];
const walk=d=>{ if(!fs.existsSync(d))return; for(const e of fs.readdirSync(d,{withFileTypes:true})){ const p=path.join(d,e.name);
  if(e.isDirectory()){ if(e.name!=="node_modules") walk(p); } else if(/\.(m?js|cjs)$/.test(e.name)) files.push(p); } };
["src","tests","scripts"].forEach(walk);
const re=/(?:from\s*|import\s*\(\s*|import\s+)["'"'"'](\.{1,2}\/[^"'"'"']+)["'"'"']/g;
for(const f of files){ const s=fs.readFileSync(f,"utf8"); let m; while((m=re.exec(s))){ if(!fs.existsSync(path.resolve(path.dirname(f),m[1]))) bad.push(f+" → "+m[1]); } }
const idx="src/public/index.html";
if(fs.existsSync(idx)) for(const m of fs.readFileSync(idx,"utf8").matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)) if(!fs.existsSync(path.join("src/public",m[1]))) bad.push(idx+" → /"+m[1]);
console.log(bad.length ? "✖ Referencias rotas:\n  "+bad.join("\n  ") : "✔ Imports y assets del panel sin referencias rotas ("+files.length+" archivos revisados)");
process.exit(bad.length?1:0);'
echo "— Rastreados que no deberían estarlo (debe salir vacío):"
git ls-files | grep -E '(^|/)cookies/|\.swp$|\.zip$|\.env$' || echo "  (ninguno)"
echo "— Patrones de secretos en el código (debe salir vacío):"
git grep -nIE '(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN (RSA |EC )?PRIVATE KEY)' -- . ':!package-lock.json' || echo "  (ninguno)"
echo; echo "— Referencias a Gemini que quedan (checklist del PASO 2: reemplazo por motor local):"
git grep -cIiE 'gemini|generativelanguage' -- . ':!package-lock.json' | sed 's/^/  /' || true
echo; echo "— Estructura final:"; git ls-files | cut -d/ -f1-2 | sort -u | head -60
echo; echo "✔ Listo en la rama paso1-higiene. Revisa: git diff --stat respaldo-pre-paso1..HEAD"
echo "  Publicar:  git switch $RAMA_ORIG && git merge --ff-only paso1-higiene   (push solo tras la Fase 5)"
echo "  Deshacer:  git switch $RAMA_ORIG && git branch -D paso1-higiene"
