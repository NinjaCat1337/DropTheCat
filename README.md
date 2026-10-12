# DropTheCat — Meow Drop

A cozy cat puzzle inspired by *Drop the Cat*: slide the coloured holes under the cats of the same colour
and drop them all in. There is **no timer and no move limit**, so take your time, meow. Undo and Restart
are always free. This installable web app (PWA) is designed for iPhone and also works on desktop and
Android. Once loaded, it can run offline.

**Play:** https://ninjacat1337.github.io/DropTheCat/

## How to play

- Drag a hole. It slides along the grid and stops at walls, crates, other holes and cats of other colours.
- A cat drops into a hole of its own colour as soon as the hole covers it.
- The number on a hole is how many cats it still needs. A full hole closes and frees its space.
- Clear every hole to finish the level. When several holes share a colour, think about which hole takes
  which cats: a hole that closes too early can leave the others stranded.
- New things appear along the way:
  - **Ice:** a frozen cat blocks everything until the shown number of other cats has dropped.
  - **Boxes:** a box hides a cat and opens when a cat next to it drops.
  - **Arrows:** a hole with arrows slides only that way.
  - **Crates and key:** crates block the way until the cat wearing the key drops.
- Every 10th level is a **Hard** level and gives more coins.
- **Hint** shows a good next move. **Treat** calls the nearest cats of a hole's colour right into it.
  Both cost coins once your free ones are used up. Coins come from finished levels.
- The game notices when no hole can reach a cat of its colour anymore and offers Undo or Restart.

## Run locally

Node.js 22 or newer is required. Playing the game needs no installed dependencies.

```sh
npm start
```

Open http://localhost:8080/. If that port is busy, the server prints the next available address.
To test on an iPhone over Wi-Fi, open the network address printed by the server in Safari.

## Install on iPhone

1. Open the game in Safari and let it finish loading.
2. Tap **Share** and choose **Add to Home Screen**.
3. Leave **Open as Web App** enabled when that option is available, then tap **Add**.
4. Open the installed game while online once to prepare its offline cache.

## Publish updates

```sh
npm run stamp
git add -A
git commit -m "Describe the changes"
git push
```

`npm run stamp` updates the asset list and cache version in `sw.js` so installed apps receive the
update. GitHub Pages deployment and browser caches can delay when the new version becomes visible.

## Development

| Command | Purpose |
|---|---|
| `npm start` | Local server (port 8080, case-sensitive paths like GitHub Pages) |
| `npm test` | Unit tests: rules, sliding, solver, generator, every level in the pack |
| `npm run test:e2e` | Browser checks: touch drags replaying level solutions, undo/restart, hints, six screen sizes, save/resume, offline |
| `npm run levels` | Regenerates the level pack `src/core/level-data.js` (deterministic) |
| `npm run icons` | Generates PNG icons from `icons/icon.svg` |
| `npm run stamp` | Updates the service worker's asset list and cache version |

Browser checks and icon generation require `npm install` plus installed Chrome, Chromium, or Edge
(`CHROME_PATH` overrides detection).

Debug URL parameters: `?debug=1` exposes `window.__dropcat` and shows errors on screen, `?nosave=1`
disables storage, `?level=N` sets the next level to play.

```text
index.html, css/             Page shell and styles
src/core/                    Rules, levels, generator, solver, progress (pure, tested in Node)
src/ui/                      App controller, sliding input, scene rendering, art, particles
src/platform/                Storage, Web Audio, haptics, PWA, device helpers
sw.js, manifest.webmanifest  Offline cache and app metadata
tools/                       Local server, level generation, icons, cache stamping, art preview
tests/                       Unit and browser tests
```

## Credits

- Nunito: SIL Open Font License 1.1 (`fonts/OFL.txt`).
- All graphics and sounds are original and drawn or synthesized in code. No assets from the original game
  are used.
- This is an unofficial, noncommercial fan project with no affiliation to the creators of *Drop the Cat*.
