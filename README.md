# Armada

Battleship for up to 4 people, played on their own phones over the home wifi.

One person runs the server on a laptop. Everyone else scans a QR code and plays in
their browser. No app to install, no accounts, no internet connection required.

---

## Hosting a game

```bash
cd armada
npm install
npm start
```

The server prints a join URL and a QR code:

```
  Armada — Battleship on the home wifi

  On this device:  http://localhost:8080
  On your phone:   http://192.168.1.24:8080

  [ QR code ]

  Everyone has to be on the same wifi network.
```

Point a phone camera at the QR code, or type the URL in. First person in is the host
and gets the settings and the Start button.

Use `PORT=3000 npm start` if 8080 is taken.

### If phones can't reach it

- **Everyone must be on the same wifi.** Guest networks and "AP isolation" on some
  routers deliberately stop devices seeing each other — use the main network.
- **macOS** will show a "allow to find devices on your local network" prompt the first
  time. Say yes, or nobody can connect.
- **Windows** pops a Firewall dialog on first run. Allow it on *Private* networks.
- If the printed address doesn't work, the banner lists the other candidates it found.
  Try those — machines with Docker, a VPN, or several adapters can have more than one.

---

## How it plays

Everyone gets their own board. All the boards share the same coordinate system and the
same islands, so "G7" means the same square to everybody.

**The board grows with the table** — two players fight close quarters, four get room to
manoeuvre:

| Players | Board |
|---|---|
| 2 | 10×10 |
| 3 | 12×12 |
| 4 | 15×15 |

The size is fixed when the host starts the game, and the lobby shows you which board
you're about to get.

1. **Place your fleet.** Tap a ship, tap a square, choose Across or Down. Or hit
   Scramble for a random layout. Ships can't sit on land. Press *Lock fleet* when done —
   if the setup timer runs out first, whatever you haven't placed gets placed for you.
2. **Take turns.** On your turn, pick the player you want to attack from the tabs
   along the top, then tap a square on their waters and press FIRE.
3. **Sink everyone else.** Lose your whole fleet and you're out of the rotation, but
   you stay and watch the rest of the game.

### Queuing shots while you wait

You don't have to sit idle between turns. While it's somebody else's turn, tap — or
swipe a line across — an opponent's waters to **queue up to 8 shots**. They show up
numbered in firing order.

One queued shot fires automatically at the start of each of your turns, marked `[AUTO]`
in the combat log. Landing a hit does **not** stop the queue — you keep raking. What
scraps your plan is **taking** damage: the moment somebody hits you, your queue is
thrown away so you can react to being shot.

Tap a queued square again (or its chip in the bottom bar) to drop it, or *Clear* to
scrap the whole plan. Firing manually on your turn cancels that turn's queued shot but
keeps the rest of the queue for later. Your queue is private — nobody else can see what
you have plotted.

### The one rule that isn't normal Battleship

You attack **one player per turn**, so a single shot can never hit two people.

Each player keeps their own separate record of shots fired at *them*. That means the
same square can be fired at more than once in a game, as long as it's at different
people. Shooting G7 at Mom and later shooting G7 at Dad are two completely separate
shots with their own outcomes. Shooting G7 at Mom twice is not allowed.

### Fleet

Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2) — each player
gets one of each.

### Navies and superpowers

Pick a country in the lobby. Every navy gets the **same total firepower — 18 squares over
the whole game** — and differs only in the shape it arrives in, so the choice is style,
not strength.

| Navy | Strike | Squares | Times |
|---|---|---|---|
| USA | 3×3 block | 9 | 2 |
| Russia | line of 6 | 6 | 3 |
| China | 6 scattered in a 3×3 | 6 | 3 |
| Spain | 3×2 block | 6 | 3 |
| UK | line of 3 | 3 | 6 |
| Germany | 3 squares anywhere | 3 | 6 |
| Iran | 2-square strike | 2 | 9 |
| Japan | 1 pilot | 1 | 18 |

