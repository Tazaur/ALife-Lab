# ALife Lab

An evolution sandbox. A colony of yips, each driven by its own neural network, forages, hoards, builds, shares, steals, fights, hunts beasts, crafts tools and breeds. Brains mutate between generations (senses, layers and neurons are added and removed) and also learn within a lifetime through a policy-gradient update. Nothing social is scripted: sharing, theft, kin loyalty and group hunting only happen if evolution finds them worth it.

## How yips learn (1.3)

Rewards come only from inside each yip. It has six needs, each an urgency from 0 to 1: **hunger, cold/heat, injury, fatigue, loneliness and insecurity** (few supplies). Wellbeing is minus the weighted sum of the squared urgencies, and the learning signal is the change in wellbeing. Squaring gives diminishing returns: relief is worth the most when a need is desperate and almost nothing once it is met, so sitting by a fire pays less every tick, while a slowly growing chill builds the desire back up. Because it is a potential over the yip's own state, no loop can farm it. Traits set the weights (caution for injury, sociability for loneliness, greed for insecurity).

**Social life**
- Trust is slow to earn and fast to lose. Gains shrink as trust nears 1, scaled by the **trustfulness** trait; attacks and theft cut it sharply.
- Bystanders judge an attack by how they feel about both sides: hurting their kin or friend costs the attacker a lot, hurting a stranger costs a little, and hurting someone they distrust earns a small amount of trust. A trustful witness gives a yip it already trusts the benefit of the doubt, unless its own kin was the victim.
- Trust is also earned by giving food or materials (a yip gives whatever the other needs most), letting others eat, rest or warm up in your house or store, donating to someone's store, repairing their buildings, and fighting off a beast that was hunting them. Bystanders who see help given trust the helper a little more.
- A yip warmed by someone else's fire, sheltered in someone else's house, or given food trusts the provider a little more and may **thank** them (shown as a "ty" bubble). A yip that already trusts the provider and is well satisfied thanks with love (😍).
- Being thanked relieves the provider's loneliness; the warm glow scales with altruism. That is the only payoff for helping.
- **Popularity** is the total trust other living yips hold in you. Popular yips breed sooner and more often, and an admirer nearby can co-parent: traits blend and compatible upgrades can come from either side.
- Curiosity remains as an internal novelty drive: succeeding at something few yips do satisfies it, less with every repeat.

## Genetics

- **Physical traits** (body budget, strength, speed, thermal tolerance, sensing, rest efficiency, regeneration) mutate rarely and in small steps, and draw heavily on the body budget. Going over budget raises metabolism.
- **Mental traits** (learning rate, impulsiveness, curiosity, aggression, sociability, altruism, greed, caution) mutate quickly and cost almost nothing.
- **Upgrade trees**: 16 physical upgrades in six trees (Might, Swift, Endurance, Senses, Climate, Gut). Each has a benefit and a drawback and a budget cost, some require an earlier one, and physically opposed pairs can't coexist (Juggernaut vs Sprinter, Thick hide vs Lean frame, Fur coat vs Sweat glands, Fat reserves vs Lean frame, Hibernator vs Sprinter).
- **Houses insulate**: inside, temperature is pulled most of the way to 20°C, and resting restores energy and health fastest there.

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
