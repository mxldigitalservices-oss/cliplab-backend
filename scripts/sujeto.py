#!/usr/bin/env python3
"""Detector de rostros por muestreo para el encuadre dinamico 9:16 de ClipLab.

Uso:  python3 scripts/sujeto.py <video> [--desde S] [--hasta S] [--fps 4] [--max-ancho 960]
      python3 scripts/sujeto.py --check        (verifica OpenCV + clasificador; sale 0 si todo esta bien)

Se llama UNA vez por clip (no una vez por muestra): salta a --desde, recorre hasta --hasta y mide
`--fps` cuadros por segundo. Imprime UN solo JSON por stdout (los avisos van a stderr):
  {"ancho": 1920, "alto": 1080, "fps": 4, "desde": 12.0, "hasta": 72.0,
   "muestras": [{"t": 12.0, "x": 0.52, "l": 0.41, "r": 0.63, "n": 2,
                 "rostros": [{"x": 0.45, "w": 0.07, "act": 0.012}, {"x": 0.59, "w": 0.07, "act": 0.003}]}, ...]}
  t = segundo ABSOLUTO dentro del video; x = centro horizontal del rostro principal (0..1);
  l / r = limites del grupo de rostros; n = rostros detectados; rostros = de izquierda a derecha.
  act = movimiento en la zona de esa persona vs la muestra anterior (0..1; null en la primera muestra).
  Sin rostro: {"t": ..., "x": null, "n": 0}.
Si algo falla: {"error": "..."} con codigo de salida 1.
"""
import argparse
import json
import sys


def fallar(mensaje):
    print(json.dumps({"error": str(mensaje)}))
    sys.exit(1)


def cargar_cascada(cv2):
    if not hasattr(cv2, "CascadeClassifier"):
        fallar("esta version de OpenCV (" + cv2.__version__ + ") no trae CascadeClassifier; usa opencv-python-headless>=4.10,<5")
    nombre = "haarcascade_frontalface_default.xml"
    carpetas = []
    if hasattr(cv2, "data"):
        carpetas.append(cv2.data.haarcascades)
    carpetas += ["/usr/share/opencv4/haarcascades/", "/usr/share/opencv/haarcascades/"]
    for carpeta in carpetas:
        candidata = cv2.CascadeClassifier(carpeta + nombre)
        if not candidata.empty():
            return candidata
    fallar("no se pudo cargar el clasificador de rostros")


def detectar(cv2, cascada, clahe, cuadro, escala):
    """Devuelve [(x, y, w, h)] en pixeles del cuadro ya reducido."""
    if escala != 1.0:
        cuadro = cv2.resize(cuadro, None, fx=escala, fy=escala, interpolation=cv2.INTER_AREA)
    alto = cuadro.shape[0]
    ancho = cuadro.shape[1]
    base = cv2.GaussianBlur(cv2.cvtColor(cuadro, cv2.COLOR_BGR2GRAY), (5, 5), 0)  # para medir movimiento
    # CLAHE (ecualizacion LOCAL) en vez de equalizeHist global: con fondos oscuros o planos (estudios de
    # podcast) la ecualizacion global aplasta el contraste del rostro y Haar deja de verlo (3/27 vs 27/27 en pruebas).
    gris = clahe.apply(cv2.cvtColor(cuadro, cv2.COLOR_BGR2GRAY))
    minimo = max(20, int(alto * 0.07))
    rostros = cascada.detectMultiScale(gris, scaleFactor=1.1, minNeighbors=6, minSize=(minimo, minimo))
    return ancho, [tuple(int(v) for v in r) for r in rostros], base