Japan is the odd one out: you choose how many pilots to send each turn, so all 18 can go
out at once or be dripped through the game.

### What's hiding in the water

Every board hides its own pickups — about 24 on a 12×12 — revealed only by shooting them.
The same square can be a mine for one player and open water for another.

- **Mine** — damages one of *your own* ships at random. Nobody else can see which, and it
  never appears on the public board, but the log says you struck one.
- **Radar** — shows you ships, mines and pickups in the 3×3 around the square you hit.
- **Spare shell** — fire again immediately.
- **Repair crew** — heals one hit on your fleet.
- **Supply crate** — one more superpower strike.

### The hurricane

Around round four a storm is announced, and a few rounds later a **3×3 eye wanders across
every board on a random track**, drawn so you can watch it coming. Ships caught in it are
picked up and dropped somewhere else — you don't choose where. They keep their damage,
but every shot marked in the eye is wiped, so a scattered ship effectively goes invisible
again. Mines and pickups get dragged along too, which means a minefield you'd mapped
stops being safe.

### Timers

The host sets both timers in the lobby, anywhere from 10 seconds to 10 minutes, or
off entirely. Both default to 2 minutes.

- **Turn timer** — run out and a random shot is fired for you at a random opponent,
  marked `[TIMEOUT]` in the log, then play moves on. Queue some shots and this stops
  being a wasted turn.
- **Setup timer** — run out and your unplaced ships are placed for you.

Settings lock once the game starts.

---

## If something goes wrong mid-game

Refreshing, locking your phone, or dropping off the wifi is fine — the browser
remembers who you are and puts you back in the same seat with your fleet intact. The
game doesn't wait for you, though: if it's your turn while you're away, the turn timer
still runs and will fire for you.

If the host quits the server the game is gone — nothing is saved to disk. Everyone's
screen will say so rather than hanging.

---

## Development

```
shared/    rules used by BOTH the server and the browser — no build step, no bundler
server/    HTTP + WebSocket, the single in-memory room, all the authoritative logic
client/    vanilla ES modules, one render() off a state object
tools/     the sprite-sheet generator (only run when the art changes)
```

`shared/` is plain ES modules with explicit `.js` extensions, imported directly by Node
and served to the browser at `/shared/`. Same files, both runtimes, nothing compiled.

The server is authoritative for everything. Ship positions are stripped per-recipient in
`server/redact.js`, so opening devtools doesn't show you where anyone's ships are until
they're sunk.

```bash
npm test        # unit tests: rules, terrain, placement, turn order, premoves, redaction, timers
```

### Art

Ships and islands are pixel art drawn in code and baked into one sprite sheet:

```bash
npm run sprites   # rewrites client/sprites.png + client/sprite-map.js
```

`tools/sprites/` has a dependency-free PNG encoder and a small software canvas, so the
art is authored in plain JS and the game still ships with no build step — the generated
sheet is committed. Edit `tools/sprites/ships.js` or `islands.js`, re-run the command,
and reload the page.

Islands are a 16-tile autotile set indexed by which neighbours are also land, so
coastlines join up across cells instead of looking like a grid of squares.

There's also a browser test that plays a real 3-player game and checks the mechanic
through the UI. It needs Playwright available:

```bash
node e2e/play.mjs
```

### Sound

Every effect is synthesised in the browser from oscillators and a noise buffer — there
are no audio files, so the game still works with no internet. The speaker button in the
top bar mutes it, and the choice is remembered on that device.

Browsers refuse to play audio until the player has interacted with the page, so sound
unlocks on the tap that joins the game. Two caveats worth knowing on a phone:

- **iPhones obey the physical silent switch.** If a phone is on silent, it stays silent
  no matter what the game does.
- Every phone plays its own audio. Events are mixed by whose they are — what happens to
  you is loudest, what you did is next, and everyone else's shots sit in the background —
  so three phones in one room don't shout over each other.
