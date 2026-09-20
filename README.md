# 🍕 Pizza Night

Order management for an occasional pizza night. Guests pre-order from their phone with no
account; the crew work from one screen per stage, on whatever tablets you have.

---

## Quick start

Requires **Node 24 or newer** (`node -v`).

```bash
npm install
cp .env.example .env     # then edit it and set CREW_PASSWORD
npm run seed             # starter menu + two oven decks
npm run serve            # builds the client and starts on port 3001
```

Open `http://localhost:3001`. For the tablets, find your LAN address and use that instead:

```bash
ipconfig | findstr /i "IPv4"
```

The first run pops a Windows Firewall prompt — tick **Private**. If you dismissed it, from an
admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Pizza 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Profile Private -Action Allow
```

### Development

```bash
npm run dev
```

Vite on 5173 (use this one), API on 3001, both restart on save.

---

## The screens

Everything under `/crew` asks for the crew password once and then stays logged in. Park each
tablet on its own URL — the URL is the memory, so it survives a reload, a sleep and a reboot.

| Who | URL | What it is for |
|---|---|---|
| Guests | `/` | Their orders, live status. No login. |
| Guests | `/new` | Place an order. |
| Counter | `/crew/orders` | Everyone who has ordered and not yet paid. Search by name, take cash, tap **PAID → PREP**. Also **+ Walk-in** for someone who never pre-ordered. |
| Prep table | `/crew/prep` | Pizzas to build. Tap one when it is topped and ready for the oven. |
| Oven queue | `/crew/queue` | Built and waiting. Tap to put in the oven. |
| Oven | `/crew/oven` | Decks, drag-and-drop, timers, the alarm. |
| Pickup | `/crew/ready` | Big numbers and names. Tap when handed over. |
| Anyone | `/crew/menu` | The pizza list: names, ingredients, bake times, sold-out. |
| Anyone | `/crew/admin` | All orders, the shopping list, backups, deleting. |

The bar across the top of every crew screen shows `ORD · PREP · QUEUE · OVEN · READY` so you can
see how far behind you are without leaving your station.

---

## How a pizza moves

```
ORDERED ──► IN_PREPARATION ──► WAITING_FOR_OVEN ──► BAKING ──► READY ──► PICKED_UP
```

Every step goes **backwards** too, one step at a time — mis-taps happen. Cancelling is separate:
it is a flag on the order, not a step, and it is always reversible from the admin screen.

**Undo.** Every forward tap raises a toast with an **Undo** button for ten seconds.

**Taking a pizza back out of the oven** asks first, because that is the one move that destroys a
timer it cannot get back. Moving a pizza between decks never touches its timer.

**Raw in the middle?** A pizza on the ready board has a small `↩ oven` button. Within two minutes
it resumes the original timer (it assumes a mis-tap); after that it starts a fresh bake.

---

## The oven screen

- **Layers/decks** are yours to define — one per oven shelf, or one per oven. Tap **Edit layout**
  to add, rename, resize, reorder or delete them. The layout is stored on the server, so every
  tablet sees the same thing.
- **Two ways to place a pizza.** Drag it, or tap it and then tap a deck. The tap path exists
  because drag-and-drop on a greasy tablet at 21:00 is not something to rely on.
- **Capacity is advisory.** A deck set to 4 will happily take a 5th and turn amber. The pizza is
  already in the oven; the app records reality rather than refereeing it.
- **Unplaced** is always there. A pizza can bake without anyone recording where it is, and it
  still blinks when its time is up.
- **Deleting a deck asks where its pizzas go** — another deck, or Unplaced. Their timers keep
  running. Nothing moves on its own, ever.
- **Timers are server-anchored.** A tablet with a wrong clock still counts down correctly, and
  restarting the server mid-bake changes nothing.
- **When time is up** the card blinks and (if sound is on) it pings every 20 seconds. Tap it once
  to send it to the ready board. Nothing ever advances by itself — whether an overdue pizza is
  perfect or ruined is your call, not the app's.
- **Sound** needs one tap to switch on, because tablets block audio until you interact. The
  crew login does it for you; otherwise use the button on the oven screen. Note an iPad's
  physical silent switch mutes it regardless.

---

## The menu

`/crew/menu`. Each pizza has a name, an ingredient list and a bake time.

- **Sold out** takes effect immediately, no restart.
- **Retire** hides a pizza from guests while leaving every order that used it untouched. This is
  what you want almost always.
- **Delete** only works if no order has ever used that pizza; otherwise retire it.
- Renaming a pizza does **not** rewrite orders already placed — someone who ordered a
  "Margherita" keeps a "Margherita".
- Ingredients feed the shopping list on the admin screen.

---

## Before and after the night

**Before.** `/crew/admin` shows how many of each pizza have been ordered and rolls that into an
ingredient list. It counts *pizzas*, not grams — multiply by your own recipe.

**Closing intake.** `/crew/admin` → **Close orders**. The guest page then refuses new orders;
walk-ins still work.

**After.** On `/crew/admin`:

1. **Back up now**, and **download the file onto the tablet** — a backup that only lives on the
   server is not a backup.
2. **Delete ALL orders** (you have to type `DELETE`). A fresh backup is taken first, every
   deleted row is appended to `data/deleted-orders.log`, and numbering restarts at #1.

Pizza types and oven layers survive a purge, so you are ready for next time.

---

## Things worth knowing

- **Nothing is ever deleted except from the admin screen**, deliberately, with a confirmation.
  Cancel is what you want for a no-show — it is reversible and keeps the record.
- **A guest can cancel their own order**, but only while it is still unpaid and waiting. Once
  you have taken cash and tapped PAID → PREP their button disappears.
- **Two people called Anna** are told apart by their order number and pizza, both of which are on
  every row and every card. The number is what to call out.
- **The connection indicator** in the corner counts seconds since the last update. If it turns
  red and the board greys out, that screen is stale — check the Wi-Fi. A ticking number is used
  rather than a green dot on purpose: a dot can be painted by code that has already died.
- **Tablets:** set the screen timeout to Never. The app asks to keep the screen awake, but
  browsers only allow that over https, which a plain LAN address is not.
- **One tab per device.** Nothing breaks with more, it is just wasted polling.
- **Backups mid-event** are safe at any time from the admin screen. Do not copy `data/pizza.db`
  by hand — with WAL on, the newest orders live in the `-wal` file beside it and a plain copy
  would silently lose them.

---

## Files and data

```
data/pizza.db             the database
data/backups/             backups, newest first
data/deleted-orders.log   every order ever deleted, as JSON. Append-only.
.env                      CREW_PASSWORD, PORT
shared/                   types shared by the server and the browser
server/                   API. routes/public.ts is the entire unauthenticated surface.
client/src/               React app
```

**Changing the database schema** (only if you edit `server/schema.sql`): there is no migration
tool by design. Back up, delete `data/pizza.db*`, restart, re-seed. The server refuses to start
against a database whose shape no longer matches, and tells you this, rather than failing
halfway through service.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite + API with reload, for development |
| `npm run serve` | Build the client, then start — use this on the night |
| `npm run seed` | Starter menu and two decks, only if they are missing |
| `npm run seed -- --orders --force` | Add ~12 fake orders across every status, for trying the screens out. Refuses if any order exists. |
| `npm run backup` | Write a backup from the command line |
| `npm test` | Unit tests for the status rules |
| `npm run typecheck` | TypeScript, no build output |

---

## Running it on a Raspberry Pi

Needs **Node 24 or newer** — the app runs TypeScript directly and uses Node's built-in SQLite,
so there is nothing to compile and no native module to build for ARM. NodeSource ships arm64
builds; Raspberry Pi OS's own `nodejs` package is usually far too old.
Build on your laptop, then copy `server/`, `shared/`, `client/dist/`, `package.json`,
`package-lock.json` and `.env` across:

```bash
npm ci --omit=dev     # installs express and nothing else
node server/index.ts
```

Do **not** run `npm run serve` there — that rebuilds the client, and the build tools are not
installed by `--omit=dev`.
