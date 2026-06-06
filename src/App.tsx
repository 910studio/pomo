import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { ART } from "./art";
import "./App.css";

// mascot panel box (px) — each creature is scaled to fit by font-size.
// The art was drawn for a terminal grid where a cell is ~2× taller than wide,
// so we reproduce that cell ratio instead of rendering on square-ish cells.
const MASCOT_W = 258;
const MASCOT_H = 150;
const CHAR_W = 0.6; // monospace advance width ÷ font-size
const CELL_AR = 2.0; // terminal cell height ÷ width
const LINE_H = CHAR_W * CELL_AR; // line-height ÷ font-size  (= 1.2)
// largest font-size where w cols and h rows still fit the box at terminal proportions
const fitFont = (w: number, h: number) =>
  Math.min(MASCOT_W / (w * CHAR_W), MASCOT_H / (h * LINE_H));
const randomArt = () => Math.floor(Math.random() * ART.length);

// ── config (parity with ~/bin/pomo) ──────────────────────
const WORK = 25 * 60;
const SHORT = 5 * 60;
const LONG = 15 * 60;
const CYCLES_PER_SET = 4;

type Phase = "idle" | "work" | "break" | "longbreak" | "sync";

// internal timing model — lives in a ref so the tick never reads stale closures
interface Model {
  phase: Phase;
  cycle: number; // 1-based index of the current work session
  total: number; // total seconds for the active countdown phase
  segStart: number; // ms epoch when the active segment's timing began
  pauseAcc: number; // ms of accumulated paused time this segment
  pauseStart: number; // ms epoch when the current pause began
  paused: boolean;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: "READY",
  work: "WORK",
  break: "BREAK",
  longbreak: "LONG BREAK",
  sync: "SYNC",
};

// window sizes: compact by default, taller while notes are open (width never changes)
const SIZE_COMPACT = { w: 300, h: 480 };
const SIZE_NOTES = { w: 300, h: 660 };

const setPosOf = (cycle: number) => ((cycle - 1) % CYCLES_PER_SET) + 1;
const totalOf = (p: Phase) =>
  p === "work" ? WORK : p === "break" ? SHORT : p === "longbreak" ? LONG : 0;

// active (non-paused) elapsed ms for the current segment
function elapsedMs(m: Model): number {
  const livePause = m.paused ? Date.now() - m.pauseStart : 0;
  return Date.now() - m.segStart - m.pauseAcc - livePause;
}

