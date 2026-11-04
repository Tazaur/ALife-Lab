#!/usr/bin/env python3
"""Inline src/ into a single self-contained page.
dist/alife-lab.html  — standalone document (open directly in a browser)
dist/artifact.html   — body fragment for Claude artifact publishing"""
import pathlib, subprocess, datetime
root = pathlib.Path(__file__).parent
src = root / 'src'
css, body, sim, app = [(src / f).read_text() for f in ('style.css', 'body.html', 'sim.js', 'app.js')]
# version is automatic: build number = commits so far (+1 when there are uncommitted changes, i.e. the commit about to be made)
def git(*a):
    try: return subprocess.run(['git', *a], cwd=root, capture_output=True, text=True).stdout.strip()
    except Exception: return ''
count = int(git('rev-list', '--count', 'HEAD') or 0) + (1 if git('status', '--porcelain', '--', 'src') else 0)
stamp = datetime.date.today().isoformat()
body = body.replace('__VERSION_SHORT__', f'build {count}').replace('__VERSION_LONG__', f'build {count} · {stamp}')
head = '''<title>ALife Lab</title>
<meta name="theme-color" content="#0a1110">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>
''' + css + '\n</style>\n'
content = body + '\n<script id="simSource" type="text/plain">\n' + sim.replace('</script', '<\\/script') + '\n</script>\n<script>\n' + app + '\n</script>\n'
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/artifact.html').write_text(head + content)
(root / 'dist/alife-lab.html').write_text('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' + head + '</head>\n<body>\n' + content + '</body>\n</html>\n')
print('built', len(head + content) // 1024, 'KB')
