# ALife Lab

An evolution sandbox. A colony of yips, each driven by its own neural network, forages, hoards, builds, shares, steals, fights, hunts beasts, crafts tools and breeds. Brains mutate between generations (senses, layers and neurons are added and removed) and also learn within a lifetime through a policy-gradient update. Nothing social is scripted: sharing, theft, kin loyalty and group hunting only happen if evolution finds them worth it.

## The world (1.5)

- **One square torus**, about 3× the area of 1.1 (1344 × 1344). Walk off any edge and you come in on the opposite side; every sense, distance and grid lookup takes the shortest way around, and the map is drawn seamlessly repeating.
- **Lakes** fill the lowest ground, and land next to water is the most fertile. Yips can swim, slowly and at an extra energy cost, and water is colder than the air. A yip that runs out of energy in the water drowns. Beasts cannot swim, so water is also a refuge.
- **Thirst** is a need that grows faster in the heat. Only the Drink action (in the water or at its edge) lowers it much; food holds a little moisture.
- **Pheromones**: a continuous Scent output lays scent where a yip stands. It spreads to neighbouring ground and fades. Yips can sense the scent level and its gradient; Settings can show the trails.
- **Names**: every yip gets a name of 1–4 vowel-consonant syllables, written backwards half the time (Alaboj, Jobala).
- **Aquatic upgrades**: Webbed feet (fast, cheap swimming; slower on land) and Blubber (water barely chills it; overheats sooner).
- **Notifications** setting: All, Important (extinctions only) or Off.

## Reading the colony

- **Who they target** (Stats): every attack, gift, thank-you and befriending is classified by how the actor saw its target at that moment (kin, friend, stranger or enemy). A chart tracks the share aimed at kin and friends over time, so you can see whether affection and violence are separating.
- **Families** (Stats): the largest living lines (descendants of one founding band), with their action mix.
- **Timeline** (inspector tab): a yip's last 24 actions with the target and its trust in the target at the time.
- Every brain is born wired to the relationship senses: trust toward the nearest yip, kinship, gratitude owed, whether it hurt me recently, and its strength versus mine. Yips also feel it when nearby yips dislike them (it adds to loneliness).

## Islands and Turbo

- **Islands**: up to four separate worlds, each in its own worker on its own CPU core (default: one fewer than the device's cores, at most three). The island you watch follows the speed control; the others run unseen at full speed. The A/B/C chips in the header (or Settings → Islands) switch which one you watch.
- **Migration**: every few thousand ticks (World → Migration interval, Migrants per trip) an island sends a few of its most successful yips to another island, where they arrive together as a band.
- **Turbo** (`T`): stops all drawing, stats and inspector updates and runs every island flat out, showing only live counters per island.

## Learning (current)

Lifetime learning is a policy gradient with **eligibility traces**: every tick the gradient of the chosen action is added to a fading trace, and each reward updates the weights along it, so relief that comes later (eating) also credits the steps that led to it (walking to food, harvesting). Action preferences are linear outputs so a brain can become decisive. The first (sensory) layer is left to evolution; learning adjusts the deeper layers.

Adults feel an **urge to reproduce** that grows slowly, much faster when no other yip is in sensing range, and eases in a crowd. Each yip's standard for a partner drops as its urge rises (a lonely yip will pair with a stranger), a strong urge lets it find partners farther away, and crowding slows breeding. Learning runs every third tick on the reward gathered since, to save time.

Pairing is helped along by a **mating scent** that yips ready to breed give off automatically (it spreads and fades, and yips can sense its gradient), a stronger need for company, and **loving thank-yous**, which sometimes produce a child. Fights hurt both sides.

## How yips learn (1.3)

Rewards come only from inside each yip. It has six needs, each an urgency from 0 to 1: **hunger, cold/heat, injury, fatigue, loneliness and insecurity** (few supplies). Wellbeing is minus the weighted sum of the squared urgencies, and the learning signal is the change in wellbeing. Squaring gives diminishing returns: relief is worth the most when a need is desperate and almost nothing once it is met, so sitting by a fire pays less every tick, while a slowly growing chill builds the desire back up. Because it is a potential over the yip's own state, no loop can farm it. Traits set the weights (caution for injury, sociability for loneliness, greed for insecurity).

**Social life**
- Trust is slow to earn and fast to lose. Gains shrink as trust nears 1, scaled by the **trustfulness** trait; attacks and theft cut it sharply.
- Bystanders judge an attack by how they feel about both sides: hurting their kin or friend costs the attacker a lot, hurting a stranger costs a little, and hurting someone they distrust earns a small amount of trust. A trustful witness gives a yip it already trusts the benefit of the doubt, unless its own kin was the victim.
- Trust is also earned by giving food or materials (a yip gives whatever the other needs most), letting others eat, rest or warm up in your house or store, donating to someone's store, repairing their buildings, and fighting off a beast that was hunting them. Bystanders who see help given trust the helper a little more.
- A yip that is given food or materials, warmed by someone's fire, sheltered in their house or defended from a beast trusts the helper a little more and remembers **gratitude owed** to them. It can sense what it owes the yip nearest to it.
- **Thank** is an ordinary action. Nothing makes a yip use it. What it does: the thanked yip's loneliness eases (more for altruistic yips), it trusts the thanker a little, and repeating it soon means less. A thank-you from a yip that trusts you a lot is shown as 😍, otherwise "ty".
- **Birth takes two.** Two fed, nearby yips who both trust each other enough may have a child. Both pay energy, traits blend, compatible upgrades can come from either parent and the brain comes from one of them. Parent and child can never pair; closer kin can, but inbred children live shorter and start weaker. Popular yips find partners more easily.
- **Trust is part automatic, part chosen.** Help, harm and witnessing move it regardless. Time spent near a yip that has not hurt you slowly builds familiarity. The Befriend action lets a yip choose to trust the nearest yip a little more.
- **Desperation response** (a mental trait from −1 to +1) decides whether hardship makes a yip trust faster or turn suspicious.
- **Fear of death** (a mental trait) sets how much seeing a death hurts. Grief is a need: it rises when a yip dies nearby, most for kin and trusted yips, and fades slowly.
- **The dead are forgotten**: when a yip dies, every other yip's trust in it and gratitude toward it is dropped.
- **Popularity** is the total trust other living yips hold in you.
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

The page shows an automatic build number (commit count) in the header and in Settings → About.

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