def actividad(cv2, base, previo, rostro):
    """Movimiento (0..1) en la zona de una persona (rostro + torso/manos) respecto a la muestra anterior.
    Es un indicador RELATIVO de quien se mueve o gesticula; no distingue quien habla (eso pide audio)."""
    if previo is None or previo.shape != base.shape:
        return None
    x, y, w, h = rostro
    alto, ancho = base.shape[:2]
    x0, x1 = max(0, int(x - 0.4 * w)), min(ancho, int(x + 1.4 * w))
    y0, y1 = max(0, int(y - 0.2 * h)), min(alto, int(y + 2.5 * h))
    if x1 <= x0 or y1 <= y0:
        return None
    return float(cv2.absdiff(base[y0:y1, x0:x1], previo[y0:y1, x0:x1]).mean()) / 255.0


def rostro_json(cv2, base, previo, r, ancho_ds):
    act = actividad(cv2, base, previo, r)
    return {"x": round((r[0] + r[2] / 2) / ancho_ds, 4), "w": round(r[2] / ancho_ds, 4),
            "act": None if act is None else round(act, 5)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video", nargs="?")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--desde", type=float, default=0.0)
    parser.add_argument("--hasta", type=float, default=None)
    parser.add_argument("--fps", type=float, default=4.0)
    parser.add_argument("--max-ancho", type=int, default=960, dest="max_ancho")
    args = parser.parse_args()

    try:
        import cv2
    except ImportError:
        fallar("opencv no esta instalado (pip install opencv-python-headless)")

    cascada = cargar_cascada(cv2)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    if args.check:
        print(json.dumps({"ok": True, "opencv": cv2.__version__}))
        return
    if not args.video:
        fallar("falta el video")

    captura = cv2.VideoCapture(args.video)
    if not captura.isOpened():
        fallar("no se pudo abrir el video: " + args.video)

    fps_real = captura.get(cv2.CAP_PROP_FPS) or 30.0
    ancho = int(captura.get(cv2.CAP_PROP_FRAME_WIDTH))
    alto = int(captura.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if ancho <= 0 or alto <= 0:
        fallar("dimensiones de video invalidas")
    escala = min(1.0, args.max_ancho / float(ancho))

    desde = max(0.0, args.desde)
    hasta = args.hasta if args.hasta is not None and args.hasta > desde else None
    if desde > 0:
        captura.set(cv2.CAP_PROP_POS_MSEC, desde * 1000.0)

    # Posicion real tras el salto (puede caer en el keyframe previo): se corrige con el tiempo del cuadro.
    t_actual = (captura.get(cv2.CAP_PROP_POS_MSEC) or desde * 1000.0) / 1000.0
    paso = 1.0 / max(0.5, args.fps)
    siguiente = desde
    muestras = []
    previo = None

    while True:
        if hasta is not None and t_actual > hasta + 1e-6:
            break
        if not captura.grab():
            break
        if t_actual + 1e-6 >= siguiente:
            ok, cuadro = captura.retrieve()
            if ok:
                ancho_ds, rostros, base = detectar(cv2, cascada, clahe, cuadro, escala)
                t = round(t_actual, 3)
                if not rostros:
                    muestras.append({"t": t, "x": None, "n": 0})
                else:
                    rostros.sort(key=lambda r: r[2] * r[3], reverse=True)
                    x, _, w, h = rostros[0]
                    # Se ignoran rostros mucho mas pequenos que el principal (falsos positivos / fondo).
                    grupo = [r for r in rostros if r[2] * r[3] >= 0.25 * w * h]
                    grupo.sort(key=lambda r: r[0])
                    muestras.append({
                        "t": t,
                        "x": round((x + w / 2) / ancho_ds, 4),
                        "l": round(min(r[0] for r in grupo) / ancho_ds, 4),
                        "r": round(max(r[0] + r[2] for r in grupo) / ancho_ds, 4),
                        "n": len(grupo),
                        "rostros": [rostro_json(cv2, base, previo, r, ancho_ds) for r in grupo],
                    })
                previo = base
            siguiente += paso
        t_actual += 1.0 / fps_real

    captura.release()
    print(json.dumps({"ancho": ancho, "alto": alto, "fps": args.fps, "desde": desde, "hasta": hasta, "muestras": muestras}))


if __name__ == "__main__":
    main()
