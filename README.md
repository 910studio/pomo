# 🥔 pomo

A notch-native ops dashboard for macOS. It lives **behind the MacBook notch** (or top-center of the menu bar on a screen without one) and drops out like a Dynamic Island when you hover. It watches your server: the latest deploy, CPU / RAM / disk, service health, backups and live site traffic. It also has a file shelf you can drop things on.

Native Tauri app (Rust + React), ~9MB, no Electron. A [910studio](https://910.studio) joint. It started life as a pomodoro timer, which is still in the git history if you want it.

### ⬇️ [Download the latest release](https://github.com/910studio/pomo/releases/latest)

**One-line install** — downloads, installs, clears quarantine, and launches:

```bash
curl -fsSL https://raw.githubusercontent.com/910studio/pomo/main/install.sh | bash
```

**Or manually:** grab the `.dmg`, drag **pomo.app** into `/Applications`. It's **unsigned**, so macOS says it's *"damaged"* on first open — it isn't, that's just Gatekeeper flagging an unsigned download. Clear the quarantine flag once and it opens normally:

```bash
xattr -cr /Applications/pomo.app
```

```
        ▁▁▁▁▁▁▁▁▁         ← the notch
       ▕ ███████ ▏
   ╭───────────────────╮
   │ ● mbr      cpu ▓░░│   tucked: newest deploy (the color is the state)
   │  15h ago   ram ▓▓░│   + the box's vitals
   ╰───────────────────╯
              │ hover ↓ (smooth stretch)
   ╭──────────────┬──────────────────────────╮
   │ FLEET        │ ANTON · TODAY            │
   │ ● mbr    15h │ ● nair.mn     2 · 4.7k   │
   │ ● nair    4d │ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▅▇█   │
   │ ● protech 9d │ ● protech.mn  1 · 15     │
   │ svc ●●●●●●●● │ ▃▃▁▂▁▁▂▃▁▂▂▂▂▅▅▄▂▃▄▃▂▃   │
   │ bak 21h r2 … │ /shop/gaming         7   │
   ╰──────────────┴──────────────────────────╯
     deploys + health    traffic, last 24h
```

## What it does

- **Deploys:** the pill shows the most recent deploy as a dot plus the project name, colored by state: green **built**, blinking amber **building**, red **failed**. The card lists every project. Failed is inferred: a build that disappears without producing a new `:latest` image counts as dead.
- **Box health:** CPU / RAM / disk bars (red past 85%), a dot per service or container (red and blinking when down), and how old the newest local and offsite backups are (red after 36h).
- **Traffic:** per-site live visitors, visitors and views today, a 24h hourly sparkline, and the top pages, read straight from a self-hosted [Umami](https://umami.is).
- **Notch drop-zone:** a Yoink-style file shelf. Drag any file onto the widget and it stashes as a **pixelated preview chip**. Drag it back out into Finder, Slack or an upload field and a copy is delivered. Nothing is stored, and the shelf clears on quit.
- **Float mode:** flip out of the notch into an always-on-top floating window. A two-finger trackpad fling sends it to any screen corner.
- **Design:** the Minecraft typeface, cartoon hard-shadows, a cream / ink / rust palette. It shows over other apps' fullscreen Spaces.

## Where the data comes from

Every 10s pomo runs `ssh protech /usr/local/sbin/anton-probe` (the host alias is hard-coded in `src-tauri/src/lib.rs`) and parses pipe-delimited lines:

| Line | Meaning |
|------|---------|
| `V\|load\|1m 5m 15m\|nproc`, `V\|mem\|used\|total`, `V\|disk\|used\|size\|pct`, `V\|newest\|<name>-YYYYMMDDTHHMMSSZ.dump` | vitals + newest backup |
| `S\|name\|port\|kind\|state\|mem\|cpu` | a service / container (`healthy`, `running` or `active` = up) |
| `I\|image\|tag\|created\|id`, `D\|container\|started`, `B\|image\|elapsed_s\|tag` | images, deploys, live builds |
| `R\|bucket\|objects\|bytes\|newest_key\|newest_at` | offsite backups |
| `A\|name\|domain\|live_5m\|visitors\|views`, `P\|domain\|path\|views`, `H\|domain\|hours_ago\|views` | Umami: sites, top pages, hourly views |

To point pomo at your own box, change the host alias and emit the same lines. A project is any container running an image with the same name (`api` on `api:latest`).

## Keyboard

| Shortcut | Action |
|----------|--------|
| `⌃⌥N` | notch ⇄ float (works from any app) |
| `⌃⌥K` | peek the card out for a few seconds |
| `n` / `q` | the same toggle / quit, when the widget is focused |

## Run it

**Prereqs:** [Node](https://nodejs.org) + [pnpm](https://pnpm.io), [Rust](https://rustup.rs), and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/910studio/pomo.git
cd pomo
pnpm install
pnpm tauri dev      # run it
pnpm tauri build    # → src-tauri/target/release/bundle/macos/pomo.app (+ a .dmg)
```

## Credits

Built by [**910studio**](https://910.studio) — a global creative web studio.

Standing on: [Tauri](https://tauri.app) · the Minecraft typeface · a pixel FontAwesome-style icon set.

## License

MIT — do whatever.

---

<sub>A [910studio](https://910.studio) joint · made in Ulaanbaatar 🇲🇳</sub>
