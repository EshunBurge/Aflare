"""Assemble the shippable files from src/.  Usage: python3 build.py
   src/index.src.html + src/sprite.svg.html -> index.html
   src/app.part1.js + part2 + part3        -> app.js
"""
import pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'index.src.html').read_text(encoding='utf-8').replace('<!--SPRITE-->', (src / 'sprite.svg.html').read_text(encoding='utf-8'))
(root / 'index.html').write_text(html, encoding='utf-8')
js = (src / 'app.part1.js').read_text(encoding='utf-8') + (src / 'app.part2.js').read_text(encoding='utf-8') + (src / 'app.home.js').read_text(encoding='utf-8') + (src / 'app.part3.js').read_text(encoding='utf-8')
(root / 'app.js').write_text(js, encoding='utf-8')
print('built index.html', len(html), 'bytes; app.js', len(js), 'bytes')
