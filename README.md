# 🍅 pomo

A cute little floating pomodoro timer for macOS. Anime ASCII creatures, cartoon shadows, per-project todos, and a PIP-style trackpad fling. Built to stop you from doomscrolling and actually get your shit together.

Native Tauri app (Rust + React) — ~8MB, sips battery, no Electron.

```
   ┌──────────────────┐
   │  POMO        ✕    │
   │     WORK          │
   │    23:14          │
   │  ████████░░░░     │
   │   ● ● ○ ○         │
   │   s · p · space   │
   │   (✦ creature ✦)  │
   └──────────────────┘
```

## Features

- **Floating widget** — borderless, always-on-top, no Dock icon (menubar-accessory style)
- **Classic pomodoro** — 25m work × 4 → 5m breaks → 15m long break, auto-starts on launch
- **Anime ASCII creatures** — a random character per phase
- **Per-project todos** — hover (or `⌘P`) to flip the creature into an editable todo list, one list per project
- **Raycast-Notes-style editor** — `Enter` continues `-`/`- [ ]` lists, `⌘B` bold, `⌘⇧B` highlight
- **PIP fling** — 2-finger trackpad slide to throw the window to any screen corner, with inertia
- **Native notifications** + daily session logging to `~/.pomo/`

## Keyboard

| Key | Action |
|-----|--------|
| `s` | sync mode (count-up, no limit) |
| `p` | pause / resume |
| `space` | skip phase |
| `q` | quit |
| `⌘P` | open todos / cycle projects |

## Run it

**Prereqs:** [Node](https://nodejs.org) + [pnpm](https://pnpm.io), [Rust](https://rustup.rs), and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/Ganaa0910/pomo.git
cd pomo
pnpm install
pnpm tauri dev      # run it
```

## Build the app

```bash
pnpm tauri build
```

Spits out `src-tauri/target/release/bundle/macos/pomo.app` (+ a `.dmg`). Drag the `.app` into `/Applications`.

> It's unsigned, so the first launch needs a **right-click → Open** (or `xattr -dr com.apple.quarantine /Applications/pomo.app`) to get past Gatekeeper. After that it just works.

## Raycast extension (optional)

A companion extension manages your project todos from Raycast — it opens them right in the widget.

```bash
cd raycast
npm install
npm run dev    # imports it into Raycast
```

Commands: **Edit Pomo Todos** (pick a project → opens in the widget) and **Add Pomo Todo** (quick capture).

## Data

Everything lives in `~/.pomo/`:
- `YYYY-MM-DD.jsonl` — daily session logs
- `notes/<project>.md` — your per-project todo lists

## License

MIT — do whatever.
