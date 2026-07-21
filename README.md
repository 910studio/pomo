# 🥔 pomo

A notch-native pomodoro widget for macOS. It lives **behind the MacBook notch** and drops out like a Dynamic Island when you hover — pixel-art timer, voice memos with a live spectrum, a real rich-text notepad per project, and glanceable weather. Built to stop you from doomscrolling and actually get your shit together.

Native Tauri app (Rust + React) — ~9MB, sips battery, no Electron. A [910studio](https://910.studio) joint.

### ⬇️ [Download the latest release](https://github.com/910studio/pomo/releases/latest)

**One-line install** — downloads, installs, clears quarantine, and launches:

```bash
curl -fsSL https://raw.githubusercontent.com/910studio/pomo/main/install.sh | bash
```

**Or manually:** grab the `.dmg`, drag **pomo.app** into `/Applications`. It's **unsigned**, so macOS says it's *"damaged"* on first open — it isn't, that's just Gatekeeper flagging an unsigned download. Clear the quarantine flag once and it opens normally:

```bash
xattr -cr /Applications/pomo.app
```

Prefer to build from source? [Jump to Run it](#run-it).

```
        ▁▁▁▁▁▁▁▁▁         ← the notch
       ▕ ███████ ▏
   ╭───────────────────╮
   │  11:11    WORK ●●○○│   minimized: just the clock, tucked under the notch
   ╰───────────────────╯
              │ hover ↓ (smooth stretch)
   ╭──────────┬────────────────────────╮
   │  ☁ 24°   │  ‹  Protech FE  ›  + ☰  │
   │  11:11   │  ── Today ────────────  │
   │  WORK ●● │  ☑ ship compare page    │
   │ ▐▐ ▶ ◍ ● │  ☐ wire notch mode      │
   ╰──────────┴────────────────────────╯
     clock + controls        rich notes
```

## What it does

**Two states, one morph.** By default it hides behind the notch showing only the time. Hover the notch and the card **stretches out** — the container animates its size while the content scales into place (Apple Dynamic-Island style). Move away and it tucks back. When a work/break block finishes, it peeks out on its own for a few seconds instead of firing a notification banner.

- **Classic pomodoro** — work × 4 → short breaks → long break, auto-starts on launch. Work length is adjustable (☰ menu, persisted).
- **Sync mode** — a count-up "interruption" timer for when something pulls you off-task, so the pomodoro doesn't lie about your focus time.
- **Voice memos** — while in sync mode, record a quick mic memo. It shows a **chunky pixel spectrum** that dances with your voice, saves to `~/.pomo/memos/`, drops a ▶ chip into the active project note, and plays back natively — all without leaving the widget.
- **Per-project rich notes** — a real [TipTap](https://tiptap.dev)/ProseMirror editor that reads/writes plain **Markdown on disk**. Bold, highlight, headings, checkboxes, and nested lists (`Tab` / `⇧Tab`). WYSIWYG in the widget, plain `.md` for everything else (Raycast, git, your editor).
- **Notch drop-zone** — a Yoink-style file shelf that lives in the notch. Drag any file onto the widget and it stashes as a **pixelated preview chip** (QuickLook thumbnail, downscaled to pixel art); drag it back out into Finder / Slack / an upload field and a copy is delivered. Ephemeral by design — nothing's stored, the shelf clears on quit. The doodle burst on launch even samples what's behind the notch so its lines stay visible on any wallpaper.
- **Weather** — temperature + a day/night-aware pixel icon in the panel corner ([Open-Meteo](https://open-meteo.com), located by IP, no key).
- **Float mode** — flip out of the notch into a classic always-on-top floating window with a PIP two-finger trackpad fling to any screen corner.
- **Design** — pixel-art icon set, the Minecraft typeface, cartoon hard-shadows, cream / ink / rust palette. Shows over other apps' fullscreen Spaces.

## Keyboard

Global `⌃⌥` hotkeys work **from any app** (a hover-widget can't hold key focus, so these are system-wide):

| Shortcut | Action |
|----------|--------|
| `⌃⌥S` | sync mode on/off |
| `⌃⌥M` | voice memo (in sync) |
| `⌃⌥P` | pause / resume |
| `⌃⌥↵` | skip phase |
| `⌃⌥N` | notch ⇄ float |
| `⌃⌥K` | peek the widget out |

When the widget is focused (float mode, or after clicking it), the bare keys `s p m n q` / `space` work too, plus `⌘P` for notes and `←→` to switch projects. Hit `?` for the in-app cheat sheet.

**Editor:** `⌘B` bold · `⌘⇧B` highlight · `⌘I` italic · `# ` heading · `- ` / `- [ ] ` lists · `Tab` nest · `⌘↵` toggle todo.

## Run it

**Prereqs:** [Node](https://nodejs.org) + [pnpm](https://pnpm.io), [Rust](https://rustup.rs), and Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/910studio/pomo.git
cd pomo
pnpm install
pnpm tauri dev      # run it
```

First voice memo will prompt for **microphone** access (macOS).

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

Everything lives in `~/.pomo/`, all plain files:

- `YYYY-MM-DD.jsonl` — daily session logs (work / break / sync / memo events)
- `notes/<project>.md` — per-project notes, plain Markdown
- `memos/YYYY-MM-DD_HHMMSS.m4a` — voice memos

## Credits

Built by [**910studio**](https://910.studio) — a global creative web studio.

Standing on: [Tauri](https://tauri.app) · [TipTap](https://tiptap.dev) · [Open-Meteo](https://open-meteo.com) + [ipwho.is](https://ipwho.is) for weather · the Minecraft typeface · a pixel FontAwesome-style icon set.

## License

MIT — do whatever.

---

<sub>A [910studio](https://910.studio) joint · made in Ulaanbaatar 🇲🇳</sub>
