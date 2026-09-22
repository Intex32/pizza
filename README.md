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
| Guests | `/order/<token>` | One order, live, with its QR and pickup code. |
| Either | `/t/<token>` | Where a scanned QR lands. Shows the guest their order; sends logged-in crew straight to the board. |
| Counter | `/crew/orders` | Everyone who has ordered and not yet paid. Search by name, tap **MOVE TO PREP** and say how they paid. Also **+ Walk-in** for someone who never pre-ordered. |
| Prep table | `/crew/prep` | A list of pizzas to build, oldest at the top. Each has a green **MOVE TO OVEN** button. Dings when a new one arrives. |
| Oven | `/crew/oven` | Everything the oven crew needs on one screen: what is waiting to go in, the decks and their slots, timers, the alarm. |
| Pickup | `/crew/ready` | Big numbers and names. Tap when handed over. |
| Anyone | `/crew/menu` | The pizza list: emoji, names, ingredients, bake times, sold-out. |
| Anyone | `/crew/admin` | All orders, how everyone paid, the shopping list, backups, deleting. |

The bar across the top of every crew screen shows `ORD · PREP · OVEN · READY` — one chip per
screen — so you can see how far behind you are without leaving your station. `OVEN` reads
`baking / total slots`; how many are waiting to go in is on the oven screen itself.

---

## Installing it on a device

The app is installable. Add it to a home screen and it opens full screen, with no address bar
and no tab strip — which on a wall tablet means more board and nothing to navigate away by
accident.

- **iPad / iPhone:** open the screen you want that device to be, then Share → **Add to Home
  Screen**. This is the one that matters for the kitchen, and it works over plain http.
- **Android:** Chrome's menu → **Add to Home screen**. You get an icon; whether it opens
  chrome-free depends on the browser (see the caveat below).

**Crew tablets and guests get different apps on purpose.** A tablet added from a crew screen
installs as **Crew** and opens at `/crew`, which redirects to whichever screen that tablet was
last parked on — so the oven tablet reopens on the oven. A guest's phone installs as **Pizza
Night** and opens on their own orders. Two manifests, picked by the path you install from.

### What it does not do, and why

**There is no service worker, and there cannot be one.** Browsers only expose that API in a
secure context, and a plain `http://192.168.x.x` address is not one — `navigator.serviceWorker`
is literally `undefined` there. That has two consequences:

- **No offline mode.** This is the right outcome anyway. Every screen here is a live view of
  one database; a cached shell showing last night's orders and a frozen oven timer would be
  worse than a screen that honestly says it is not live.
- **Over plain http, Android will not show a true install prompt.** Chrome dropped the
  service-worker requirement back in version 108, so **https is the only thing standing in the
  way** — the manifest here already satisfies everything else. Serve over https and Android
  offers a real install. iOS never had that requirement, which is why iPads get the full-screen
  treatment either way.

If you ever put the app behind https with a certificate the devices trust, Android installs
properly too — and nothing here needs changing for that.

---

## Tickets: the QR and the pickup code

Every order gets a **QR code** and a **five-character pickup code**, both shown on the guest's
own order page as soon as they order. It replaces "trust me, I'm Anna" at the counter.

**For the guest.** The code is on screen; **Download ticket (PDF)** saves the same thing as a
one-page file, which still shows the number, the name and the code if they wander off the
Wi-Fi. There is nothing to install and no account anywhere.

**For the crew.** Two ways in, and the second is the one you will actually use:

1. **Point your phone's own camera app** at the guest's QR. It opens the order directly. The
   very first time on a given phone it will say you are logged in somewhere else — log in once
   there and every scan after that goes straight through. The camera app opens links in the
   phone's *default* browser, so log in on that one.
2. **🔎 Find** in the top bar. The camera opens **by itself** and the order comes up as soon
   as it reads the code — one tap, and you never leave the app. The pickup-code field stays
   right underneath it, so you can type instead at any moment without turning anything off.
