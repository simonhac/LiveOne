#!/usr/bin/env python3
"""
make_pdf.py — render a Markdown doc (with a Mermaid diagram) to PDF.

pandoc converts the prose/tables to HTML; Mermaid.js (CDN) renders the ```mermaid block; the installed
Google Chrome prints the page to PDF headlessly (no puppeteer/chromium download). Usage:

    python make_pdf.py BRIEF.md            # -> BRIEF.pdf
"""
from __future__ import annotations
import html, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CSS = """
@page { size: A4; margin: 15mm 16mm; }
* { box-sizing: border-box; }
body { font: 10.3pt/1.42 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #16181d; }
h1 { font-size: 17pt; margin: 0 0 2pt; line-height: 1.2; }
h2 { font-size: 12.5pt; margin: 13pt 0 4pt; border-bottom: 1px solid #d7dbe0; padding-bottom: 2pt; }
h3 { font-size: 10.8pt; margin: 9pt 0 3pt; }
p { margin: 4pt 0; }
strong { color: #0b0c0f; }
em { color: #444; }
ul { margin: 4pt 0; padding-left: 18px; }
li { margin: 1.5pt 0; }
code { background: #f2f3f5; padding: 0.5px 3px; border-radius: 3px; font-size: 9pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9pt; }
th, td { border: 1px solid #d0d4d9; padding: 2.5px 6px; text-align: left; }
th { background: #eef1f4; }
td:nth-child(n+2), th:nth-child(n+2) { text-align: right; }
hr { border: none; border-top: 1px solid #d7dbe0; margin: 10pt 0; }
.mermaid { text-align: center; margin: 8pt 0; }
.mermaid svg { max-width: 100%; height: auto; }
blockquote { margin: 4pt 0; padding-left: 10px; border-left: 3px solid #cdd2d8; color: #444; }
"""

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head>
<body>{body}
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
mermaid.initialize({{ startOnLoad: false, theme: 'neutral', flowchart: {{ htmlLabels: true, useMaxWidth: true }} }});
await mermaid.run();
document.title = 'ready';
</script></body></html>"""


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "BRIEF.md"
    src = src if os.path.isabs(src) else os.path.join(HERE, src)
    stem = os.path.splitext(src)[0]
    md = open(src).read()

    m = re.search(r"```mermaid\n(.*?)```", md, re.S)
    if not m:
        sys.exit("no ```mermaid block found")
    md_wo = md[:m.start()] + "\n\nMERMAIDPLACEHOLDER\n\n" + md[m.end():]

    # disable tex_math_dollars: '$' is currency here, not math — otherwise pandoc pairs '$29 … $0.41'
    # in prose and mathifies the text between them.
    body = subprocess.run(["pandoc", "-f", "gfm-tex_math_dollars", "-t", "html", "--wrap=none"],
                          input=md_wo, capture_output=True, text=True, check=True).stdout
    diagram = f'<pre class="mermaid">{html.escape(m.group(1))}</pre>'
    body = body.replace("<p>MERMAIDPLACEHOLDER</p>", diagram)

    html_path = stem + ".html"
    open(html_path, "w").write(TEMPLATE.format(css=CSS, body=body))

    pdf_path = stem + ".pdf"
    if os.path.exists(pdf_path):
        os.remove(pdf_path)
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
                    "--no-pdf-header-footer",  # drop Chrome's date/url/page-number decorations
                    "--virtual-time-budget=20000", "--run-all-compositor-stages-before-draw",
                    f"--print-to-pdf={pdf_path}", f"file://{html_path}"],
                   capture_output=True, text=True, timeout=120)
    ok = os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 5000
    print(f"{'wrote' if ok else 'FAILED'} {pdf_path}"
          + (f"  ({os.path.getsize(pdf_path)//1024} KB)" if ok else ""))
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
