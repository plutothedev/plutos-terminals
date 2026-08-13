# Bundled terminal font — subsetting source

`MesloLGS-NF-Regular.ttf` (2,594kB) is the SOURCE for the shipped
`public/fonts/MesloLGS-NF-Regular.woff2` (428kB). Only the woff2 ships in
dist; the woff2 is COMMITTED so CI/other machines never need python to build
(P4-T3, plan audit H3).

Regenerate after swapping the source font:

```
pip install fonttools brotli
pyftsubset tools/fonts/MesloLGS-NF-Regular.ttf \
  --output-file=public/fonts/MesloLGS-NF-Regular.woff2 \
  --flavor=woff2 \
  --unicodes=U+0020-007E,U+00A0-00FF,U+0100-017F,U+2000-206F,U+2190-21FF,U+2300-23FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2700-27BF,U+2800-28FF,U+E000-F8FF \
  --no-hinting --desubroutinize --layout-features='*'
```

Ranges (audit M3):

| Range | What |
| --- | --- |
| U+0020-007E | Basic Latin |
| U+00A0-00FF | Latin-1 |
| U+0100-017F | Latin Extended-A |
| U+2000-206F | General punctuation |
| U+2190-21FF | Arrows |
| U+2300-23FF | Misc technical (⏎ ⌫) |
| U+2500-257F | Box drawing |
| U+2580-259F | Block elements |
| U+25A0-25FF | Geometric shapes (◐ ◜ spinner frames) |
| U+2700-27BF | Dingbats (✓ ✗ ❯) |
| U+2800-28FF | Braille (spinners) — **source TTF has zero braille glyphs**, so this range is a no-op today; kept in the command so a future source that has them picks them up. Braille spinners render via the fallback stack (Cascadia Code leads it) exactly as they always did. |
| U+E000-F8FF | Full BMP PUA — nerd-font icons land all over the PUA (calendar U+F073 / clock U+F017 in the prompt), not just the powerline strip U+E0A0-E0D7 |

Subset result: 4,133 of the source's 13,791 glyphs. `--no-hinting` is safe:
DirectWrite (WebView2) and Core Text (WKWebView) both ignore embedded TTF
hints. FFTM/PfEd subsetter warnings are FontForge private tables — dropped
by design.

Verification probe (paste into a repo-root python):

```python
from fontTools.ttLib import TTFont
cmap = TTFont("public/fonts/MesloLGS-NF-Regular.woff2").getBestCmap()
for cp in (0x2500, 0x2588, 0x25DC, 0x2713, 0x276F, 0xE0B0, 0xE0A0, 0xF017, 0xF073):
    assert cp in cmap, hex(cp)
print("ok")
```
