#!/usr/bin/env python3
# The app's icon: the author's avatar (a hand holding a phone with "2" on a
# green screen, os/icons/avatar.png), the same as on the port's Telegram and
# YouTube. No art from the game. Writes the Android launcher icons (adaptive
# foreground, legacy square and round) and the web icons. Run from the
# repository root:
#   python3 os/icons/make_icons.py
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, 'os/icons/avatar.png')
# The avatar's own background (ic_launcher_background.xml has the same).
BACKGROUND = (9, 8, 8)
N = 1024

avatar = Image.open(SOURCE).convert('RGB').resize((N, N), Image.LANCZOS)


def framed(scale):
    """The avatar at [scale] of the side, centered on its background."""
    image = Image.new('RGB', (N, N), BACKGROUND)
    side = int(N * scale)
    image.paste(avatar.resize((side, side), Image.LANCZOS), ((N - side) // 2, (N - side) // 2))
    return image


def masked(image, shape):
    mask = Image.new('L', (N, N), 0)
    draw = ImageDraw.Draw(mask)
    if shape == 'circle':
        draw.ellipse([0, 0, N - 1, N - 1], fill=255)
    else:
        draw.rounded_rectangle([0, 0, N - 1, N - 1], radius=int(N * 0.18), fill=255)
    out = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    out.paste(image, (0, 0), mask)
    return out


def save(image, path, size):
    path = os.path.join(ROOT, path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.resize((size, size), Image.LANCZOS).save(path, optimize=True)


# Adaptive icons show the middle 72 of 108 dp (less for a circle): the
# avatar a bit smaller, so the fingers and the phone stay whole.
foreground = framed(0.74)
square = framed(0.94)
circle = framed(0.84)

for density, scale in (('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)):
    base = f'os/android/app/src/main/res/mipmap-{density}'
    save(foreground, f'{base}/ic_launcher_foreground.png', int(108 * scale))
    save(masked(square, 'square'), f'{base}/ic_launcher.png', int(48 * scale))
    save(masked(circle, 'circle'), f'{base}/ic_launcher_round.png', int(48 * scale))

# Web: iOS rounds the corners itself, so the whole avatar there.
save(avatar, 'os/web/icons/apple-touch-icon.png', 180)
save(avatar, 'os/web/icons/icon-192.png', 192)
save(avatar, 'os/web/icons/icon-512.png', 512)
