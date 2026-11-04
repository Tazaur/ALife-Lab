# ALife Lab

An evolution sandbox. A colony of agents, each driven by its own neural network, forages, hoards, builds, shares, steals, fights, hunts beasts, crafts tools and breeds. Brains mutate between generations (senses, layers and neurons are added and removed) and also learn within a lifetime through a policy-gradient update. Nothing social is scripted: sharing, theft, kin loyalty and group hunting only happen if evolution finds them worth it.

## The world (1.1)

- **Biomes**: each world is generated with fertile valleys (food), forests (wood) and rocky ground (stone), so resources are spread apart and worth carrying, storing or fighting over.
- **Beasts** hunt exposed agents. Walls block them, fire scares them, houses hide you, and several agents hitting one at once can kill it for meat.
- **Walls** are laid along the builder's path, so an agent walking and building leaves a barrier line. They also break storm winds.
- **Tools**: 1 wood + 1 stone crafts a tool that doubles harvests and more than doubles combat damage until it wears out.
- **Food spoils** faster when carried than when stocked in a storehouse.
- **18 actions**: move ×4, harvest, eat, deposit, withdraw, build house / storehouse / wall / fire, repair, share food, attack agent, fight beast, craft tool, rest.
- **3 continuous outputs**: a voice other agents can hear, and two memory cells the brain reads back next tick.
- **59 possible senses**, including kinship with the nearest agent, its strength, food and tool, beast direction, crowding, the average voice nearby, ground fertility, pain and the agent's own memory.
- **Default brain**: 18 inputs → 14 → 12 → 21 outputs, mutable up to 6 hidden layers.
- **Hyperspeed**: speeds up to 256× plus Max, which runs as fast as the device allows and reduces drawing.

**Play:** open `index.html` in any modern browser — desktop or phone, portrait or landscape. No build step or server needed.

## Controls

| | Mouse / keyboard | Touch |
|---|---|---|
| Select an agent | Click it | Tap it |
| Zoom | Scroll, double-click | Pinch, double-tap |
| Pan | Drag (right-drag with any brush) | Drag, or two fingers with any brush |
| Paint, build, release beasts | Pick a brush (`2`–`8`) and drag; `[` `]` resize | Pick a brush and drag |
| Pause / step / speed / hyperspeed | `Space` / `.` / `−` `+` / `M` | Dock buttons |
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

The simulation runs off the main thread and ships compact typed-array frames to the renderer, which interpolates motion at display rate. Weights are flat `Float32Array`s, resources sit in per-type spatial grids searched outward ring by ring, and sensing allocates nothing per tick. Brains only pay for the senses they are wired to (environment queries are skipped otherwise), effective weights are cached, tanh uses a rational approximation, and the worker yields through a `MessageChannel` instead of clamped timers. Benchmark: `node tools/bench.js src/sim.js 6000`; smoke test with screenshots: `python3 tools/shot.py`.