function App() {
  const m = useRef<Model>({
    phase: "idle",
    cycle: 1,
    total: WORK,
    segStart: 0,
    pauseAcc: 0,
    pauseStart: 0,
    paused: false,
  });

  // render-facing state
  const [phase, setPhase] = useState<Phase>("idle");
  const [cycle, setCycle] = useState(1);
  const [secs, setSecs] = useState(WORK); // remaining (countdown) or elapsed (sync)
  const [paused, setPaused] = useState(false);
  const [flash, setFlash] = useState(false);
  const [artIdx, setArtIdx] = useState(randomArt); // a fresh creature each phase
  const [notesHover, setNotesHover] = useState(false); // hovering the bottom zone
  const [notesPinned, setNotesPinned] = useState(false); // Cmd+P pinned open
  const showNotes = notesHover || notesPinned;
  const notesHoverRef = useRef(false);
  const notesPinnedRef = useRef(false);
  useEffect(() => {
    notesHoverRef.current = notesHover;
  }, [notesHover]);
  useEffect(() => {
    notesPinnedRef.current = notesPinned;
  }, [notesPinned]);
  const [noteList, setNoteList] = useState<string[]>([]);
  const [activeNote, setActiveNote] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const editingRef = useRef(false); // textarea focused → don't clobber it from the file poll
  const [editNonce, setEditNonce] = useState(0); // bump → focus the editor (ready to write)
  const [newNonce, setNewNonce] = useState(0); // bump → open in "name a new project" mode
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sync = useCallback(() => {
    const cur = m.current;
    setPhase(cur.phase);
    setCycle(cur.cycle);
    setPaused(cur.paused);
    if (cur.phase === "sync") {
      setSecs(Math.floor(elapsedMs(cur) / 1000));
    } else if (cur.phase === "idle") {
      setSecs(WORK);
    } else {
      setSecs(Math.max(0, cur.total - Math.floor(elapsedMs(cur) / 1000)));
    }
  }, []);

  const log = useCallback(
    (type: string, activeSec: number, cycleNum?: number, note?: string) => {
      const end = Date.now();
      const start = end - activeSec * 1000;
      invoke("log_event", {
        payload: {
          event_type: type,
          start_ts: start / 1000,
          end_ts: end / 1000,
          cycle: cycleNum ?? null,
          note: note ?? null,
        },
      }).catch(() => {});
    },
    [],
  );

  const celebrate = useCallback(() => {
    setFlash(true);
    setTimeout(() => setFlash(false), 1400);
  }, []);

  // begin a fresh countdown / sync segment
  const startPhase = useCallback(
    (p: Phase, cycleNum: number) => {
      m.current = {
        phase: p,
        cycle: cycleNum,
        total: totalOf(p),
        segStart: Date.now(),
        pauseAcc: 0,
        pauseStart: 0,
        paused: false,
      };
      setArtIdx(randomArt());
      sync();
    },
    [sync],
  );

  // a countdown phase hit zero
  const onComplete = useCallback(() => {
    const cur = m.current;
    if (cur.phase === "work") {
      const sp = setPosOf(cur.cycle);
      log("work", cur.total, sp);
      invoke("notify", { label: "WORK", dur: Math.round(cur.total / 60) }).catch(() => {});
      celebrate();
      startPhase(sp === CYCLES_PER_SET ? "longbreak" : "break", cur.cycle);
    } else if (cur.phase === "break" || cur.phase === "longbreak") {
      log("break", cur.total);
      const label = cur.phase === "longbreak" ? "LONG BREAK" : "BREAK";
      invoke("notify", { label, dur: Math.round(cur.total / 60) }).catch(() => {});
      celebrate();
      startPhase("work", cur.cycle + 1);
    }
  }, [log, celebrate, startPhase]);

  // ── controls ───────────────────────────────────────────
  const start = useCallback(() => startPhase("work", 1), [startPhase]);

  const togglePause = useCallback(() => {
    const cur = m.current;
    if (cur.phase === "idle") return;
    if (cur.paused) {
      cur.pauseAcc += Date.now() - cur.pauseStart;
      cur.paused = false;
    } else {
      cur.pauseStart = Date.now();
      cur.paused = true;
    }
    sync();
  }, [sync]);

  const skip = useCallback(() => {
    const cur = m.current;
    if (cur.phase === "idle") return start();
    const active = Math.floor(elapsedMs(cur) / 1000);
    if (cur.phase === "work") {
      log("work", active, setPosOf(cur.cycle), "skipped");
      startPhase(setPosOf(cur.cycle) === CYCLES_PER_SET ? "longbreak" : "break", cur.cycle);
    } else if (cur.phase === "break" || cur.phase === "longbreak") {
      log("break", active);
      startPhase("work", cur.cycle + 1);
    } else if (cur.phase === "sync") {
      endSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, start, startPhase]);

  const toggleSync = useCallback(() => {
    const cur = m.current;
    if (cur.phase === "sync") return endSync();
    if (cur.phase === "idle") return;
    // interrupt the current phase, bank its active time, drop into count-up sync
    const active = Math.floor(elapsedMs(cur) / 1000);
    if (cur.phase === "work") log("work", active, setPosOf(cur.cycle), "interrupted");
    else log("break", active, undefined, "interrupted");
    startPhase("sync", cur.cycle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log, startPhase]);

  const endSync = useCallback(() => {
    const cur = m.current;
    if (cur.phase !== "sync") return;
    log("sync", Math.floor(elapsedMs(cur) / 1000));
    startPhase("work", cur.cycle); // redo the interrupted work session
  }, [log, startPhase]);

  const quit = useCallback(async () => {
    const cur = m.current;
    if (cur.phase !== "idle") {
      const active = Math.floor(elapsedMs(cur) / 1000);
      if (cur.phase === "work") log("work", active, setPosOf(cur.cycle), "partial");
      else if (cur.phase === "sync") log("sync", active);
      else log("break", active, undefined, "partial");
    }
    await getCurrentWindow().close();
  }, [log]);

  // ── tick: 1s, recomputes from timestamps, only repaints on change ──
  useEffect(() => {
    const id = setInterval(() => {
      const cur = m.current;
      if (cur.phase === "idle" || cur.paused) return;
      if (cur.phase === "sync") {
        setSecs(Math.floor(elapsedMs(cur) / 1000));
        return;
      }
      const remain = Math.max(0, cur.total - Math.floor(elapsedMs(cur) / 1000));
      if (remain <= 0) onComplete();
      else setSecs(remain);
    }, 1000);
    return () => clearInterval(id);
  }, [onComplete]);

  // cycle to prev/next project, persisting which one the widget shows
  const cycleNote = useCallback(
    async (delta: number) => {
      if (noteList.length < 2) return;
      const i = Math.max(0, noteList.indexOf(activeNote));
      const next = noteList[(i + delta + noteList.length) % noteList.length];
      setActiveNote(next);
      await invoke("set_active_note", { name: next }).catch(() => {});
      const body = await invoke<string>("read_note", { name: next }).catch(() => "");
      setNoteBody(body);
    },
    [noteList, activeNote],
  );

  // debounced autosave of the editable note body
  const saveBody = useCallback((name: string, content: string) => {
    setNoteBody(content);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (name) invoke("write_note", { name, content }).catch(() => {});
    }, 350);
  }, []);

  const setEditing = useCallback((v: boolean) => {
    editingRef.current = v;
  }, []);

  // create a new named project, switch to it
  const createNote = useCallback(async (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    await invoke("create_note", { name }).catch(() => {});
    await invoke("set_active_note", { name }).catch(() => {});
    const [list, body] = await Promise.all([
      invoke<string[]>("list_notes").catch(() => [] as string[]),
      invoke<string>("read_note", { name }).catch(() => ""),
    ]);
    setNoteList(list);
    setActiveNote(name);
    setNoteBody(body);
  }, []);

  // grow the window while notes are open, shrink back when closed
  useEffect(() => {
    const win = getCurrentWindow();
    const s = showNotes ? SIZE_NOTES : SIZE_COMPACT;
    win.setSize(new LogicalSize(s.w, s.h)).catch(() => {});
  }, [showNotes]);

  // Raycast → "open this project in the widget": poll the one-shot trigger file
  useEffect(() => {
    const id = setInterval(async () => {
      const proj = await invoke<string>("consume_open_request").catch(() => "");
      if (!proj) return;
      const win = getCurrentWindow();
      win.show().catch(() => {});
      win.setFocus().catch(() => {});
      setNotesPinned(true);
      if (proj === "__new__") {
        setNewNonce((n) => n + 1); // open straight into "name a new project"
        return;
      }
      const [list, body] = await Promise.all([
        invoke<string[]>("list_notes").catch(() => [] as string[]),
        invoke<string>("read_note", { name: proj }).catch(() => ""),
      ]);
      setNoteList(list);
      setActiveNote(proj);
      setNoteBody(body);
      setEditNonce((n) => n + 1); // focus the editor, ready to write
    }, 1000);
    return () => clearInterval(id);
  }, []);

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
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".notes-edit")) return; // editor scrolls itself
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

  // ── keyboard: s sync · p pause · space/enter skip · q quit · Cmd+P notes ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // never hijack keys while typing in an input (e.g. naming a new project)
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

      const k = e.key.toLowerCase();

      // Cmd+P: open the notes panel focused & ready to write; if pinned, flip project
      if (e.metaKey && k === "p") {
        e.preventDefault();
        if (notesPinnedRef.current) cycleNote(1);
        else {
          setNotesPinned(true);
          setEditNonce((n) => n + 1);
        }
        return;
      }
      // Esc closes the pinned panel
      if (k === "escape") {
        setNotesPinned(false);
        return;
      }
      // while notes are open, arrows navigate projects
      if (notesPinnedRef.current || notesHoverRef.current) {
        if (k === "arrowleft") {
          e.preventDefault();
          cycleNote(-1);
          return;
        }
        if (k === "arrowright") {
          e.preventDefault();
          cycleNote(1);
          return;
        }
      }
      // don't let ⌘-combos (copy, etc.) trigger the single-key timer controls
      if (e.metaKey) return;

      if (k === "s") toggleSync();
      else if (k === "p") togglePause();
      else if (k === " " || k === "enter") {
        e.preventDefault();
        skip();
      } else if (k === "q") quit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSync, togglePause, skip, quit, cycleNote]);

  // auto-start a work block the moment the widget launches (no manual click)
  useEffect(() => {
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // notes/todo: while the panel is open, re-read the active project note + list
  // so Raycast edits (and new projects) show live
  useEffect(() => {
    if (!showNotes) return;
    let alive = true;
    const load = async () => {
      try {
        const [list, active] = await Promise.all([
          invoke<string[]>("list_notes"),
          invoke<string>("active_note"),
        ]);
        if (!alive) return;
        setNoteList(list);
        setActiveNote(active);
        // don't overwrite what the user is actively typing
        if (!editingRef.current) {
          const body = active ? await invoke<string>("read_note", { name: active }) : "";
          if (alive) setNoteBody(body);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [showNotes]);

  // ── derived display ────────────────────────────────────
  const isSync = phase === "sync";
  const isBreak = phase === "break" || phase === "longbreak";
  const mins = Math.floor(secs / 60);
  const ss = secs % 60;
  const timeStr = `${String(mins).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  const total = totalOf(phase);
  const pct = !isSync && total > 0 ? Math.min(100, ((total - secs) / total) * 100) : 0;

  let tone = "ink";
  if (isSync) tone = "amber";
  else if (isBreak) tone = "mint";
  else if (phase === "work") {
    if (pct >= 80) tone = "err";
    else if (pct >= 50) tone = "mid";
  }

  const setPos = setPosOf(cycle);

  return (
    <div className={`widget ${flash ? "flash" : ""}`} data-tauri-drag-region="deep">
      <div className="bar">
        <span className="brand">POMO</span>
        <button className="x" onClick={quit} title="quit (q)">
          ✕
        </button>
      </div>

      <div className="phase">
        <span className={`tag tag-${tone}`}>{PHASE_LABEL[phase]}</span>
        {phase !== "idle" && !isSync && (
          <span className="dots">
            {Array.from({ length: CYCLES_PER_SET }, (_, i) => (
              <span key={i} className={`dot ${i < setPos ? "on" : ""}`} />
            ))}
          </span>
        )}
      </div>

      <div className={`time time-${tone} ${paused ? "is-paused" : ""}`}>
        {timeStr.split(":")[0]}
        <span className="colon">:</span>
        {timeStr.split(":")[1]}
      </div>

      {!isSync && (
        <div className="track">
          <div className={`fill fill-${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {isSync && <div className="syncline">● counting up — no limit</div>}

      <div className="controls">
        {phase === "idle" ? (
          <button className="btn primary" onClick={start}>
            start
          </button>
        ) : (
          <button className="btn" onClick={togglePause}>
            {paused ? "resume" : "pause"}
          </button>
        )}
        <button className="btn" onClick={skip} disabled={phase === "idle"}>
          {isSync ? "end" : "skip"}
        </button>
        <button className={`btn ${isSync ? "active" : ""}`} onClick={toggleSync} disabled={phase === "idle"}>
          sync
        </button>
      </div>

      <div className="hint">
        {showNotes ? "← → switch project · esc close" : "s · p · space · q   ·   ⌘P todos"}
      </div>

      {/* bottom zone: creature by default, hover → todo list (live from ~/.pomo/notes.md) */}
      <div
        className="bottom"
        onMouseEnter={() => setNotesHover(true)}
        onMouseLeave={() => setNotesHover(false)}
      >
        {showNotes ? (
          <NotesPanel
            list={noteList}
            active={activeNote}
            body={noteBody}
            editNonce={editNonce}
            newNonce={newNonce}
            onPrev={() => cycleNote(-1)}
            onNext={() => cycleNote(1)}
            onCreate={createNote}
            onSaveBody={saveBody}
            onEditingChange={setEditing}
          />
        ) : (
          <pre
            className="mascot"
            style={{
              fontSize: `${fitFont(ART[artIdx].w, ART[artIdx].h)}px`,
              lineHeight: `${fitFont(ART[artIdx].w, ART[artIdx].h) * LINE_H}px`,
              color: `rgb(${ART[artIdx].rgb[0]}, ${ART[artIdx].rgb[1]}, ${ART[artIdx].rgb[2]})`,
            }}
          >
            {ART[artIdx].lines.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}

// ── notes/todo panel (per-project, editable) ───────────
function NotesPanel({
  list,
  active,
  body,
  editNonce,
  newNonce,
  onPrev,
  onNext,
  onCreate,
  onSaveBody,
  onEditingChange,
}: {
  list: string[];
  active: string;
  body: string;
  editNonce: number;
  newNonce: number;
  onPrev: () => void;
  onNext: () => void;
  onCreate: (name: string) => Promise<void>;
  onSaveBody: (name: string, content: string) => void;
  onEditingChange: (editing: boolean) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState(body);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const pendingCaret = useRef<[number, number] | null>(null);
  const idx = Math.max(0, list.indexOf(active));
  const multi = list.length > 1;

  // pull file/project changes into the editor only when not actively typing
  useEffect(() => {
    if (!focusedRef.current) setText(body);
  }, [body]);

  // restore caret after a programmatic edit (bold/highlight/list-continue)
  useEffect(() => {
    if (pendingCaret.current && taRef.current) {
      const [s, e] = pendingCaret.current;
      taRef.current.setSelectionRange(s, e);
      pendingCaret.current = null;
    }
  }, [text]);

  // commit an edit + queue the caret position
  const applyEdit = (value: string, selStart: number, selEnd: number) => {
    setText(value);
    onSaveBody(active, value);
    pendingCaret.current = [selStart, selEnd];
  };

  // Raycast-Notes-style editor keys: ⌘B bold, ⌘⇧B highlight, Enter continues - lists
  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;

    if (e.key === "Escape") {
      el.blur();
      return;
    }

    // ⌘B bold (**), ⌘⇧B highlight (==)
    if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      const mark = e.shiftKey ? "==" : "**";
      const sel = value.slice(s, en);
      if (sel) {
        applyEdit(value.slice(0, s) + mark + sel + mark + value.slice(en), s + mark.length, en + mark.length);
      } else {
        const at = s + mark.length;
        applyEdit(value.slice(0, s) + mark + mark + value.slice(en), at, at);
      }
      return;
    }

    // Enter continues "- " and "- [ ]" lists (and exits on an empty item)
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && s === en) {
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const line = value.slice(lineStart, s);
      const todo = line.match(/^(\s*)- \[[ xX]\] (.*)$/);
      const bullet = line.match(/^(\s*)- (.*)$/);
      let prefix: string | null = null;
      let empty = false;
      if (todo) {
        prefix = `${todo[1]}- [ ] `;
        empty = todo[2].trim() === "";
      } else if (bullet) {
        prefix = `${bullet[1]}- `;
        empty = bullet[2].trim() === "";
      }
      if (prefix) {
        e.preventDefault();
        if (empty) {
          // empty marker → drop it, exit the list
          applyEdit(value.slice(0, lineStart) + value.slice(en), lineStart, lineStart);
        } else {
          const ins = "\n" + prefix;
          applyEdit(value.slice(0, s) + ins + value.slice(en), s + ins.length, s + ins.length);
        }
      }
    }
  };

  // focus the editor, cursor at end — "ready to write"
  useEffect(() => {
    if (editNonce > 0 && taRef.current) {
      const el = taRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editNonce]);

  // open straight into naming a new project
  useEffect(() => {
    if (newNonce > 0) {
      setCreating(true);
      setName("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [newNonce]);

  const submitCreate = async () => {
    await onCreate(name);
    setName("");
    setCreating(false);
  };

  const startCreate = () => {
    setCreating(true);
    setName("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="notes" data-tauri-drag-region="false">
      {/* nav row: arrows pinned to the edges, title centered + truncating (never shifts) */}
      <div className="notes-nav">
        <button className="navbtn" onClick={onPrev} disabled={!multi || creating} title="prev project">
          ‹
        </button>
        {creating ? (
          <input
            ref={inputRef}
            className="notes-input"
            placeholder="project name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              else if (e.key === "Escape") {
                e.stopPropagation();
                setCreating(false);
                setName("");
              }
            }}
          />
        ) : (
          <span className="notes-title">{active || "no projects"}</span>
        )}
        <button className="navbtn" onClick={onNext} disabled={!multi || creating} title="next project">
          ›
        </button>
      </div>

      {/* action row */}
      <div className="notes-actions">
        {creating ? (
          <>
            <button className="actbtn primary" onClick={submitCreate} disabled={!name.trim()}>
              create
            </button>
            <button className="actbtn" onClick={() => { setCreating(false); setName(""); }}>
              cancel
            </button>
          </>
        ) : (
          <>
            <button className="actbtn" onClick={startCreate} title="new project">
              + new
            </button>
            <span className="notes-count">{multi ? `${idx + 1}/${list.length}` : ""}</span>
            <button
              className="actbtn"
              onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
              disabled={!text.trim()}
            >
              copy
            </button>
          </>
        )}
      </div>

      {list.length === 0 ? (
        <div className="notes-empty">no projects — hit “+ new”</div>
      ) : (
        <textarea
          ref={taRef}
          className="notes-edit"
          spellCheck={false}
          placeholder={"- [ ] write a todo\n- [x] done\n\n# heading\nplain lines too"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onSaveBody(active, e.target.value);
          }}
          onFocus={() => {
            focusedRef.current = true;
            onEditingChange(true);
          }}
          onBlur={() => {
            focusedRef.current = false;
            onEditingChange(false);
          }}
          onKeyDown={onEditorKey}
        />
      )}
    </div>
  );
}

export default App;
