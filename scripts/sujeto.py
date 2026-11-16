#!/usr/bin/env python3
"""Detector de rostros por muestreo para el encuadre dinamico 9:16 de ClipLab.

Uso:  python3 scripts/sujeto.py <video> [--fps 4]

Imprime UN solo JSON por stdout (los avisos van a stderr):
  {"ancho": 480, "alto": 270, "fps": 4,
   "muestras": [{"t": 0.0, "x": 0.52, "l": 0.41, "r": 0.63, "n": 1}, ...]}
  x = centro horizontal del rostro principal (0..1); l / r = limites del grupo de rostros;
  n = rostros detectados. Sin rostro: {"t": ..., "x": null, "n": 0}.
Si algo falla: {"error": "..."} con codigo de salida 1.
"""
import argparse
import json
import sys


def fallar(mensaje):
    print(json.dumps({"error": str(mensaje)}))
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--fps", type=float, default=4.0)
    args = parser.parse_args()

    try:
        import cv2
    except ImportError:
        fallar("opencv no esta instalado (pip install opencv-python-headless)")

    nombre = "haarcascade_frontalface_default.xml"
    carpetas = []
    if hasattr(cv2, "data"):
        carpetas.append(cv2.data.haarcascades)
    carpetas += ["/usr/share/opencv4/haarcascades/", "/usr/share/opencv/haarcascades/"]
    cascada = None
    for carpeta in carpetas:
        candidata = cv2.CascadeClassifier(carpeta + nombre)
        if not candidata.empty():
            cascada = candidata
            break
    if cascada is None:
        fallar("no se pudo cargar el clasificador de rostros")

    captura = cv2.VideoCapture(args.video)
    if not captura.isOpened():
        fallar("no se pudo abrir el video: " + args.video)

    fps_real = captura.get(cv2.CAP_PROP_FPS) or args.fps
    ancho = int(captura.get(cv2.CAP_PROP_FRAME_WIDTH))
    alto = int(captura.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if ancho <= 0 or alto <= 0:
        fallar("dimensiones de video invalidas")

    paso = max(1, int(round(fps_real / max(0.5, args.fps))))
    minimo = max(24, int(alto * 0.08))
    muestras = []
    indice = 0

    while True:
        ok, cuadro = captura.read()
        if not ok:
            break
        if indice % paso == 0:
            t = round(indice / fps_real, 3)
            gris = cv2.equalizeHist(cv2.cvtColor(cuadro, cv2.COLOR_BGR2GRAY))
            rostros = cascada.detectMultiScale(gris, scaleFactor=1.1, minNeighbors=6, minSize=(minimo, minimo))
            if len(rostros) == 0:
                muestras.append({"t": t, "x": None, "n": 0})
            else:
                rostros = sorted(rostros, key=lambda r: r[2] * r[3], reverse=True)
                x, _, w, _ = rostros[0]
                # Se ignoran rostros mucho mas pequenos que el principal (falsos positivos / fondo).
                grupo = [r for r in rostros if r[2] * r[3] >= 0.25 * w * rostros[0][3]]
                muestras.append({
                    "t": t,
                    "x": round((x + w / 2) / ancho, 4),
                    "l": round(min(r[0] for r in grupo) / ancho, 4),
                    "r": round(max(r[0] + r[2] for r in grupo) / ancho, 4),
                    "n": len(grupo),
                })
        indice += 1

    captura.release()
    print(json.dumps({"ancho": ancho, "alto": alto, "fps": args.fps, "muestras": muestras}))


if __name__ == "__main__":
    main()
