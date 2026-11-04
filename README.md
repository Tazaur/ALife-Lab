# ALife Lab

An evolution sandbox. A colony of agents, each driven by its own small neural network, forages, builds, trades, fights the weather and breeds. Brains mutate between generations (inputs, layers and neurons are added and removed) and also learn within a lifetime through a policy-gradient update.

**Play:** open `index.html` in any modern browser — desktop or phone, portrait or landscape. No build step or server needed.

## Controls

| | Mouse / keyboard | Touch |
|---|---|---|
| Select an agent | Click it | Tap it |
| Zoom | Scroll, double-click | Pinch, double-tap |
| Pan | Drag (right-drag with any brush) | Drag, or two fingers with any brush |
| Paint resources | Pick a brush (`2`–`6`) and drag | Pick a brush and drag |
| Pause / step / speed | `Space` / `.` / `−` `+` | Dock buttons |
| Follow selected / fit world | `F` / `0` | Inspector target button / fit button |
| Stats / climate / close | `S` / `C` / `Esc` | Top buttons; swipe a sheet down to close |

## What's in it

- **World**: food, trees and stone spawn and decay; houses, storehouses, walls and fires get built, stocked, repaired and collapse. Day/night and seasons drive temperature; storm fronts sweep across.
- **Inspector**: live brain graph (hover neurons), next-action probabilities, traits against the population average, trust ledger, living children and ancestry.
- **Stats**: population, generation and body-drift charts, causes of death, which senses brains have evolved to use, action mix, hall of fame and a field log.
- **Climate**: six biome presets, interventions (storm, food bloom, cold snap, heatwave) and every world parameter.
- **Saves**: autosave to the browser, resume prompt on reopen, JSON download/import (also reads 0.6–0.9 snapshots). Extinctions reseed from archived top genomes.

## Structure

```
src/sim.js     simulation core, runs in a Web Worker
src/app.js     rendering, camera, input, UI
src/style.css  styles
src/body.html  markup
build.py       inlines src/ into dist/alife-lab.html (and index.html)
tools/         headless benchmark and screenshot scripts
```

Edit `src/`, then run `python3 build.py && cp dist/alife-lab.html index.html`.

## Performance

The simulation runs off the main thread and ships compact typed-array frames to the renderer, which interpolates motion at display rate. Weights are flat `Float32Array`s, resources sit in per-type spatial grids searched outward ring by ring, and sensing allocates nothing per tick. In a seeded headless benchmark (`node tools/bench.js src/sim.js 4000`) the core runs about 5× more ticks per second than v0.9 while carrying a larger population.
