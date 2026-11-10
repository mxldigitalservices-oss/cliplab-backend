#!/bin/sh
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT=audit-integracion.txt
EX="--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out --exclude-dir=media --exclude=audit-integracion.txt --exclude=audit-integracion.sh --exclude=package-lock.json"
SRC="--include=*.js --include=*.mjs --include=*.cjs --include=*.ts --include=*.html"
{
echo "== RAMA / ESTADO =="
git branch --show-current 2>/dev/null
git status --short 2>/dev/null | head -20

echo; echo "== ARBOL (prof. 3) =="
find . -maxdepth 3 -not -path './node_modules*' -not -path './.git*' -not -path './out*' -not -path './media*' | sort | head -120

echo; echo "== package.json =="
for f in $(find . -maxdepth 3 -name package.json -not -path '*/node_modules/*'); do
  echo "-- $f"
  node -e "const p=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify({type:p.type,main:p.main,scripts:p.scripts,deps:Object.keys(p.dependencies||{})},null,1))" "$f"
done

echo; echo "== RUTAS DEL BACKEND (app/router.metodo) =="
grep -rnE "(app|router)\.(get|post|put|delete|patch|use|all)\(" $EX $SRC . | head -80

echo; echo "== LLAMADAS DEL FRONTEND (fetch/axios/EventSource/api) =="
grep -rnE "fetch\(|axios\.|EventSource\(|WebSocket\(|['\"\`]/api/" $EX $SRC . | head -100

echo; echo "== ENLACE CON EL MOTOR (Paso 2 y 3) =="
grep -rnE "paso2|paso3|pipeline|processVideo|renderAll|clips\.json|manifest\.json|transcript\.json|child_process|spawn\(|execFile|exec\(" $EX $SRC . | head -60

echo; echo "== RESTOS DE DEPENDENCIAS EXTERNAS (solo archivos) =="
grep -rliE "gemini|gtts|googleapis|openai|generativeai|playwright" $EX $SRC --include=*.json --include=*.yml --include=Dockerfile* .

echo; echo "== POSIBLES SECRETOS (solo nombres de archivo) =="
grep -rlE "sessionid|BEGIN (RSA|PRIVATE)|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}" $EX . | head -20
ls -a | grep -i "^\.env" || echo "(sin .env en la raiz)"

echo; echo "== VARIABLES DE ENTORNO USADAS (solo nombres) =="
grep -rhoE "process\.env\.[A-Za-z0-9_]+" $EX $SRC . | sort -u

echo; echo "== DOCKER / DESPLIEGUE =="
ls Dockerfile* docker/ docker-compose*.yml railway.* nixpacks.* Procfile 2>/dev/null
grep -nE "^(FROM|CMD|ENTRYPOINT|EXPOSE)" Dockerfile* docker/Dockerfile* 2>/dev/null
} > "$OUT" 2>&1
wc -l "$OUT"
cat "$OUT"
