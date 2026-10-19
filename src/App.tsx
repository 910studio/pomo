import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Icon } from "./icons";
import "./App.css";

// window sizes (pt). Landscape card hangs under the notch; the pill is the tucked state.
// Proportions taken from design/*.png (@2x): mini 132×68, card 419×175.
const MINI = { w: 210, h: 60 };
const CARD = { w: 500, h: 248 };
const NOTCH_GAP = 8; // breathing room between the physical notch and the widget
const SHADOW_ROOM = 20; // transparent px below the widget so its drop shadow isn't clipped
const SIDE_ROOM = 20; // transparent px each side, same reason (shadow spread)
const SHELF_ROOM = 112; // transparent px reserved below the card for the file shelf
const FLOAT_HOME = { x: 860, y: 80 };

// ── Anton (the droplet): deploys, box health, Umami ──
type Build = { img: string; state: "building" | "built" | "failed"; at: number };
type Svc = { name: string; ok: boolean };
// Umami, per site: today's numbers + last-24h hourly views (index 0 = oldest)
type Site = { domain: string; live: number; visitors: number; views: number; hours: number[] };
type Page = { domain: string; path: string; views: number };
type Anton = {
  cpu: number;
  mem: number;
  disk: number;
  build: Build | null; // what the pill shows: a live build, else the newest event
  projects: Build[]; // every project's latest state, newest first
  services: Svc[];
  backup: number; // newest local pg dump (ms epoch, 0 = none)
  offsite: number; // newest object in the R2 backups bucket
  sites: Site[];
  pages: Page[];
};
const ANTON_POLL = 10_000;
const BACKUP_STALE = 36 * 3600_000; // nightly backups → older than this is a miss
const ago = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`;
};
// The probe has no "failed" line, so infer it across polls: `live` remembers each
// build's start; one that vanishes without minting a newer :latest image died.
// `live`/`failed` are mutated — they're refs owned by the poller.
function readProbe(raw: string, live: Record<string, number>, failed: Record<string, number>): Anton {
  const now = Date.now();
  let cpu = 0, mem = 0, disk = 0, backup = 0, offsite = 0;
  const latest: Record<string, number> = {};
  const deployed: Build[] = [];
  const building: Build[] = [];
  const services: Svc[] = [];
  const sites: Site[] = [];
  const pages: Page[] = [];
  const hourly: [string, number, number][] = [];
  for (const line of raw.split("\n")) {
    const f = line.split("|");
    if (f[0] === "A") sites.push({ domain: f[2], live: +f[3], visitors: +f[4], views: +f[5], hours: Array(24).fill(0) });
    else if (f[0] === "P") pages.push({ domain: f[1], path: f[2], views: +f[3] });
    else if (f[0] === "H") hourly.push([f[1], +f[2], +f[3]]);
    else if (f[0] === "S") services.push({ name: f[1], ok: /^(healthy|running|active)$/.test(f[4]) });
    else if (f[0] === "R") offsite = Date.parse(f[5]) || 0;
    else if (f[0] === "V" && f[1] === "load") cpu = Math.min(1, parseFloat(f[2]) / +f[3]);
    else if (f[0] === "V" && f[1] === "mem") mem = +f[2] / +f[3];
    else if (f[0] === "V" && f[1] === "disk") disk = parseInt(f[4]) / 100;
    else if (f[0] === "V" && f[1] === "newest") {
      // umami-20261019T032015Z.dump
      const t = f[2]?.match(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/);
      if (t) backup = Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5], +t[6]);
    } else if (f[0] === "I" && f[2] === "latest") latest[f[1]] = Date.parse(f[3]);
    else if (f[0] === "D") deployed.push({ img: f[1], state: "built", at: Date.parse(f[2]) });
    // only tag latest = a deploy; other tags are test builds
    else if (f[0] === "B" && f[3] === "latest") building.push({ img: f[1], state: "building", at: now - +f[2] * 1000 });
  }
  for (const [img, start] of Object.entries(live)) {
    if (building.some((b) => b.img === img)) continue;
    if (!(latest[img] >= start - 5000)) failed[img] = now; // 5s slack for clock skew
    delete live[img];
  }
  for (const b of building) {
    live[b.img] = b.at;
    delete failed[b.img];
  }
  // per project: a live build wins, then a failure newer than the running deploy
  const projects = deployed.map(
    (d): Build =>
      building.find((b) => b.img === d.img) ??
      (failed[d.img] > d.at ? { img: d.img, state: "failed", at: failed[d.img] } : d),
  );
  // first-ever builds/failures have no container yet
  for (const b of building) if (!projects.some((p) => p.img === b.img)) projects.push(b);
  for (const [img, at] of Object.entries(failed))
    if (!projects.some((p) => p.img === img)) projects.push({ img, state: "failed", at });
  projects.sort((a, b) => b.at - a.at);
  const build = projects.find((p) => p.state === "building") ?? projects[0] ?? null;
  for (const [domain, ago, n] of hourly) {
    const s = sites.find((x) => x.domain === domain);
    if (s && ago < 24) s.hours[23 - ago] = n;
  }
  sites.sort((a, b) => b.views - a.views);
  return { cpu, mem, disk, build, projects, services, backup, offsite, sites, pages };
}
const fmtN = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const shortName = (img: string) => img.replace(/-api$/, "");

// cpu / ram / disk as thin bars (red past 85%)
function Bars({ a }: { a: Anton }) {
  return (
    <>
      {(
        [
          ["cpu", a.cpu],
          ["ram", a.mem],
          ["dsk", a.disk],
        ] as const
      ).map(([k, v]) => (
        <div key={k} className={`pbar ${v > 0.85 ? "hot" : ""}`}>
          <span>{k}</span>
          <i style={{ "--v": v } as CSSProperties} />
        </div>
      ))}
    </>
  );
}

// card's left half: every project's last deploy + whether the box is healthy
function FleetPanel({ a }: { a: Anton }) {
  const down = a.services.filter((s) => !s.ok).map((s) => s.name);
  const stale = (t: number) => !t || Date.now() - t > BACKUP_STALE;
  return (
    <div className="fleet">
      <div className="fleet-h">fleet</div>
      <div className="fleet-list">
        {a.projects.map((p) => (
          <div key={p.img} className={`fp b-${p.state}`}>
            <i className="pb-dot" />
            <span className="fp-name">{shortName(p.img)}</span>
            <span className="fp-ago">{ago(p.at)}</span>
          </div>
        ))}
      </div>
      <div className="fleet-health">
        <div className="fh" title={down.length ? `down: ${down.join(", ")}` : "all services up"}>
          <span>svc</span>
          <span className="svc-dots">
            {a.services.map((s) => (
              <i key={s.name} className={s.ok ? "" : "bad"} />
            ))}
          </span>
        </div>
        <div className="fh">
          <span>bak</span>
          <b className={stale(a.backup) ? "bad" : ""}>{a.backup ? ago(a.backup) : "—"}</b>
          <span>r2</span>
          <b className={stale(a.offsite) ? "bad" : ""}>{a.offsite ? ago(a.offsite) : "—"}</b>
        </div>
        <Bars a={a} />
      </div>
    </div>
  );
}

// card's right half: one row per site — today's numbers + 24h sparkline
function AntonBoard({ a }: { a: Anton }) {
  return (
    <div className="board">
      <div className="board-h">
        <span>anton · today</span>
        <span>live · visitors · views</span>
      </div>
      {a.sites.map((s) => {
        const max = Math.max(1, ...s.hours);
        return (
          <div key={s.domain} className="site">
            <div className="site-top">
              <span className={`live ${s.live ? "on" : ""}`} />
              <span className="site-name">{s.domain}</span>
              <span className="site-num">
                {s.live} · {fmtN(s.visitors)} · {fmtN(s.views)}
              </span>
            </div>
            <div className="spark" title="pageviews, last 24h">
              {s.hours.map((v, i) => (
                <i key={i} style={{ height: `${Math.max(v ? 8 : 0, (v / max) * 100)}%` }} />
              ))}
            </div>
          </div>
        );
      })}
      <div className="board-pages">
        {a.pages.slice(0, 2).map((p) => (
          <div key={p.domain + p.path}>
            <span>
              {p.domain}
              {p.path}
            </span>
            <b>{fmtN(p.views)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [intro, setIntro] = useState(true); // launch reveal: pill springs in + doodle burst draws once
  const [darkBg, setDarkBg] = useState(false); // what's behind the notch is dark → light-ink doodles
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 2200);
    return () => clearTimeout(t);
  }, []);

  // ── notch drop-zone: ephemeral file shelf. drop a file on the notch → it's held
  //    as a chip; drag it back out (a copy is delivered) and the chip is removed.
  //    nothing is stored — the shelf clears on quit. ──
  const [shelf, setShelf] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false); // a file-drag is live on screen
  const [removing, setRemoving] = useState<string[]>([]); // chips playing their pop-out
  const [previews, setPreviews] = useState<Record<string, { thumb: string; icon: string }>>({});
  const previewsRef = useRef(previews);
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);
  const dragOverRef = useRef(false);
  const draggingOutRef = useRef(false); // we're flinging a chip out → ignore self-drops
  const shelfRef = useRef<HTMLDivElement | null>(null); // hit-tested for click-through
  // ── click-through, one owner ──
  // macOS ignoresMouseEvents is all-or-nothing per WINDOW, and ours is permanently
  // 540×420 (card + shadow/shelf room) even when only the 210×60 pill shows. Flip it
  // from ONE place, deduped, driven by a native pointer hit test against the visible
  // rects — otherwise the transparent remainder eats clicks/scrolls in whatever app
  // sits under the notch (which is exactly what a stashed file used to do).
  const interactiveRef = useRef(true);
  const setInteractive = useCallback((on: boolean) => {
    if (interactiveRef.current === on) return;
    interactiveRef.current = on;
    getCurrentWindow().setIgnoreCursorEvents(!on).catch(() => {});
  }, []);
  const pressedRef = useRef(false); // a button is down → never yank interactivity mid-press
  // catch drops (Tauri window drag-drop) → stash the paths
  useEffect(() => {
    const un = getCurrentWindow().onDragDropEvent((e) => {
      const p = e.payload;
      if (draggingOutRef.current) return; // our own chip bounced back onto us — ignore
      if (p.type === "drop" && "paths" in p && p.paths.length) {
        // LIFO: newest drop goes to the front (and re-dropping moves it to front)
        setShelf((prev) => [...new Set([...p.paths, ...prev])]);
        setDragOver(false);
        dragOverRef.current = false;
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  // fetch a pixel preview for any freshly-stashed file
  useEffect(() => {
    shelf.forEach((path) => {
      if (previewsRef.current[path]) return;
      invoke<{ thumb: string; icon: string }>("file_preview", { path })
        .then((pv) => setPreviews((m) => ({ ...m, [path]: pv })))
        .catch(() => {});
    });
  }, [shelf]);
  // poll the native drag detector so the collapsed (click-through) notch wakes up
  // and becomes a real drop target the moment a file-drag starts anywhere on screen
  useEffect(() => {
    const id = setInterval(async () => {
      const active = await invoke<boolean>("drag_active").catch(() => false);
      if (active !== dragOverRef.current) {
        dragOverRef.current = active;
        setDragOver(active);
        // a drag just started: go interactive NOW (don't wait on the hover poll)
        // so the whole pill is live the instant the file arrives
        if (active) setInteractive(true);
        // drop the window to a droppable level while a drag is live, restore after
        invoke("drop_ready", { on: active }).catch(() => {});
      }
    }, 80);
    return () => clearInterval(id);
  }, [setInteractive]);
  // remove a chip with a pop-out animation, then drop it from state
  const removeChip = useCallback((path: string) => {
    setRemoving((r) => (r.includes(path) ? r : [...r, path]));
    setTimeout(() => {
      setShelf((s) => s.filter((x) => x !== path));
      setRemoving((r) => r.filter((x) => x !== path));
      setPreviews((m) => {
        const { [path]: _drop, ...rest } = m;
        return rest;
      });
    }, 200);
  }, []);
  // a chip only starts dragging out after the pointer MOVES a few px — a plain
  // click (or a tiny nudge) must not start a drag (that's what removed chips on
  // click: startDrag on mousedown + release-on-self counted as "Dropped").
  const pendingDrag = useRef<{ path: string; x: number; y: number } | null>(null);
  const armDrag = useCallback((path: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    pendingDrag.current = { path, x: ev.clientX, y: ev.clientY };
  }, []);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const pd = pendingDrag.current;
      if (!pd || Math.hypot(e.clientX - pd.x, e.clientY - pd.y) < 7) return;
      pendingDrag.current = null;
      const path = pd.path;
      const fire = (icon: string) => {
        draggingOutRef.current = true;
        startDrag({ item: [path], icon, mode: "copy" }, ({ result }) => {
          draggingOutRef.current = false;
          if (result === "Dropped") removeChip(path); // landed somewhere → copy delivered
        }).catch(() => {
          draggingOutRef.current = false;
        });
      };
      const cached = previewsRef.current[path]?.icon;
      if (cached) fire(cached);
      else invoke<string>("drag_icon").then(fire).catch(() => fire(""));
    };
    const down = () => {
      pressedRef.current = true;
    };
    const up = () => {
      pressedRef.current = false;
      pendingDrag.current = null; // released without moving → it was a click, do nothing
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [removeChip]);

  // notch mode (the default home): the app lives behind the notch / top-center of
  // the menu bar and expands on hover — dynamic island style. n → float.
  const [notchMode, setNotchMode] = useState(true);
  const [notchOut, setNotchOut] = useState(false); // expanded (hovered) vs tucked away
  const [notchH, setNotchH] = useState(32); // notch strip height, reported by the backend
  // sample what's actually behind the widget once it's docked (re-check when the
  // dock geometry settles) so the launch doodles contrast their real backdrop
  useEffect(() => {
    if (!notchMode) return;
    const t = setTimeout(() => {
      invoke<boolean>("bg_is_dark").then(setDarkBg).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [notchMode, notchH]);
  const notchModeRef = useRef(false);
  const notchOutRef = useRef(false);
  const peekUntil = useRef(0); // a ⌃⌥K peek stays out until this timestamp
  useEffect(() => {
    notchModeRef.current = notchMode;
  }, [notchMode]);
  useEffect(() => {
    notchOutRef.current = notchOut;
  }, [notchOut]);

  // poll Anton forever; a failed poll keeps the last picture rather than flicker
  const [anton, setAnton] = useState<Anton | null>(null);
  const antonLive = useRef<Record<string, number>>({});
  const antonFailed = useRef<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    let id = 0;
    const tick = async () => {
      const raw = await invoke<string>("anton_probe").catch(() => null);
      if (!alive) return;
      if (raw) setAnton(readProbe(raw, antonLive.current, antonFailed.current));
      id = window.setTimeout(tick, ANTON_POLL);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, []);

  const toggleNotch = useCallback(() => {
    setNotchOut(false);
    setNotchMode((v) => !v);
  }, []);

  // hover must work while ANY app is focused — an inactive window gets no DOM
  // mouseenter events, so poll the native global pointer instead. One native call
  // per tick gives us a window-local point; every rect test is done here in JS.
  // The window is always card-sized, so we test only the VISIBLE sub-rects: the
  // small pill when collapsed / the full card when open (+8px slack for easy
  // targeting), plus the shelf's live DOM box. Their union is also exactly the
  // region that may swallow the pointer — everything else stays click-through.
  useEffect(() => {
    if (!notchMode) return;
    let outSince = 0;
    let alive = true;
    const winW = CARD.w + 2 * SIDE_ROOM;
    const top = notchH + NOTCH_GAP;
    const tick = async () => {
      if (!alive) return;
      const [mx, my] = await invoke<[number, number]>("mouse_local").catch(() => [NaN, NaN]);
      const inRect = (x: number, y: number, w: number, h: number) =>
        mx >= x && mx <= x + w && my >= y && my <= y + h;

      const open = notchOutRef.current;
      const rw = open ? CARD.w : MINI.w;
      const rh = open ? CARD.h : MINI.h;
      const over = inRect((winW - rw) / 2 - 8, top - 8, rw + 16, rh + 16);
      // the shelf's real box (post-transform), +6px slack. Absent = no chips.
      const sr = shelfRef.current?.getBoundingClientRect();
      const overShelf = !!sr && inRect(sr.left - 6, sr.top - 6, sr.width + 12, sr.height + 12);

      if (over) {
        outSince = 0;
        // don't expand the card while a file-drag is live — keep the small pill
        // drop target instead of ballooning the zone to card size
        if (!notchOutRef.current && !dragOverRef.current) setNotchOut(true);
      } else if (overShelf || draggingOutRef.current) {
        // FREEZE on the shelf: neither open nor close. The shelf is anchored under
        // the morph, so toggling would slide it 188px out from under the cursor —
        // which then re-toggles, and the chips oscillate instead of being grabbable.
        outSince = 0;
      } else if (notchOutRef.current) {
        if (Date.now() < peekUntil.current) {
          outSince = 0;
        } else if (!outSince) {
          outSince = Date.now();
        } else if (Date.now() - outSince > 140) {
          outSince = 0;
          setNotchOut(false);
        }
      }

      // click-through everywhere the widget isn't actually drawn. Held button /
      // live chip drag pin it interactive so a gesture can't be cut in half.
      setInteractive(
        over ||
          overShelf ||
          dragOverRef.current ||
          draggingOutRef.current ||
          pressedRef.current ||
          !!pendingDrag.current
      );
      if (alive) id = setTimeout(tick, 60);
    };
    let id = setTimeout(tick, 60);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [notchMode, notchH, setInteractive]);

  // window geometry: in notch mode the window stays permanently card-sized and
  // the morph animates INSIDE it — no per-toggle resize means no resize flicker.
  // Click-through (above) keeps the empty area from blocking other apps.
  // On a COLD launch NSScreen isn't ready yet, so notch_dock can fail/mis-dock —
  // retry with backoff until it reports a valid notch/menu-bar height.
  useEffect(() => {
    if (!notchMode) {
      getCurrentWindow().setSize(new LogicalSize(CARD.w, CARD.h)).catch(() => {});
      return;
    }
    let alive = true;
    let tries = 0;
    const attempt = () => {
      invoke<number>("notch_dock", {
        w: CARD.w + 2 * SIDE_ROOM,
        h: notchH + NOTCH_GAP + CARD.h + SHADOW_ROOM + SHELF_ROOM,
        float: false,
      })
        .then((nh) => {
          if (!alive) return;
          if (nh) setNotchH(nh);
          else if (tries++ < 12) setTimeout(attempt, 200); // screen not ready → retry
        })
        .catch(() => {
          if (alive && tries++ < 12) setTimeout(attempt, 200);
        });
    };
    attempt();
    return () => {
      alive = false;
    };
  }, [notchMode, notchH]);

  // float mode is a normal window — always interactive. In notch mode the hover
  // poll above owns click-through per-rect (a blanket "shelf has chips → the whole
  // 540×420 frame is live" is what made the area under the notch dead to clicks
  // and scrolling for as long as a file was stashed).
  useEffect(() => {
    if (!notchMode) setInteractive(true);
  }, [notchMode, setInteractive]);

  // leaving notch mode → restore the floating window level + home position
  const wasNotch = useRef(false);
  useEffect(() => {
    if (wasNotch.current && !notchMode) {
      invoke("notch_dock", { w: 0, h: 0, float: true }).catch(() => {});
      getCurrentWindow()
        .setPosition(new LogicalPosition(FLOAT_HOME.x, FLOAT_HOME.y))
        .catch(() => {});
    }
    wasNotch.current = notchMode;
  }, [notchMode]);

  // PIP: 2-finger slide moves the window (clamped on-screen) and settles into the
  // nearest corner with inertia, biased by fling direction.
  useEffect(() => {
    const win = getCurrentWindow();
    const M = 16; // edge margin
    const TOP = 44; // clears the menu bar
    let pos: { x: number; y: number } | null = null;
    let scale = 1;
    const mon = { left: 0, top: 0, right: 0, bottom: 0 };
    const size = { w: 300, h: 480 };
    let vx = 0;
    let vy = 0; // smoothed velocity
    let selfMoveUntil = 0;
    let moveRaf = 0;
    let animRaf = 0;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let unMoved: () => void = () => {};
    let unResized: () => void = () => {};

    const clamp = (p: { x: number; y: number }) => ({
      x: Math.min(Math.max(p.x, mon.left + M), mon.right - size.w - M),
      y: Math.min(Math.max(p.y, mon.top + TOP), mon.bottom - size.h - M),
    });

    const put = (p: { x: number; y: number }) => {
      selfMoveUntil = performance.now() + 250;
      win.setPosition(new LogicalPosition(p.x, p.y)).catch(() => {});
    };

    const applyNow = () => {
      moveRaf = 0;
      if (!pos) return;
      pos = clamp(pos);
      put(pos);
    };

    let animating = false;
    let prevMag = 0;
    let peakMag = 0;
    let belowCount = 0;
    let lastTs = 0;

    const glide = () => {
      if (!pos) return;
      animating = true;
      const left = mon.left + M;
      const right = mon.right - size.w - M;
      const top = mon.top + TOP;
      const bottom = mon.bottom - size.h - M;
      const cx = pos.x + size.w / 2;
      const cy = pos.y + size.h / 2;
      // fling direction wins; otherwise nearest edge
      const tx = Math.abs(vx) > 1.5 ? (vx > 0 ? right : left) : cx < (mon.left + mon.right) / 2 ? left : right;
      const ty = Math.abs(vy) > 1.5 ? (vy > 0 ? bottom : top) : cy < (mon.top + mon.bottom) / 2 ? top : bottom;
      const step = () => {
        if (!pos) return;
        pos.x += (tx - pos.x) * 0.2;
        pos.y += (ty - pos.y) * 0.2;
        const done = Math.abs(tx - pos.x) < 0.5 && Math.abs(ty - pos.y) < 0.5;
        if (done) {
          pos = { x: tx, y: ty };
          animating = false;
        }
        put(pos);
        if (!done) animRaf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(animRaf);
      animRaf = requestAnimationFrame(step);
    };

    const commit = () => {
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      if (animating) return;
      if (moveRaf) {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
      }
      glide();
    };

    const onWheel = (e: WheelEvent) => {
      if (notchModeRef.current) return; // docked to the notch — nothing to drag
      e.preventDefault();
      if (!pos) return;
      const dx = -e.deltaX;
      const dy = -e.deltaY;
      const mag = Math.hypot(dx, dy);

      // while gliding: only a fresh, growing flick re-grabs; ignore the momentum tail
      if (animating) {
        if (mag > 6 && mag >= prevMag) {
          animating = false;
          cancelAnimationFrame(animRaf);
        } else {
          prevMag = mag;
          return;
        }
      }

      // new gesture if there was a real pause — start tracking fresh
      if (e.timeStamp - lastTs > 250) {
        peakMag = 0;
        belowCount = 0;
        vx = 0;
        vy = 0;
      }
      lastTs = e.timeStamp;
      prevMag = mag;

      pos.x += dx;
      pos.y += dy;
      vx = vx * 0.5 + dx * 0.5;
      vy = vy * 0.5 + dy * 0.5;
      if (!moveRaf) moveRaf = requestAnimationFrame(applyNow);

      // commit when the fling is clearly past its peak (filters single-frame jitter
      // and gradual momentum), so it's one arc into the corner — no follow-the-tail
      if (mag >= peakMag * 0.98) {
        if (mag > peakMag) peakMag = mag;
        belowCount = 0;
        if (endTimer) clearTimeout(endTimer);
        endTimer = setTimeout(commit, 120); // fallback for a steady drag that just stops
      } else if (++belowCount >= 2) {
        commit();
      }
    };

    (async () => {
      scale = (await win.scaleFactor().catch(() => 1)) || 1;
      const p = await win.outerPosition().catch(() => null);
      if (p) pos = { x: p.x / scale, y: p.y / scale };
      const s = await win.outerSize().catch(() => null);
      if (s) {
        size.w = s.width / scale;
        size.h = s.height / scale;
      }
      const m = await currentMonitor().catch(() => null);
      if (m) {
        const sf = m.scaleFactor;
        mon.left = m.position.x / sf;
        mon.top = m.position.y / sf;
        mon.right = (m.position.x + m.size.width) / sf;
        mon.bottom = (m.position.y + m.size.height) / sf;
      }
      unMoved = await win.onMoved(({ payload }) => {
        if (performance.now() < selfMoveUntil) return;
        pos = { x: payload.x / scale, y: payload.y / scale };
      });
      unResized = await win.onResized(({ payload }) => {
        size.w = payload.width / scale;
        size.h = payload.height / scale;
      });
    })();

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(moveRaf);
      cancelAnimationFrame(animRaf);
      if (endTimer) clearTimeout(endTimer);
      unMoved();
      unResized();
    };
  }, []);

  // ── keyboard (when focused): n notch ⇄ float · q quit ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") toggleNotch();
      else if (k === "q") getCurrentWindow().close().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleNotch]);

  // global hotkeys (⌃⌥…) emitted from the backend — work while any app is focused
  useEffect(() => {
    const un = listen<string>("hotkey", ({ payload }) => {
      if (payload === "notch") toggleNotch();
      else if (payload === "peek") {
        // pop the card out of the notch for a few seconds
        peekUntil.current = Date.now() + 4000;
        setNotchOut(true);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [toggleNotch]);

  // before the first probe lands, render the empty shape instead of nothing
  const a = anton ?? EMPTY;

  // pill (tucked): the newest deploy — state is the color (green built, blinking
  // amber building, red failed) — and the box's vitals
  const pillBody = (
    <>
      <div className={`pill-clock pill-build b-${a.build?.state ?? "none"}`}>
        <span className="pb-name">
          <i className="pb-dot" />
          {a.build ? shortName(a.build.img) : "anton"}
        </span>
        <span className="pb-meta">{a.build ? `${ago(a.build.at)} ago` : anton ? "no deploys" : "connecting…"}</span>
      </div>
      <div className="pill-side pill-bars">
        <Bars a={a} />
      </div>
    </>
  );

  // card (expanded): fleet on the left, traffic on the right
  const cardBody = (
    <>
      <div className="card-l">
        <FleetPanel a={a} />
      </div>
      <div className="card-r">
        <AntonBoard a={a} />
      </div>
    </>
  );

  const morphVars = {
    "--mini-w": `${MINI.w}px`,
    "--mini-h": `${MINI.h}px`,
    "--card-w": `${CARD.w}px`,
    "--card-h": `${CARD.h}px`,
  } as CSSProperties;

  // ── NOTCH: one container that stretches between pill and card (Figma-morph) ──
  if (notchMode) {
    return (
      <div className="notchwrap" style={{ paddingTop: `${notchH + NOTCH_GAP}px` }}>
        {intro && !notchOut && <Burst top={notchH + NOTCH_GAP} dark={darkBg} />}
        <div
          className={`morph ${notchOut ? "open" : ""} ${intro ? "intro" : ""} ${dragOver ? "drag" : ""}`}
          style={morphVars}
          onMouseEnter={() => setNotchOut(true)}
        >
          <div className="morph-pill">{pillBody}</div>
          <div className="morph-card">{cardBody}</div>
          {/* drop target overlay while a file-drag is live on screen */}
          {dragOver && (
            <div className="dropzone">
              <Icon name="plus" size={26} />
              <span>DROP FILE</span>
            </div>
          )}
        </div>
        {/* the shelf — stashed files sit below the pill; drag any chip back out
            into Finder. Visible the moment something is stashed (drop confirm). */}
        {shelf.length > 0 && (
          <div
            className="shelf"
            ref={shelfRef}
            style={{
              top: `${notchH + NOTCH_GAP + (notchOut ? CARD.h : MINI.h) + 10}px`,
              // explicit width (chip 66 + gap 8, + padding/border 24) so it can
              // animate elastically as chips add/remove instead of snapping
              width: `${Math.min(74 * shelf.length + 16, 336)}px`,
            }}
            // past 4 chips the row overflows: map a vertical trackpad swipe onto
            // scrollLeft (a horizontal-only scroller ignores deltaY on its own)
            onWheel={(e) => {
              const el = e.currentTarget;
              if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // native handles it
              if (el.scrollWidth <= el.clientWidth) return;
              el.scrollLeft += e.deltaY;
            }}
          >
            {shelf.map((p) => {
              const pv = previews[p];
              return (
                <div
                  key={p}
                  className={`shelfchip ${removing.includes(p) ? "removing" : ""}`}
                  title={p}
                  onMouseDown={(e) => armDrag(p, e)}
                  onDragStart={(e) => e.preventDefault()}
                >
                  {pv?.thumb ? (
                    <img className="pxprev" src={pv.thumb} alt="" draggable={false} />
                  ) : (
                    <span className="shelfico">
                      <Icon name="file" size={30} />
                    </span>
                  )}
                  <span className="shelfname">{p.split("/").pop()}</span>
                  <button
                    className="shelfx"
                    title="remove"
                    onMouseDown={(e) => {
                      // remove on PRESS so the chip's drag-out can't swallow it
                      e.stopPropagation();
                      e.preventDefault();
                      removeChip(p);
                    }}
                  >
                    <Icon name="times" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── FLOAT: the card as a draggable window ──
  return (
    <div className="floatwrap">
      <div className="card" data-tauri-drag-region="deep">
        {cardBody}
      </div>
    </div>
  );
}
const EMPTY = readProbe("", {}, {});

// ── launch reveal: comic "alarm ringing" doodles that draw themselves outward
// around the pill (inside→out via stroke-dashoffset). Line shapes come straight
// from design/lines.svg, split into individual strokes and each anchored a gap
// away from the pill edge via translate(anchor) scale translate(-inner). ──
const S = 0.78; // scale the design strokes down to fit the pill
// anchors give a clean ~14px gap off the 210×60 pill (spans x[145,355] in the burst)
// [ raw design subpath d, design inner point ix, iy, burst anchor ax, ay ]
const BURST: [string, number, number, number, number][] = [
  ["M60.5 6.5H2", 60.5, 6.5, 131, 24], // left-top horizontal
  ["M359.5 2H405", 359.5, 2, 369, 18], // right-top horizontal
  ["M195.5 102.5V138", 195.5, 102.5, 250, 80], // bottom center vertical
  ["M356 42.5L378 52", 356, 42.5, 369, 42], // right-mid tick
  ["M264.5 102.5L279.5 117.5", 264.5, 102.5, 302, 78], // bottom-right tick
  ["M117.5 97.5L108.5 117.5", 117.5, 97.5, 198, 78], // bottom-left tick
  [
    "M60.5 86.5L59.6697 87.4841C51.4245 97.2562 40.3648 104.246 28 107.5",
    60.5, 86.5, 137, 76,
  ], // lower-left arc
  [
    "M351.5 86.5L363.089 103.285C364.977 106.018 367.713 108.054 370.874 109.077L376.255 110.818C380.151 112.078 384.389 110.348 386.29 106.72L386.523 106.273C387.75 103.933 387.657 101.12 386.279 98.8653L386.111 98.5908C384.31 95.6444 380.658 94.4109 377.44 95.6624C375.282 96.5013 373.666 98.3348 373.105 100.58L372.567 102.733C372.193 104.229 372.126 105.785 372.369 107.308L373.014 111.339C373.645 115.283 375.82 118.814 379.058 121.153C381.621 123.004 384.701 124 387.862 124H388.108C391.908 124 395.581 122.63 398.453 120.141L401.5 117.5",
    351.5, 86.5, 361, 76,
  ], // lower-right arc + curl
];
function Burst({ top, dark }: { top: number; dark: boolean }) {
  // fresh random draw order every launch: shuffle evenly-spaced delay slots so
  // the strokes pop in a different sequence each time but stay nicely spread out
  const delays = useMemo(() => {
    const slots = BURST.map((_, i) => i * 0.055); // even spacing, no clustering
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    return slots.map((s) => s + Math.random() * 0.03); // + a little jitter
  }, []);
  return (
    <div className={`burst ${dark ? "light" : ""}`} style={{ top: `${top}px` }}>
      <svg viewBox="0 0 500 210" fill="none">
        {BURST.map(([d, ix, iy, ax, ay], i) => (
          <g key={i} transform={`translate(${ax} ${ay}) scale(${S}) translate(${-ix} ${-iy})`}>
            <path d={d} pathLength={1} style={{ animationDelay: `${0.26 + delays[i]}s` }} />
          </g>
        ))}
      </svg>
    </div>
  );
}


export default App;
