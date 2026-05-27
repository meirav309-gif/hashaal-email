"""
Render HTML email to PDF (with resized embedded images) and upload to smoove.
Prints the URL to stdout.
Usage: python html_to_pdf_upload.py <html_file>
"""
import sys
import os
import re
import io
import base64
import requests
from PIL import Image
from playwright.sync_api import sync_playwright

UPLOAD_URL = 'https://studio-api.admin.smoove.io/upload'
MAX_PDF_BYTES = 1_650_000  # smoove rejects above ~1.68MB

# Try these quality levels in order until PDF fits
QUALITY_LEVELS = [
    (900, 88),
    (800, 84),
    (700, 79),
    (580, 72),
]


def download_images(html):
    """Download all external images once, return {url: PIL.Image}."""
    urls = re.findall(r'src="(https?://[^"]+)"', html)
    cache = {}
    for url in urls:
        if url in cache:
            continue
        try:
            r = requests.get(url, timeout=15)
            cache[url] = Image.open(io.BytesIO(r.content)).convert('RGB')
        except Exception as e:
            print(f'  image warn: {e}', file=sys.stderr)
            cache[url] = None
    return cache


def embed_images(html, cache, max_width, quality):
    """Replace external img src with base64 data URIs at given quality."""
    def replace_src(m):
        url = m.group(1)
        img = cache.get(url)
        if img is None:
            return m.group(0)
        img = img.copy()
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode()
        return f'src="data:image/jpeg;base64,{b64}"'
    return re.sub(r'src="(https?://[^"]+)"', replace_src, html)


def render_pdf(processed_path):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto('file:///' + processed_path.replace('\\', '/'))
        page.wait_for_load_state('domcontentloaded')
        pdf_bytes = page.pdf(
            format='A4',
            margin={'top': '12mm', 'right': '12mm', 'bottom': '12mm', 'left': '12mm'},
            print_background=True
        )
        browser.close()
    return pdf_bytes


def html_to_pdf(html_path):
    with open(html_path, encoding='utf-8') as f:
        html = f.read()

    print('Downloading images...', file=sys.stderr)
    cache = download_images(html)

    processed_path = html_path + '.processed.html'
    pdf_bytes = None

    for max_width, quality in QUALITY_LEVELS:
        print(f'Trying {max_width}px q{quality}...', file=sys.stderr)
        processed_html = embed_images(html, cache, max_width, quality)
        with open(processed_path, 'w', encoding='utf-8') as f:
            f.write(processed_html)
        try:
            pdf_bytes = render_pdf(processed_path)
        finally:
            if os.path.exists(processed_path):
                os.remove(processed_path)

        size_mb = len(pdf_bytes) / 1024 / 1024
        print(f'  -> {size_mb:.2f} MB', file=sys.stderr)
        if len(pdf_bytes) <= MAX_PDF_BYTES:
            break

    return pdf_bytes


def upload_pdf(pdf_bytes, filename='hashaal.pdf'):
    resp = requests.post(
        UPLOAD_URL,
        files={'file': (filename, pdf_bytes, 'application/pdf')},
        timeout=30
    )
    if not resp.ok:
        raise Exception(f'Upload failed {resp.status_code}: {resp.text[:300]}')
    return resp.json()['fileUrl']


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python html_to_pdf_upload.py <html_file>', file=sys.stderr)
        sys.exit(1)

    html_path = os.path.abspath(sys.argv[1])
    pdf_bytes = html_to_pdf(html_path)

    size_mb = len(pdf_bytes) / 1024 / 1024
    print(f'PDF size: {size_mb:.2f} MB', file=sys.stderr)

    url = upload_pdf(pdf_bytes, os.path.basename(html_path).replace('.html', '.pdf'))
    print(url)  # Only URL to stdout — captured by Node.js
