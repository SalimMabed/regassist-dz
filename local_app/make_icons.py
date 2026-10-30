"""Régénère les icônes raster du site (favicon.ico et apple-touch-icon.png) à partir du dessin de static/favicon.svg.
Le dessin est le même que celui du SVG (carré bleu marine, bâtiment à colonnes en blanc) ; seules l'épaisseur du trait et la taille du motif
sont ajustées par taille pour rester lisibles à 16 px. Dépend de Pillow, uniquement pour ce script (pas pour l'application).
Lancer : python -X utf8 -m local_app.make_icons"""
from pathlib import Path

from PIL import Image, ImageDraw

STATIC = Path(__file__).resolve().parent / "static"
NAVY = (11, 42, 74, 255)                          # #0b2a4a, la couleur de favicon.svg
WHITE = (255, 255, 255, 255)
SUPER = 16                                        # sur-échantillonnage : bords lissés après réduction
# Dessin de favicon.svg dans un repère de 32 unités : fronton, deux colonnes, base.
ROOF = [(16, 9), (24, 12), (8, 12), (16, 9)]
STROKES = [ROOF, [(12, 22), (12, 12)], [(20, 22), (20, 12)], [(9, 22), (23, 22)]]
CENTER = (16.0, 15.5)                             # centre optique du motif


def render(size: int, stroke: float, glyph: float, rounded: bool) -> Image.Image:
    """Une icône `size` x `size` : `stroke` = épaisseur du trait (en unités de 32), `glyph` = agrandissement du motif, `rounded` = coins arrondis."""
    big = size * SUPER
    k = big / 32.0
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=6 * k, fill=NAVY)
    else:
        d.rectangle([0, 0, big - 1, big - 1], fill=NAVY)           # plein cadre : iOS arrondit lui-même les coins
    half = stroke * k / 2

    def pt(x: float, y: float):
        return ((16 + (x - CENTER[0]) * glyph) * k, (16 + (y - CENTER[1]) * glyph) * k)

    for path in STROKES:
        pts = [pt(x, y) for x, y in path]
        d.line(pts, fill=WHITE, width=round(stroke * k), joint="curve")
        for x, y in pts:                                           # extrémités et angles arrondis, comme stroke-linecap/linejoin: round
            d.ellipse([x - half, y - half, x + half, y + half], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    frames = [render(48, 2.2, 1.12, True), render(32, 2.5, 1.18, True), render(16, 2.9, 1.28, True)]      # la plus grande d'abord : Pillow ignore les tailles supérieures à l'image principale
    frames[0].save(STATIC / "favicon.ico", format="ICO", sizes=[(f.width, f.height) for f in frames], append_images=frames[1:])
    render(180, 2.1, 1.22, False).convert("RGB").save(STATIC / "apple-touch-icon.png", format="PNG", optimize=True)
    for name in ("favicon.ico", "apple-touch-icon.png"):
        print(f"{name} : {(STATIC / name).stat().st_size} octets")


if __name__ == "__main__":
    main()
