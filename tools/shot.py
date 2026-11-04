import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=swiftshader','--enable-unsafe-swiftshader'])
        out=[]
        for (w,h,name) in [(1440,900,'desk'),(390,844,'phone'),(844,390,'land')]:
            pg = await b.new_page(viewport={'width':w,'height':h}, device_scale_factor=1, has_touch=(name!='desk'), is_mobile=(name!='desk'))
            pg.on('console', lambda m: out.append(f'{name} console {m.type}: {m.text}'))
            pg.on('pageerror', lambda e: out.append(f'{name} PAGEERROR {e}'))
            await pg.goto('file://' + __import__('os').path.abspath('dist/alife-lab.html') + '')
            await pg.wait_for_timeout(4000)
            await pg.screenshot(path=f'/tmp/{name}1.png')
            # click an agent: find one via page script
            await pg.evaluate("""()=>{document.getElementById('coachOk').click(); const [id,p]=[...rpos.entries()].sort((a,b)=>Math.hypot(a[1].x-cam.x,a[1].y-cam.y)-Math.hypot(b[1].x-cam.x,b[1].y-cam.y))[0]; const s=toScreen(p.x,p.y),sx=s.x,sy=s.y; window._c=[sx,sy]; }""")
            sx,sy = await pg.evaluate("window._c")
            await (pg.touchscreen.tap(sx,sy) if name!='desk' else pg.mouse.click(sx,sy))
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=f'/tmp/{name}2.png')
            await pg.evaluate("document.getElementById('bStats').click()")
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path=f'/tmp/{name}3.png')
            out.append(name+' sel='+str(await pg.evaluate('selected'))+' z='+str(await pg.evaluate('cam.z.toFixed(2)'))+' '+await pg.evaluate("document.getElementById('perf').textContent"))
        print('\n'.join(out))
        await b.close()
asyncio.run(main())
