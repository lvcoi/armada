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

Everyone gets their own 15×15 board. All the boards share the same coordinate
system and the same islands, so "G7" means the same square to everybody.

1. **Place your fleet.** Tap a ship, tap a square, choose Across or Down. Or hit
   Shuffle for a random layout. Ships can't sit on land. Press *I'm ready* when done —
   if the setup timer runs out first, whatever you haven't placed gets placed for you.
2. **Take turns.** On your turn, pick the player you want to attack from the tabs
   along the top, then tap a square on their waters and press FIRE.
3. **Sink everyone else.** Lose your whole fleet and you're out of the rotation, but
   you stay and watch the rest of the game.

### The one rule that isn't normal Battleship

You attack **one player per turn**, so a single shot can never hit two people.

Each player keeps their own separate record of shots fired at *them*. That means the
same square can be fired at more than once in a game, as long as it's at different
people. Shooting G7 at Mom and later shooting G7 at Dad are two completely separate
shots with their own outcomes. Shooting G7 at Mom twice is not allowed.

### Fleet

Carrier (5), Battleship (4), Cruiser (3), Submarine (3), Destroyer (2) — each player
gets one of each.

### Timers

The host sets both timers in the lobby, anywhere from 10 seconds to 10 minutes, or
off entirely. Both default to 2 minutes.

- **Turn timer** — run out and a random shot is fired for you at a random opponent,
  marked *(auto)* in the log, then play moves on.
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
```

`shared/` is plain ES modules with explicit `.js` extensions, imported directly by Node
and served to the browser at `/shared/`. Same files, both runtimes, nothing compiled.

The server is authoritative for everything. Ship positions are stripped per-recipient in
`server/redact.js`, so opening devtools doesn't show you where anyone's ships are until
they're sunk.

```bash
npm test        # 22 unit tests: rules, terrain, placement, turn order, redaction, timers
```

There's also a browser test that plays a real 3-player game and checks the mechanic
through the UI. It needs Playwright available:

```bash
node e2e/play.mjs
```
