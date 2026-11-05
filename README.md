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
- **Real islands**: each world is an island ringed by salt sea. Yips can swim the sea but can't drink it and it chills them faster; fresh lakes inland are where they drink.
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

## Watch from another device

On the PC, open the page and go to Settings → Watch from another device → **Start hosting**. It shows a code, a link and a QR code. On the phone, scan the QR code, open the link, or type the code in the same section. The islands keep running on the PC; the phone only draws them, buffered a little behind real time (Settings → Sim server → Smoothing and updates per second). The phone can still switch islands, inspect, paint, save, use the library and change the island count.

- Devices connect directly over WebRTC; the free PeerJS broker only introduces them. It works on the same Wi-Fi and usually across the internet.
- Keep the host tab open. Hosting turns itself back on, with the same code, when the host page reloads. The host keeps running while its tab is in the background.
- Each viewer's selection is its own: picking a yip on the phone doesn't open the inspector on the PC.

## Sim server (optional, run without a browser tab)

For runs that should keep going with no browser open, the same thing works from a small Node server that also autosaves to disk.

1. Install [Node.js](https://nodejs.org) 18 or newer on the PC and clone this repo.
2. Run `node server/server.js` (on Windows you can double-click `server/start.bat`). It prints the addresses to open.
3. On the PC, open `http://localhost:8787` to watch with visuals. On a phone on the same Wi-Fi, open the `http://<pc address>:8787` it printed. Allow Node through the firewall if asked.

- The server runs the islands whether or not anyone is watching. An island streams frames only while a viewer watches it; unwatched islands run flat out.
- Viewers queue frames and play them a little behind real time at an even pace (Settings → Sim server → Smoothing: Live / Normal / Smooth, and updates per second).
- The server autosaves every 2 minutes to `server/saves/autosave.json.gz`, saves when you press Ctrl+C, and resumes from that file on the next start (`--fresh` starts over).
- Options: `--port 8787`, `--islands 1-4`, `--autosave-min 2`, `--fresh`. `http://<pc>:8787/status` shows island counters as JSON.
- Outside your home network you'd need something like Tailscale; the server has no login, so don't expose the port to the internet.

## Saves and the yip library

- **Saves** hold every island (yips, brains, genes, resources, settings), gzipped into the browser's IndexedDB. Autosave runs every 2 minutes; Settings has save, load, download and import. Old single-world files still load.
- **Yip library** (Settings): keep the top yips from an island, from every island, or one yip from the inspector (Keep). A library entry stores genes, traits and the brain with everything it learned. *New world from library* starts fresh islands with one exact copy of each checked yip and fills the 300 founders with their mutated offspring. Libraries download and import as files.

## Energy physics (1.6)

- **A closed ledger.** Each island holds a fixed amount of energy (450k by default). It sits in the wild reserve, the soil, plants and wood, carcasses, beasts, yips (usable energy, stomach, fat, body tissue, unborn young) and structures. It is moved, never made or destroyed. Every 200 ticks everything is added up and the reserve absorbs any rounding. Stats → World energy shows the split.
- **Every transfer loses some.** Digestion keeps about 85% (genes can raise it to 95%), with the rest leaving as waste that fertilizes the soil where it falls. Storing and drawing fat lose 10% each way. Feeding unborn young loses 30%.
- **The wild.** The reserve regrows plants on fertile ground. Nutrient-rich soil (from waste and rot) sprouts food where it lies. Energy lying idle in the wild spawns beasts.
- **Eating** fills the stomach; energy arrives as it digests. Hunger counts what is in the stomach. Eating plant food leaves seeds; **planting seeds** makes a garden that draws extra growth from the wild for a long time.
- **Everything costs energy**, all of it ending up as heat: walking (grows with mass and speed squared, more when swimming), harvesting, building, repairing, crafting, fighting, hunting, talking, mating, healing and illness. Resting creates nothing; it lowers the burn and eases fatigue. Cold makes a body shiver (worse when large and lean), heat makes it sweat and thirsty (worse when fat).
- **Metabolism is not a trait.** It is the sum of upkeep: a resting body scaled by mass, plus eyes, nose, ears, immune system, healing, insulation, reproductive organs, brain and the genes switched on. The inspector's Body tab shows the breakdown.
- **Fat and muscle.** Surplus energy becomes fat, which adds mass (slower, costlier to move) and insulates. Muscle grows with use, at a cost, and wastes away slowly when idle; strength is muscle.
- **Pregnancy.** Mating starts a pregnancy. The carrier feeds the young from its own energy, at a loss, and the young is born with what it received. A starving carrier can lose it. Yips start sexless (every body can carry and sire); genes can shrink either ability, so sexes can evolve.
- **Death and disease.** A dead yip or beast leaves a carcass holding its energy, which decomposes into the soil. Carcasses can be cut up and carried as meat. Once rotting, a carcass gives off the smell of disease, which drifts farther than infection reaches. Disease spreads only at close range (rotting carcasses, sick yips, rotten meat, and eating other yips even when fresh). Immunity resists it; fighting it costs energy.
- **Senses are individual.** Sight range sets what a yip can see and recognize. Smell scales every scent (trails, mating scent, disease) and how far apart it can compare them to find direction. Hearing range sets which actions it hears: talk, fights, beasts, death cries and work.

## Genetics

- **Physical traits** (strength, speed, insulation, sight range, smell, hearing range, immunity, rest, healing) mutate rarely and in small steps. Founders are random: some start nearly blind, deaf or without a nose.
- **Mental traits** (learning rate, impulsiveness, curiosity, aggression, sociability, trustfulness, desperation response, fear of death, altruism, greed, caution) mutate quickly and cost nothing.
- **Open-ended genes**: a body is a list of genes, each a bundle of effects on physical dials (speed, hit power, armor, carry, sight, smell, hearing, immunity, stomach size, digestion efficiency, energy store, health, healing, rest, swimming, chill, cold/heat tolerance, beast detection, fertility, offspring size, ability to carry young, ability to sire young, lifespan) plus an expression condition (always, cold, hot, night, day, young, old, starving, fed, swimming, hurt). Genes arise de novo, duplicate, mutate, gain or lose effects, change their condition and disappear; nobody designs them. A gene's price is energy upkeep per tick while it is switched on.

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

- `server/server.js`, `server/codec.js`: the dependency-free sim server (worker threads + a minimal WebSocket) and the binary frame codec shared with the page.

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