3. **🔎 Find**, then type the five characters. Faster than either, works when their battery is
   dead, and is the fallback whenever a camera will not cooperate.

Either way the app jumps to whichever screen that pizza is on and outlines it. **It never
changes anything** — you still tap the button yourself. If the pizza is somewhere no board
shows it, it says so instead of jumping:

- *"#42 Anna — already collected. Handed over 8:12 ago."* — the answer to "did we already give
  this person their pizza?", which no board can tell you.
- *"#42 Anna — cancelled (no-show)."*

The pickup code has no `O`, `I`, `0` or `1` in it, because those are the ones people mistype
reading a code off a phone screen. Case and hyphens do not matter. In the rare event two
orders share a code, it shows you both by name rather than guessing.

**The in-app scanner needs https, and simply hides itself without it.** Browsers only hand a
web page the camera in a "secure context" — over https, or on `localhost`. On a plain
`http://192.168.x.x` address `navigator.mediaDevices` is not blocked, it is *undefined*, so
the app feature-detects and shows the camera-app instructions instead of a button that could
never work. Three ways to have it:

- **Serve over https** (a real certificate and a hostname). Everything switches on by itself,
  on iOS as well as Android — no flag, no per-device setup.
- **Chrome only, one device:** paste the origin into
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, including the port. Safari has
  no equivalent.
- **Do nothing** and use the phone's own camera app, which has never had this restriction.

