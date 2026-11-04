# Headless smoke test: renders desktop, phone portrait and phone landscape; reports errors and hyperspeed throughput.
import asyncio, os, sys
from playwright.async_api import async_playwright
OUT = os.environ.get('SHOT_DIR', '/tmp')
URL = 'file://' + os.path.abspath('dist/alife-lab.html')
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome')
        out = []
        for (w, h, name) in [(1440, 900, 'desk'), (390, 844, 'phone'), (844, 390, 'land')]:
            mob = name != 'desk'
            pg = await b.new_page(viewport={'width': w, 'height': h}, has_touch=mob, is_mobile=mob)
            pg.on('console', lambda m, n=name: out.append(f'{n} console {m.type}: {m.text}') if 'TUNNEL' not in m.text else None)
            pg.on('pageerror', lambda e, n=name: out.append(f'{n} PAGEERROR {e}'))
            await pg.goto(URL); await pg.wait_for_timeout(3500)
            await pg.evaluate("document.getElementById('coachOk').click()")
            await pg.screenshot(path=f'{OUT}/{name}1.png')
            sx, sy = await pg.evaluate("""()=>{const [id,p]=[...rpos.entries()].sort((a,b)=>Math.hypot(a[1].x-cam.x,a[1].y-cam.y)-Math.hypot(b[1].x-cam.x,b[1].y-cam.y))[0]; const s=toScreen(p.x,p.y); return [s.x,s.y]}""")
            if mob: await pg.touchscreen.tap(sx, sy)
            else: await pg.mouse.click(sx, sy)
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f'{OUT}/{name}2.png')
            await pg.evaluate("document.querySelector('[data-pane=pBody]').click()"); await pg.wait_for_timeout(500)
            await pg.evaluate("(()=>{const b=document.querySelector('[data-perk]'); b&&b.click(); document.getElementById('pBody').scrollIntoView()})()"); await pg.wait_for_timeout(400)
            await pg.screenshot(path=f'{OUT}/{name}2b.png')
            await pg.evaluate("document.querySelector('[data-close=dInspect]').click(); document.querySelector('[data-tool=wall]').click(); document.getElementById('bStats').click()")
            await pg.wait_for_timeout(2000)
            await pg.screenshot(path=f'{OUT}/{name}3.png')
            out.append(f"{name} sel={await pg.evaluate('selected')} z={await pg.evaluate('cam.z.toFixed(2)')} {await pg.evaluate('document.getElementById(\"perf\").textContent')}")
            if name == 'desk':
                await pg.evaluate("document.getElementById('bMax').click()"); await pg.wait_for_timeout(6000)
                out.append('desk MAX ' + await pg.evaluate('document.getElementById("perf").textContent'))
                await pg.screenshot(path=f'{OUT}/desk4.png')
        print('\n'.join(out)); await b.close()
asyncio.run(main())
