"""
Shrink one email image: max 600px wide, saved as JPEG quality 80.
The email shows images at most 560px wide, and the originals (up to ~600 KB
each) made every open of the email pull ~4 MB.

Usage: python shrink_image.py <input> <output>
Exits non-zero on failure; the caller then keeps the original image.
"""
import sys
from PIL import Image, ImageOps

MAX_WIDTH = 600
QUALITY = 80


def main(src, dst):
    img = Image.open(src)
    img = ImageOps.exif_transpose(img)
    if img.mode in ('RGBA', 'LA', 'P'):
        img = img.convert('RGBA')
        bg = Image.new('RGB', img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    elif img.mode != 'RGB':
        img = img.convert('RGB')
    if img.width > MAX_WIDTH:
        img = img.resize((MAX_WIDTH, round(img.height * MAX_WIDTH / img.width)), Image.LANCZOS)
    img.save(dst, format='JPEG', quality=QUALITY, optimize=True, progressive=True)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