The decoder is [jsQR](https://github.com/cozmo/jsQR), bundled into the client — not the native
`BarcodeDetector`, which is missing on Windows and desktop Linux Chrome and would have left
the decode path impossible to test.

The camera is released the moment the sheet closes, the scan succeeds, or the component
unmounts. A `MediaStream` outlives the code that created it, and a forgotten one leaves the
camera light on after the crew member has walked away.

**No Apple or Google Wallet passes.** A `.pkpass` must be signed with a certificate from a paid
Apple Developer account or iOS refuses to open it at all, and Google Wallet needs a Google
Cloud account plus working internet on the guest's phone. The QR needs neither, works the same
on both platforms, and works with no internet at all.

---

## How a pizza moves

```
ORDERED ──► IN_PREPARATION ──► WAITING_FOR_OVEN ──► BAKING ──► READY ──► PICKED_UP
```

Every step goes **backwards** too, one step at a time — mis-taps happen. Cancelling is separate:
it is a flag on the order, not a step, and it is always reversible from the admin screen.

**Undo.** Every forward tap raises a toast with an **Undo** button for ten seconds.

**Moving a pizza on is always a button, never a tap on the card.** On the counter and prep
screens it is the big green **MOVE TO PREP** / **MOVE TO OVEN**. On the oven screen, taking a
pizza out asks first — every time, whether or not the timer has run out, because a blinking
card is exactly the one a sleeve is most likely to brush past. **No-show** asks too; it is
reversible either way, from the toast or the admin screen.

**Taking a pizza back out of the oven** asks first, because that is the one move that destroys a
timer it cannot get back. Moving a pizza between slots or decks never touches its timer.

**Raw in the middle?** A pizza on the ready board has a small `↩ oven` button. It comes back to
the Unplaced tray — its old slot was freed when it came out, and something else may be in it by
now — so give it a slot on the oven screen. Within two minutes it resumes the original timer
(it assumes a mis-tap); after that it starts a fresh bake.

---

## Money

Tapping **MOVE TO PREP** asks how they paid before the pizza goes anywhere:

| | |
|---|---|
| 💶 **Cash** | Money in the tin |
| 🅿️ **PayPal** | Paid on their phone |
| 🎁 **Free** | Crew, comped, on the house |

Nothing is pre-selected — the crew member has to say which, because a guess would quietly
corrupt the end-of-night reckoning. Walk-ins answer the same question as they are created,
in one tap.

It is stored on the order and shown on `/crew/admin`: a breakdown across the three methods
plus **Not paid yet**, and a column on every row. *Free* is counted on its own, so a comped
crew pizza never looks like one the counter forgot to record. Moving an order backwards
keeps the record (the money really did change hands); the **unpaid** button on a row clears
it properly for a genuine mis-tap.

---

## Sounds

Built for a loud room, and deliberately opposite shapes so you never have to think about
which is which:

- **A pizza is overdue in the oven** — four hard beeps warbling between two high pitches,
  roughly a smoke alarm. Repeats every 9s, tightening to every 4.5s once something has been
  over for a minute. Oven screen.
- **A new pizza has arrived to be made** — two *descending* notes, an octave lower and over
  in a third of the time, so it is obviously the less urgent of the two. Prep screen.

Why they sound like that: square waves rather than sine (a pure tone has no harmonics and is
trivially masked by kitchen noise), around 3 kHz (where the ear canal resonates and hearing
is most sensitive — the same reason smoke alarms sit there), warbling rather than steady (a
constant pitch fades into the background of a noisy room, and a changing one dodges a fan
whine that would mask a fixed one), and soft-clipped to add harmonics without ever hard
clipping the output. Measured at ~3.5× the loudness of an ordinary notification chime, with
the peak held just under full scale so nothing distorts.

Both need one tap to switch on, because tablets block audio until you interact with the
page — the crew login does it, or use the button on the screen itself. Muting is per device.
Tapping the sound button also plays that screen's sound, so you can check it in the room
before the night starts.

---

## The oven screen

One screen for the whole oven job: the queue of pizzas waiting to go in sits at the top, the
decks underneath. Whoever is loading the oven no longer has to switch screens to see what is
next.

**Decks and slots.** A deck is a named row with a set number of slots — one deck per oven
shelf, or one per oven, whatever matches your kitchen. Each deck has its own slot count
(1–12), because a deck nearest the fire may only take two while another takes six. Every slot
is drawn whether it is full or not, numbered left to right, so "it's in Deck 1 slot 3" is
something two people can actually say to each other.

**Putting a pizza in.** Tap one in *To go in*, then tap the slot you are putting it in — or
drag it there. Only the slots that would actually accept it light up. Drag is the nicety; tap
is what survives an oven mitt and a wet finger.

**Moving one that is already baking.** Drag it to another slot, or use the `⇄` button on its
card and then tap the destination. Dropping it on an occupied slot **swaps the two pizzas**.
Neither timer is touched by any move — a pizza that has been in for six minutes still says so.

**Dragging is off on phones**, deliberately. A draggable card has to claim every touch
gesture that starts on it, and on a phone the board is almost entirely cards — so the screen
became impossible to scroll. Tapping and the `⇄` button do the same job, so the drag is the
part that gives way. Tablets and desktops keep it, and there a swipe scrolls while a held
finger still starts a drag.

**Nudging a timer.** `−0:15` and `+0:15` on each baking card. Fine-grained on purpose: the
adjustment that actually gets used is "a bit longer", not "a whole minute longer". The value
sent is absolute, so a double-tap on bad wifi cannot silently add thirty seconds twice.

**A slot holds exactly one pizza.** That is enforced by the database, not just the screen, so
two people tapping the same empty slot at the same instant cannot double-book it — the second
one is told someone got there first. Putting a queued pizza onto a full slot is refused rather
than silently bumping the occupant out: there would be nowhere to put them.

**Unplaced** is always there. A pizza can bake without anyone recording where it went, and it
still counts, still times, still blinks. Use it when you are too busy to be precise.

**Changing the layout.** Tap **Edit decks** to add a deck, rename one, change its slot count,
reorder them, or delete one. Moving pizzas is switched off while you edit so the two gestures
cannot collide. The layout is stored on the server, so every tablet sees the same thing.

- **Fewer slots than pizzas?** Shrinking a deck moves any pizza in a slot that no longer exists
  to Unplaced, and tells you how many. Nothing vanishes.
- **Deleting a deck asks where its pizzas go** — another deck, or Unplaced. They fill the
  destination's free slots in order; any that do not fit land in Unplaced. The dialog says
  which before you commit. Timers keep running throughout. Nothing moves on its own, ever.

**Timers are server-anchored.** A tablet with a wrong clock still counts down correctly, and
restarting the server mid-bake changes nothing.

**When time is up** the card blinks and (if sound is on) it pings every 20 seconds. Tap it and
confirm to send it to the ready board. Nothing ever advances by itself — whether an overdue
pizza is perfect or ruined is your call, not the app's.

An iPad's physical silent switch mutes Web Audio regardless of the in-app setting.

---

## The menu

`/crew/menu`. Each pizza has an **emoji**, a name, an ingredient list and a bake time
(adjusted in 15-second steps, same as the oven).

The emoji is not decoration — it is what the crew actually recognise at a glance on every
screen, so pick ones that are easy to tell apart rather than literally correct. It is
snapshotted onto an order the same way the name is, so changing it never rewrites an order
someone already placed.

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
  you have taken payment and tapped MOVE TO PREP their button disappears.
- **Two people called Anna** are told apart by their order number and pizza, both of which are on
  every row and every card. The number is what to call out.
- **Silence means it is working.** There is no "Live" badge in the corner — a permanent green
  thing is noise, and it trains you to stop looking at the one spot that has to be believed
  when it does speak up. Nothing appears until the board has gone quiet for **10 seconds**,
  and then the corner shows **Not live · Ns**, counting up. At 30s a banner offers Retry; at
  60s the whole board greys out. A ticking number is used rather than a coloured dot on
  purpose: a dot can be painted by code that has already died, whereas a number that keeps
  moving is proving itself.
- **A tablet you have just woken** may flash "Not live" for about a second. That is honest —
  polling pauses while the screen is off, so the data really is old until the first poll
  lands.
- **Phones, tablets and desktops all work.** Below 760px the crew screens scroll like a
  normal page instead of locking to the viewport, the oven trays stack above the decks, and
  slots and buttons go full width. A phone is a perfectly good second prep station.
- **The top bar adapts rather than scrolling sideways.** Below 900px — which includes an iPad
  in portrait — Menu, Admin and Log out fold into a single **⋯** button, because they are the
  three things nobody touches mid-service. Below 760px the `ORD · PREP · OVEN · READY` counts
  drop onto their own full-width row, so the number you glance at from across a bench is never
  the thing that gets squeezed. 🍕 and **🔎 Find** stay put at every width. Nothing is ever
  parked off the right-hand edge where you cannot see it.
- **Tablets:** set the screen timeout to Never. The app asks to keep the screen awake, but
  that is another secure-context feature — over plain http it silently does nothing, and over
  https it works on its own.
- **One tab per device.** Nothing breaks with more, it is just wasted polling.
- **The QR contains the guest's order link, which is the key to their order.** Anyone who
  photographs it could cancel that order while it is still unpaid — so the page no longer
  prints the link in the open, only the QR and a pickup code that grants nothing. The code is
  useless without a crew login. A saved ticket PDF stops working once you purge after the
  event.
- **The QR is built from the address the guest actually used.** If the Pi's IP changes, old
  QRs stop resolving — give the Pi a DHCP reservation. The pickup code keeps working either
  way: it is derived from the order itself, not from any address.
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

## Building the client

```bash
npm run build
```

That type-checks and writes `client/dist/` — one HTML file, one JS bundle, one CSS bundle,
about 400 KB. `npm run serve` does this for you before starting, so during normal use you
never need to run it by hand; you only need it on its own when you are preparing files to
copy to the Pi.

`client/dist/` is gitignored — it is a build output, so rebuild it rather than committing it.

---

## Running it on a Raspberry Pi

Needs **Node 24 or newer** — the app runs TypeScript directly and uses Node's built-in SQLite,
so there is nothing to compile and no native module to build for ARM. NodeSource ships arm64
builds; Raspberry Pi OS's own `nodejs` package is usually far too old.

**⚠️ The two blocks below run on different machines.** `npm ci --omit=dev` installs express
and nothing else — run it on your laptop by mistake and it deletes TypeScript, Vite and React,
and `npm run build` stops working until you `npm install` again.

**1. On your laptop**, build the client:

```bash
npm run build
```

Then copy `server/`, `shared/`, `client/dist/`, `package.json`, `package-lock.json` and `.env`
to the Pi.

**2. On the Pi**, install just the runtime dependency and start it:

```bash
npm ci --omit=dev
node server/index.ts
```

Do **not** run `npm run serve` on the Pi — it would try to rebuild the client, and the build
tools are deliberately not installed there.

## Running it in Docker

A good fit: one runtime dependency (express) and Node's built-in SQLite, so there is no
native module to compile for ARM and the same image runs on a laptop and a Pi.

```bash
echo "CREW_PASSWORD=your-password-here" > .env
docker compose up -d --build
```

That is it — `http://<pi-ip>:3001`. The client is built *inside* the image, so there is no
way to accidentally ship a stale or missing bundle.

### The one thing you must not get wrong

**The `./data` volume in `compose.yaml` is what keeps your orders.** The database, the
backups and the deleted-orders log all live there. Take that line out and replacing the
container — any `--build`, any image update — destroys the evening.

Two related constraints:

- **It must be on the Pi's own disk.** SQLite in WAL mode needs real file locking; an NFS or
  SMB mount does not merely run slowly, it fails or corrupts.
- **It must be writable by uid 1000.** That is the default user on Raspberry Pi OS so it
  usually just works; if your user is a different uid, `sudo chown -R 1000:1000 ./data`.

Backups land in `./data/backups/` on the host, so `scp` gets them off the Pi — or use the
download links on the admin screen.

### Which machine builds the image?

Your laptop is x86_64 and the Pi is arm64, so **a plain `docker build` on the laptop produces
an image the Pi cannot run.** Two ways round it:

**Build on the Pi** (simplest — just run the two commands above there).

**Or cross-build on the laptop** and copy the image over, which keeps the Pi's SD card free of
build tooling. On the laptop:

```bash
docker buildx build --platform linux/arm64 -t pizza-night:arm64 --load .
docker image inspect pizza-night:arm64 --format '{{.Architecture}}'   # must print: arm64
docker save pizza-night:arm64 -o pizza-night-arm64.tar
scp pizza-night-arm64.tar pi@raspberrypi.local:~
```

Check that architecture line before copying. `buildx` with `--platform` is what makes it
arm64; a plain `docker build` silently produces an amd64 image that the Pi refuses to run,
and it is better to find that out in a second than after uploading 78 MB.

Then on the Pi:

```bash
docker load < pizza-night-arm64.tar
mkdir -p ~/pizza-data
docker run -d --name pizza --init --restart unless-stopped \
  -p 3001:3001 -e CREW_PASSWORD=your-password-here \
  -v "$HOME/pizza-data:/app/data" -u 1000:1000 pizza-night:arm64
```

The cross-build is emulated so it is slower than a native one, but nothing in this project
compiles — it is only JavaScript being copied around — so it takes about a minute.

Two details worth knowing:

- **Do not gzip the tarball.** `docker save` already emits compressed layers, so gzipping
  takes 78.3 MB down to 77.7 MB — not worth the step.
- **On Windows use `docker save -o file.tar`, never `docker save | ...`.** Piping binary
  through the PowerShell pipeline corrupts it.

### Day-to-day

```bash
docker compose logs -f          # every status change, one line each
docker compose restart          # timers are stored as timestamps, so nothing is lost
docker compose up -d --build    # after changing the code
```

Restarting mid-event is safe: bake timers are anchored to stored timestamps rather than to
anything held in memory.

