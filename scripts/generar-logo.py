#!/usr/bin/env python3
"""Genera assets/klikap-logo.png: wordmark 'klikap' minimalista con fondo transparente.
Blanco con sombra suave (legible sobre cualquier video) y un acento corporativo en el punto de la 'i'.
Si existe un logo oficial, reemplaza el PNG y no hace falta ejecutar esto."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import sys

SALIDA = sys.argv[1] if len(sys.argv) > 1 else 'assets/klikap-logo.png'
FUENTE = '/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf'
ACENTO = (91, 108, 255, 255)   # azul violeta: no choca con el amarillo/verde de los subtitulos
BLANCO = (255, 255, 255, 255)
K = 4                          # supersampling para bordes limpios
ANCHO, ALTO = 648, 176         # 3x del ancho de render (216 px) para que escale nitido

fuente = ImageFont.truetype(FUENTE, 112 * K)
texto = 'klikap'

# Mide el texto y centra todo el conjunto (icono + palabra).
caja = fuente.getbbox(texto)
tw, th = caja[2] - caja[0], caja[3] - caja[1]
icono = 96 * K
hueco = 22 * K
total = icono + hueco + tw
x0 = (ANCHO * K - total) // 2
y_icono = (ALTO * K - icono) // 2

capa = Image.new('RGBA', (ANCHO * K, ALTO * K), (0, 0, 0, 0))
d = ImageDraw.Draw(capa)

# Icono: cuadrado redondeado de acento con un "clic" (cursor en forma de flecha) en blanco.
d.rounded_rectangle([x0, y_icono, x0 + icono, y_icono + icono], radius=int(icono * 0.28), fill=ACENTO)
cx, cy, s = x0 + icono * 0.36, y_icono + icono * 0.26, icono * 0.46
flecha = [(cx, cy), (cx, cy + s), (cx + s * 0.27, cy + s * 0.74), (cx + s * 0.46, cy + s * 1.06),
          (cx + s * 0.62, cy + s * 0.98), (cx + s * 0.43, cy + s * 0.66), (cx + s * 0.78, cy + s * 0.66)]
d.polygon(flecha, fill=BLANCO)

# Palabra en blanco, alineada verticalmente con el icono.
xt = x0 + icono + hueco - caja[0]
yt = (ALTO * K - th) // 2 - caja[1]
d.text((xt, yt), texto, font=fuente, fill=BLANCO, stroke_width=int(1.6 * K), stroke_fill=(15, 18, 45, 150))

# Sombra suave debajo de todo para separarlo del fondo en escenas claras.
alfa = capa.split()[3]
sombra = Image.new('RGBA', capa.size, (0, 0, 0, 0))
sombra.putalpha(alfa.point(lambda v: int(v * 0.85)))
sombra = sombra.filter(ImageFilter.GaussianBlur(4 * K))
lienzo = Image.new('RGBA', capa.size, (0, 0, 0, 0))
lienzo.alpha_composite(sombra, (0, 2 * K))
lienzo.alpha_composite(capa)

final = lienzo.resize((ANCHO, ALTO), Image.LANCZOS)
final.save(SALIDA, optimize=True)
print('Logo generado:', SALIDA, final.size, final.mode)
