import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useEditor, EditorContent } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import markdownItMark from "markdown-it-mark";
import { Icon, type IconName } from "./icons";
import "./App.css";

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

// window sizes (pt). Landscape card hangs under the notch; minimized = time only.
// Proportions taken from design/*.png (@2x): mini 132×68, card 419×175.
const MINI = { w: 210, h: 60 }; // minimized: clock + phase only
const CARD = { w: 500, h: 248 }; // expanded: full landscape card
const NOTCH_GAP = 8; // breathing room between the physical notch and the widget
const SHADOW_ROOM = 20; // transparent px below the widget so its drop shadow isn't clipped
const SIDE_ROOM = 20; // transparent px each side, same reason (shadow spread)
const FLOAT_HOME = { x: 860, y: 80 };

const setPosOf = (cycle: number) => ((cycle - 1) % CYCLES_PER_SET) + 1;
const totalOf = (p: Phase, workMin: number) =>
  p === "work" ? workMin * 60 : p === "break" ? SHORT : p === "longbreak" ? LONG : 0;

// active (non-paused) elapsed ms for the current segment
function elapsedMs(m: Model): number {
  const livePause = m.paused ? Date.now() - m.pauseStart : 0;
  return Date.now() - m.segStart - m.pauseAcc - livePause;
}

const fmtRec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// WMO weather code → pixel icon (day/night aware)
type WeatherState = { temp: number; icon: IconName } | null;
function weatherIcon(code: number, day: boolean): IconName {
  if (code <= 1) return day ? "sun" : "moon"; // clear / mostly clear
  if (code <= 3 || code === 45 || code === 48) return "cloudFog"; // cloudy / fog
  return "cloudRain"; // drizzle, rain, snow, showers, storms
}

// ── rich notes editor (TipTap/ProseMirror, markdown on disk) ──
// the serializer escapes markdown chars in plain text (\_ etc.) — undo for display/paths
const unescMd = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!~])/g, "$1");

// ==highlight== round-trips through markdown; ⌘⇧B toggles it (Raycast Notes habit)
const MdHighlight = Highlight.extend({
  priority: 1000, // its ⌘⇧B must beat StarterKit's blockquote binding
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      "Mod-Shift-b": () => this.editor.commands.toggleHighlight(),
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
        parse: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setup(md: any) {
            md.use(markdownItMark);
          },
        },
      },
    };
  },
});

// Esc drops focus back to the widget (so its s/p/q keys work again)
const EscBlur = Extension.create({
  name: "escBlur",
  addKeyboardShortcuts() {
    return { Escape: () => this.editor.commands.blur() };
  },
});

// ⌘Enter checks/unchecks the todo under the caret — no mouse required
const KeyableTaskItem = TaskItem.extend({
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      "Mod-Enter": () => {
        const { $from } = this.editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name === this.name) {
            const pos = $from.before(d);
            return this.editor.commands.command(({ tr }) => {
              tr.setNodeAttribute(pos, "checked", !node.attrs.checked);
              return true;
            });
          }
        }
        return false;
      },
    };
  },
});

const EDITOR_EXTENSIONS = [
  StarterKit,
  TaskList,
  KeyableTaskItem.configure({ nested: true }),
  MdHighlight,
  EscBlur,
  Placeholder.configure({ placeholder: "- [ ] write a todo · # heading · plain lines too" }),
  Markdown.configure({ html: false, bulletListMarker: "-", breaks: true, transformPastedText: true }),
];

// blob → bare base64 (data-URL prefix stripped) for the save_memo IPC
const blobToB64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(",", 2)[1] ?? "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

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

  // adjustable work-session length (minutes), persisted across launches
  const [workMin, setWorkMinState] = useState(() => {
    const v = parseInt(localStorage.getItem("pomo.workMin") || "25", 10);
    return v >= 1 && v <= 120 ? v : 25;
  });
  const workMinRef = useRef(workMin);
  useEffect(() => {
    workMinRef.current = workMin;
  }, [workMin]);
  const setWorkMin = useCallback((v: number) => {
    const clamped = Math.max(1, Math.min(120, v));
    setWorkMinState(clamped);
    localStorage.setItem("pomo.workMin", String(clamped));
  }, []);

  // render-facing state
  const [phase, setPhase] = useState<Phase>("idle");
  const [cycle, setCycle] = useState(1);
  const [secs, setSecs] = useState(WORK); // remaining (countdown) or elapsed (sync)
  const [paused, setPaused] = useState(false);
  const [flash, setFlash] = useState(false);
  const [intro, setIntro] = useState(true); // launch reveal: clock springs in + doodle burst draws once
  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 2200);
    return () => clearTimeout(t);
  }, []);
  const [notesHover] = useState(false); // legacy hover flag (kept for key nav guard)
  const [notesPinned, setNotesPinned] = useState(false); // Cmd+P pinned open
  const [showCheat, setShowCheat] = useState(false); // "?" shortcut cheat sheet
  const showCheatRef = useRef(false);
  useEffect(() => {
    showCheatRef.current = showCheat;
  }, [showCheat]);

  // notch mode (the default home): the app lives behind the MacBook notch,
  // expands on hover / on cycle completion — dynamic island style. n → float.
  const [notchMode, setNotchMode] = useState(true);
  const [notchOut, setNotchOut] = useState(false); // expanded (hovered) vs tucked away
  const [notchH, setNotchH] = useState(32); // notch strip height, reported by the backend
  const notchModeRef = useRef(false);
  const notchOutRef = useRef(false);
  const peekUntil = useRef(0); // an announce-peek stays out until this timestamp
  useEffect(() => {
    notchModeRef.current = notchMode;
  }, [notchMode]);
  useEffect(() => {
    notchOutRef.current = notchOut;
  }, [notchOut]);

  const toggleNotch = useCallback(() => {
    setNotchOut(false);
    setNotchMode((v) => !v);
  }, []);

  // hover must work while ANY app is focused — an inactive window gets no DOM
  // mouseenter events, so poll a native global-pointer hit test instead. The
  // window is always card-sized, so we test only the VISIBLE sub-rect: the small
  // pill when collapsed, the full card when open (+8px slack for easy targeting).
  useEffect(() => {
    if (!notchMode) return;
    let outSince = 0;
    let alive = true;
    const winW = CARD.w + 2 * SIDE_ROOM;
    const top = notchH + NOTCH_GAP;
    const tick = async () => {
      if (!alive) return;
      const open = notchOutRef.current;
      const rw = open ? CARD.w : MINI.w;
      const rh = open ? CARD.h : MINI.h;
      const rect = { x: (winW - rw) / 2 - 8, y: top - 8, w: rw + 16, h: rh + 16 };
      const over = await invoke<boolean>("mouse_over", rect).catch(() => false);
      if (over) {
        outSince = 0;
        if (!notchOutRef.current) setNotchOut(true);
      } else if (notchOutRef.current) {
        // stay out while pinned notes or an announce-peek is running (recording
        // no longer holds it open — the pill shows the live waveform instead)
        if (notesPinnedRef.current || Date.now() < peekUntil.current) {
          outSince = 0;
        } else if (!outSince) {
          outSince = Date.now();
        } else if (Date.now() - outSince > 140) {
          outSince = 0;
          setNotchOut(false);
        }
      }
      if (alive) id = setTimeout(tick, 60);
    };
    let id = setTimeout(tick, 60);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [notchMode]);

  // cycle done → in notch mode the widget itself peeks out for 5s (hovering it
  // keeps it out); in float mode fall back to the macOS notification
  const announce = useCallback((label: string, dur: number) => {
    if (notchModeRef.current) {
      peekUntil.current = Date.now() + 5000;
      setNotchOut(true);
    } else {
      invoke("notify", { label, dur }).catch(() => {});
    }
  }, []);
  // the big landscape card (with notes) is shown whenever expanded or floating;
  // minimized (notch, not hovered) shows just the clock
  const cardOpen = !notchMode || notchOut;
  const showNotes = cardOpen; // notes live in the card now — no separate reveal
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

  // voice memo (sync mode only): mic → MediaRecorder → ~/.pomo/memos/
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [recErr, setRecErr] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recStart = useRef(0);
  const recDone = useRef<Promise<void> | null>(null); // resolves once the memo is saved
  // live spectrum while recording (drawn to every visible .wavecv canvas)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // weather (IP location → Open-Meteo, both free/no-key), refreshed hourly
  const [weather, setWeather] = useState<WeatherState>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // ipwho.is: HTTPS, CORS *, no key, generous limits
        const loc = await fetch("https://ipwho.is/").then((r) => r.json());
        if (!loc?.latitude) return;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current_weather=true`;
        const cw = (await fetch(url).then((r) => r.json()))?.current_weather;
        if (alive && cw)
          setWeather({ temp: Math.round(cw.temperature), icon: weatherIcon(cw.weathercode, cw.is_day === 1) });
      } catch {
        /* offline → just no weather */
      }
    };
    load();
    const id = setInterval(load, 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  // memo line appended to a note → mirrored into the open editor (survives mid-edit)
  const [memoAppend, setMemoAppend] = useState({ n: 0, line: "", name: "" });

  const sync = useCallback(() => {
    const cur = m.current;
    setPhase(cur.phase);
    setCycle(cur.cycle);
    setPaused(cur.paused);
    if (cur.phase === "sync") {
      setSecs(Math.floor(elapsedMs(cur) / 1000));
    } else if (cur.phase === "idle") {
      setSecs(workMinRef.current * 60);
    } else {
      setSecs(Math.max(0, cur.total - Math.floor(elapsedMs(cur) / 1000)));
    }
  }, []);

  // changing the work length re-times a running (or idle) work session live
  useEffect(() => {
    const cur = m.current;
    if (cur.phase === "work") {
      cur.total = workMin * 60;
      sync();
    } else if (cur.phase === "idle") {
      sync();
    }
  }, [workMin, sync]);

  const log = useCallback(
    (type: string, activeSec: number, cycleNum?: number, note?: string) => {
      const end = Date.now();
      const start = end - activeSec * 1000;
      return invoke("log_event", {
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

  // ── sync-mode voice memo ───────────────────────────────
  // stop the recorder; returns a promise that resolves once the file is saved
  const stopMemo = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (rec && rec.state !== "inactive") rec.stop(); // onstop does the save
    return recDone.current ?? Promise.resolve();
  }, []);

  const startMemo = useCallback(async () => {
    if (recRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // WKWebView records AAC natively; webm is the cross-engine fallback (dev browser)
      const mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm";
      const ext = mime === "audio/mp4" ? "m4a" : "webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      recChunks.current = [];
      recStart.current = Date.now();
      // tap the same stream for the live spectrum
      try {
        const actx = new AudioContext();
        actx.resume().catch(() => {});
        const analyser = actx.createAnalyser();
        analyser.fftSize = 512; // 256 bins — snappy spectrum response
        analyser.smoothingTimeConstant = 0.6;
        actx.createMediaStreamSource(stream).connect(analyser);
        audioCtxRef.current = actx;
        analyserRef.current = analyser;
      } catch {
        /* no waveform, recording still works */
      }
      let done: () => void = () => {};
      recDone.current = new Promise<void>((r) => (done = r));
      rec.ondataavailable = (e) => {
        if (e.data.size) recChunks.current.push(e.data);
      };
      rec.onstop = async () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
          analyserRef.current = null;
          audioCtxRef.current?.close().catch(() => {});
          audioCtxRef.current = null;
          const secs = Math.max(1, Math.round((Date.now() - recStart.current) / 1000));
          const blob = new Blob(recChunks.current, { type: mime });
          recChunks.current = [];
          if (!blob.size) return;
          const b64 = await blobToB64(blob);
          const path = await invoke<string>("save_memo", { dataB64: b64, ext }).catch(() => "");
          if (!path) return;
          await log("memo", secs);
          // drop a pointer into the active project note
          const name = await invoke<string>("active_note").catch(() => "");
          if (name) {
            const body = await invoke<string>("read_note", { name }).catch(() => "");
            const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const line = `- 🎤 sync memo ${stamp} (${fmtRec(secs)}) → ${path}`;
            await invoke("write_note", { name, content: `${body.replace(/\n*$/, "\n")}${line}\n` }).catch(
              () => {},
            );
            // mirror into the open editor so a mid-edit autosave doesn't drop the line
            setMemoAppend((p) => ({ n: p.n + 1, line, name }));
          }
        } finally {
          done();
        }
      };
      rec.start();
      recRef.current = rec;
      setRecSecs(0);
      setRecording(true);
    } catch {
      // mic denied / unavailable — flash the syncline
      setRecErr(true);
      setTimeout(() => setRecErr(false), 2500);
    }
  }, [log]);

  const toggleMemo = useCallback(() => {
    if (m.current.phase !== "sync") return;
    if (recRef.current) stopMemo();
    else startMemo();
  }, [startMemo, stopMemo]);

  // live rec duration while recording
  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSecs(Math.floor((Date.now() - recStart.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [recording]);

  // pixel frequency spectrum: chunky bars per band, heights quantized to a grid,
  // mirrored around the midline, live-dancing with the mic. Draws to every visible
  // .wavecv (pill layer + card layer both mount during the morph crossfade).
  useEffect(() => {
    if (!recording) return;
    const an = analyserRef.current;
    if (!an) return;
    const dpr = window.devicePixelRatio || 1;
    const CELL = Math.max(2, Math.round(3 * dpr)); // pixel grid unit
    const BAR = CELL * 2;
    const GAP = CELL;
    const color =
      getComputedStyle(document.documentElement).getPropertyValue("--amber").trim() || "#d98a2b";
    const bins = new Uint8Array(an.frequencyBinCount);
    const usable = Math.floor(an.frequencyBinCount * 0.55); // voice sits in the low bins
    let raf = 0;
    let frame = 0;
    const paint = (cv: HTMLCanvasElement) => {
      if (!cv.clientWidth) return;
      const w = Math.round(cv.clientWidth * dpr);
      const h = Math.round(cv.clientHeight * dpr);
      if (cv.width !== w) cv.width = w;
      if (cv.height !== h) cv.height = h;
      const N = Math.max(1, Math.floor((w + GAP) / (BAR + GAP)));
      const rows = Math.max(1, Math.floor(h / 2 / CELL));
      const g = cv.getContext("2d");
      if (!g) return;
      g.clearRect(0, 0, w, h);
      g.fillStyle = color;
      const mid = h / 2;
      const offX = Math.round((w - (N * (BAR + GAP) - GAP)) / 2); // center the bar group
      for (let i = 0; i < N; i++) {
        const s = Math.floor((i / N) * usable);
        const e = Math.max(s + 1, Math.floor(((i + 1) / N) * usable));
        let m = 0;
        for (let b = s; b < e; b++) m += bins[b];
        const v = Math.min(1, (m / (e - s) / 255) * 1.6); // gain (analyser pre-smooths)
        const cells = Math.max(1, Math.round(v * rows));
        const bh = cells * CELL * 2;
        g.fillRect(offX + i * (BAR + GAP), mid - bh / 2, BAR, bh);
      }
    };
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (frame++ % 2) return; // ~30fps, keeps the pixel steps readable
      an.getByteFrequencyData(bins);
      document.querySelectorAll<HTMLCanvasElement>("canvas.wavecv").forEach(paint);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  // memo playback (native afplay) — state lives here so audio survives the panel closing
  const [playingMemo, setPlayingMemo] = useState("");
  const togglePlayMemo = useCallback(
    async (path: string) => {
      if (playingMemo === path) {
        setPlayingMemo("");
        invoke("memo_stop").catch(() => {});
        return;
      }
      const ok = await invoke("memo_play", { path }).then(() => true).catch(() => false);
      setPlayingMemo(ok ? path : "");
    },
    [playingMemo],
  );
  // poll afplay so the ▶ chip resets when the memo runs out on its own
  useEffect(() => {
    if (!playingMemo) return;
    const id = setInterval(async () => {
      const on = await invoke<boolean>("memo_playing").catch(() => false);
      if (!on) setPlayingMemo("");
    }, 500);
    return () => clearInterval(id);
  }, [playingMemo]);

  // begin a fresh countdown / sync segment
  const startPhase = useCallback(
    (p: Phase, cycleNum: number) => {
      m.current = {
        phase: p,
        cycle: cycleNum,
        total: totalOf(p, workMinRef.current),
        segStart: Date.now(),
        pauseAcc: 0,
        pauseStart: 0,
        paused: false,
      };
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
      announce("WORK", Math.round(cur.total / 60));
      celebrate();
      startPhase(sp === CYCLES_PER_SET ? "longbreak" : "break", cur.cycle);
    } else if (cur.phase === "break" || cur.phase === "longbreak") {
      log("break", cur.total);
      const label = cur.phase === "longbreak" ? "LONG BREAK" : "BREAK";
      announce(label, Math.round(cur.total / 60));
      celebrate();
      startPhase("work", cur.cycle + 1);
    }
  }, [log, announce, celebrate, startPhase]);

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
    stopMemo(); // a memo can't outlive its sync — save whatever's recorded
    log("sync", Math.floor(elapsedMs(cur) / 1000));
    startPhase("work", cur.cycle); // redo the interrupted work session
  }, [log, startPhase, stopMemo]);

  const quit = useCallback(async () => {
    invoke("memo_stop").catch(() => {}); // don't leave an orphaned afplay talking
    await stopMemo().catch(() => {}); // flush an in-flight memo before the window dies
    const cur = m.current;
    if (cur.phase !== "idle") {
      const active = Math.floor(elapsedMs(cur) / 1000);
      // await: the window must not close before the final event lands on disk
      if (cur.phase === "work") await log("work", active, setPosOf(cur.cycle), "partial");
      else if (cur.phase === "sync") await log("sync", active);
      else await log("break", active, undefined, "partial");
    }
    await getCurrentWindow().close();
  }, [log, stopMemo]);

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

  // delete a project, fall back to whatever's left
  const deleteNote = useCallback(async (name: string) => {
    if (!name) return;
    await invoke("delete_note", { name }).catch(() => {});
    const [list, active] = await Promise.all([
      invoke<string[]>("list_notes").catch(() => [] as string[]),
      invoke<string>("active_note").catch(() => ""),
    ]);
    const body = active ? await invoke<string>("read_note", { name: active }).catch(() => "") : "";
    setNoteList(list);
    setActiveNote(active);
    setNoteBody(body);
  }, []);

  // window geometry: in notch mode the window stays permanently card-sized and
  // the morph animates INSIDE it — no per-toggle resize means no resize flicker.
  // Click-through (below) keeps the empty area from blocking other apps.
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
        h: notchH + NOTCH_GAP + CARD.h + SHADOW_ROOM,
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

  // click-through when collapsed so the big transparent window doesn't eat clicks
  // in empty space; interactive when expanded. Hover is detected natively regardless.
  useEffect(() => {
    if (!notchMode) {
      getCurrentWindow().setIgnoreCursorEvents(false).catch(() => {});
      return;
    }
    getCurrentWindow().setIgnoreCursorEvents(!notchOut).catch(() => {});
  }, [notchMode, notchOut]);

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
      if (notchModeRef.current) return; // docked to the notch — nothing to drag
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".notes-edit, .memos")) return; // editor + memo chips scroll themselves
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
      // ? toggles the cheat sheet
      if (e.key === "?") {
        setShowCheat((v) => !v);
        return;
      }
      // Esc closes the cheat sheet first, then the pinned panel
      if (k === "escape") {
        if (showCheatRef.current) setShowCheat(false);
        else setNotesPinned(false);
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
      else if (k === "m") toggleMemo();
      else if (k === "n") toggleNotch();
      else if (k === "p") togglePause();
      else if (k === " " || k === "enter") {
        e.preventDefault();
        skip();
      } else if (k === "q") quit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSync, toggleMemo, toggleNotch, togglePause, skip, quit, cycleNote]);

  // global hotkeys (⌃⌥…) emitted from the backend — work while any app is focused
  useEffect(() => {
    const un = listen<string>("hotkey", ({ payload }) => {
      if (payload === "sync") toggleSync();
      else if (payload === "pause") togglePause();
      else if (payload === "memo") toggleMemo();
      else if (payload === "notch") toggleNotch();
      else if (payload === "skip") skip();
      else if (payload === "peek") {
        // pop the widget out of the notch for a few seconds
        peekUntil.current = Date.now() + 4000;
        setNotchOut(true);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [toggleSync, togglePause, toggleMemo, toggleNotch, skip]);

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

  const total = totalOf(phase, workMin);
  const pct = !isSync && total > 0 ? Math.min(100, ((total - secs) / total) * 100) : 0;

  let tone = "ink";
  if (isSync) tone = "amber";
  else if (isBreak) tone = "mint";
  else if (phase === "work") {
    if (pct >= 80) tone = "err";
    else if (pct >= 50) tone = "mid";
  }

  const setPos = setPosOf(cycle);

  const clockHi = timeStr.split(":")[0];
  const clockLo = timeStr.split(":")[1];

  // pill (minimized) content — clock + status/spectrum
  const pillBody = (
    <>
      <div className="pill-clock">
        <span className="clockglyph">
          {clockHi}
          <span className="pill-colon">:</span>
          {clockLo}
        </span>
      </div>
      <div className="pill-side">
        {recording ? (
          <div className="pill-wave">
            <canvas className="wavecv" />
            <span className="pill-rectime">{fmtRec(recSecs)}</span>
          </div>
        ) : (
          <>
            <span className={`ptag tag-${tone}`}>{PHASE_LABEL[phase]}</span>
            {phase !== "idle" && !isSync && (
              <span className="pdots">
                {Array.from({ length: CYCLES_PER_SET }, (_, i) => (
                  <span key={i} className={`pdot ${i < setPos ? "on" : ""}`} />
                ))}
              </span>
            )}
          </>
        )}
      </div>
    </>
  );

  // card (expanded) content — left panel + controls, right notes, cheat overlay
  const cardBody = (
    <>
      <div className="card-l">
        <div className="panel">
          {weather && !(isSync && recording) && (
            <div className="panel-weather">
              <Icon name={weather.icon} size={13} />
              {weather.temp}°
            </div>
          )}
          <div className={`panel-time time-${tone} ${paused ? "is-paused" : ""}`}>
            <span className="clockglyph">
              {clockHi}
              <span className="panel-colon">:</span>
              {clockLo}
            </span>
          </div>

          {isSync && recording ? (
            <div className="panel-wave">
              <canvas className="wavecv" />
              <span className="rectime">{fmtRec(recSecs)}</span>
            </div>
          ) : isSync ? (
            <div className="panel-status">
              <span className="ptag tag-amber">{recErr ? "MIC BLOCKED" : "SYNC"}</span>
              <span className="synchint">▲ counting up</span>
            </div>
          ) : (
            <div className="panel-status">
              <span className={`ptag tag-${tone}`}>{PHASE_LABEL[phase]}</span>
              {phase !== "idle" && (
                <span className="pdots">
                  {Array.from({ length: CYCLES_PER_SET }, (_, i) => (
                    <span key={i} className={`pdot ${i < setPos ? "on" : ""}`} />
                  ))}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="ctl">
          <button
            className="cbtn"
            onClick={phase === "idle" ? start : togglePause}
            title={phase === "idle" ? "start" : paused ? "resume (p)" : "pause (p)"}
          >
            <Icon name={phase !== "idle" && !paused ? "pause" : "play"} size={18} />
          </button>
          <button className="cbtn" onClick={skip} disabled={phase === "idle"} title={isSync ? "end (space)" : "skip (space)"}>
            <Icon name="skipForward" size={18} />
          </button>
          <button
            className={`cbtn ${isSync ? "active" : ""}`}
            onClick={toggleSync}
            disabled={phase === "idle"}
            title="sync (s)"
          >
            <Icon name="circleNotch" size={18} />
          </button>
          {isSync && (
            <button className={`cbtn ${recording ? "rec" : ""}`} onClick={toggleMemo} title="voice memo (m)">
              <span className={recording ? "sq" : "dot"} />
            </button>
          )}
        </div>
      </div>

      <div className="card-r">
        <NotesPanel
          list={noteList}
          active={activeNote}
          body={noteBody}
          editNonce={editNonce}
          newNonce={newNonce}
          appendReq={memoAppend}
          playing={playingMemo}
          onTogglePlay={togglePlayMemo}
          onPrev={() => cycleNote(-1)}
          onNext={() => cycleNote(1)}
          onCreate={createNote}
          onDelete={deleteNote}
          onSaveBody={saveBody}
          onEditingChange={setEditing}
          onHelp={() => setShowCheat(true)}
          workMin={workMin}
          onSetWorkMin={setWorkMin}
        />
      </div>

      {showCheat && (
        <div className="cheat" onClick={() => setShowCheat(false)}>
          <div className="cheat-cols">
            <div>
              <div className="cheat-sec">global — work anywhere</div>
              <div className="cheat-grid">
                <kbd>⌃⌥S</kbd><span>sync on/off</span>
                <kbd>⌃⌥M</kbd><span>voice memo</span>
                <kbd>⌃⌥P</kbd><span>pause / resume</span>
                <kbd>⌃⌥↵</kbd><span>skip phase</span>
                <kbd>⌃⌥N</kbd><span>notch ⇄ float</span>
                <kbd>⌃⌥K</kbd><span>peek out</span>
              </div>
              <div className="cheat-sec">when focused</div>
              <div className="cheat-grid">
                <kbd>s p m n q</kbd><span>same, bare keys</span>
                <kbd>⌘P</kbd><span>notes / next</span>
                <kbd>←→</kbd><span>switch project</span>
              </div>
            </div>
            <div>
              <div className="cheat-sec">editor</div>
              <div className="cheat-grid">
                <kbd>⌘B</kbd><span>bold</span>
                <kbd>⌘⇧B</kbd><span>highlight</span>
                <kbd>⌘I</kbd><span>italic</span>
                <kbd>⌘⇧X</kbd><span>strikethrough</span>
                <kbd>#␣</kbd><span>heading</span>
                <kbd>-␣</kbd><span>bullet list</span>
                <kbd>-[]␣</kbd><span>todo</span>
                <kbd>⇥</kbd><span>nest sublist</span>
                <kbd>⇧⇥</kbd><span>un-nest</span>
                <kbd>⌘↵</kbd><span>toggle todo</span>
                <kbd>⌘Z</kbd><span>undo</span>
              </div>
            </div>
          </div>
        </div>
      )}
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
        {intro && !notchOut && <Burst top={notchH + NOTCH_GAP} />}
        <div
          className={`morph ${notchOut ? "open" : ""} ${flash ? "flash" : ""} ${intro ? "intro" : ""}`}
          style={morphVars}
          onMouseEnter={() => setNotchOut(true)}
        >
          <div className="morph-pill">{pillBody}</div>
          <div className="morph-card">{cardBody}</div>
        </div>
      </div>
    );
  }

  // ── FLOAT: the card as a draggable window ──
  return (
    <div className="floatwrap">
      <div className={`card ${flash ? "flash" : ""}`} data-tauri-drag-region="deep">
        {cardBody}
      </div>
    </div>
  );
}

// ── launch reveal: comic "alarm ringing" doodles that draw themselves outward
// around the pill (inside→out via stroke-dashoffset). Line shapes come straight
// from design/lines.svg, split into individual strokes and each anchored a gap
// away from the pill edge via translate(anchor) scale translate(-inner). ──
const S = 0.78; // scale the design strokes down to fit the 200×64 pill
// [ raw design subpath d, design inner point ix, iy, burst anchor ax, ay ]
const BURST: [string, number, number, number, number][] = [
  ["M60.5 6.5H2", 60.5, 6.5, 140, 22], // left-top horizontal
  ["M359.5 2H405", 359.5, 2, 360, 18], // right-top horizontal
  ["M195.5 102.5V138", 195.5, 102.5, 250, 80], // bottom center vertical
  ["M356 42.5L378 52", 356, 42.5, 360, 40], // right-mid tick
  ["M264.5 102.5L279.5 117.5", 264.5, 102.5, 302, 78], // bottom-right tick
  ["M117.5 97.5L108.5 117.5", 117.5, 97.5, 198, 78], // bottom-left tick
  [
    "M60.5 86.5L59.6697 87.4841C51.4245 97.2562 40.3648 104.246 28 107.5",
    60.5, 86.5, 150, 74,
  ], // lower-left arc
  [
    "M351.5 86.5L363.089 103.285C364.977 106.018 367.713 108.054 370.874 109.077L376.255 110.818C380.151 112.078 384.389 110.348 386.29 106.72L386.523 106.273C387.75 103.933 387.657 101.12 386.279 98.8653L386.111 98.5908C384.31 95.6444 380.658 94.4109 377.44 95.6624C375.282 96.5013 373.666 98.3348 373.105 100.58L372.567 102.733C372.193 104.229 372.126 105.785 372.369 107.308L373.014 111.339C373.645 115.283 375.82 118.814 379.058 121.153C381.621 123.004 384.701 124 387.862 124H388.108C391.908 124 395.581 122.63 398.453 120.141L401.5 117.5",
    351.5, 86.5, 352, 74,
  ], // lower-right arc + curl
];
function Burst({ top }: { top: number }) {
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
    <div className="burst" style={{ top: `${top}px` }}>
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

// ── notes/todo panel (per-project, editable) ───────────
function NotesPanel({
  list,
  active,
  body,
  editNonce,
  newNonce,
  appendReq,
  playing,
  onTogglePlay,
  onPrev,
  onNext,
  onCreate,
  onDelete,
  onSaveBody,
  onEditingChange,
  onHelp,
  workMin,
  onSetWorkMin,
}: {
  list: string[];
  active: string;
  body: string;
  editNonce: number;
  newNonce: number;
  appendReq: { n: number; line: string; name: string };
  playing: string;
  onTogglePlay: (path: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onCreate: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onSaveBody: (name: string, content: string) => void;
  onEditingChange: (editing: boolean) => void;
  onHelp: () => void;
  workMin: number;
  onSetWorkMin: (v: number) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // hamburger dropdown
  const [name, setName] = useState("");
  const [md, setMd] = useState(body); // latest markdown, for chips + copy
  const mdRef = useRef(body); // what the editor last serialized (loop guard)
  const contentNote = useRef(active); // which note the editor content belongs to
  const inputRef = useRef<HTMLInputElement>(null);
  const multi = list.length > 1;

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: body,
    onUpdate: ({ editor: ed }) => {
      const m = ed.storage.markdown.getMarkdown();
      mdRef.current = m;
      setMd(m);
      // save against the note the content belongs to, not whatever just became active
      onSaveBody(contentNote.current, m);
    },
    onFocus: () => onEditingChange(true),
    onBlur: () => onEditingChange(false),
    editorProps: { attributes: { class: "notes-rich", spellcheck: "false" } },
  });

  // pull file/project changes in: always on a project switch, otherwise only
  // when not actively typing (the file poll must not clobber the caret)
  useEffect(() => {
    if (!editor) return;
    const switching = contentNote.current !== active;
    if (!switching && (editor.isFocused || body === mdRef.current)) return;
    contentNote.current = active;
    mdRef.current = body;
    setMd(body);
    editor.commands.setContent(body, false);
  }, [editor, body, active]);

  // memo saved → splice its bullet into the live doc (the file already has it;
  // this keeps the next autosave from erasing the line mid-edit)
  useEffect(() => {
    const { n, line, name: target } = appendReq;
    if (!n || !line || !editor || target !== active) return;
    const path = line.split("→").pop()?.trim() ?? "";
    // dedup on the unique file path so remounts don't re-insert the same memo
    if (path && unescMd(mdRef.current).includes(path)) return;
    const text = line.replace(/^-\s*/, ""); // "🎤 sync memo … → /path"
    // insert a real bullet-list NODE — an HTML string would be escaped to literal
    // "<ul>…" text under Markdown(html:false), corrupting the note
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendReq, editor]);

  // memo lines → playable chips. Tolerant of both clean "- 🎤 … → /path" and
  // legacy escaped "<ul><li>🎤 … → /path</li></ul>" lines from the old bug.
  const memos = unescMd(md)
    .split("\n")
    .filter((l) => l.includes("🎤") && l.includes("→"))
    .map((l) => {
      const path = (l.split("→").pop() ?? "").replace(/<\/li>.*$/, "").trim();
      const label = (l.split("→")[0].match(/🎤(.*)$/)?.[1] ?? "")
        .replace(/<[^>]*>/g, "")
        .replace(/^\s*sync memo\s*/, "")
        .trim();
      return { label, path };
    })
    .filter((m) => m.path)
    .reverse(); // newest first

  // focus the editor, cursor at end — "ready to write"
  useEffect(() => {
    if (editNonce > 0 && editor) editor.commands.focus("end");
  }, [editNonce, editor]);

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
      {/* header: ‹ title › + compact icon toolbar */}
      <div className="notes-head">
        <button className="navbtn" onClick={onPrev} disabled={!multi || creating} title="prev project">
          <Icon name="angleLeft" size={13} />
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
          <Icon name="angleRight" size={13} />
        </button>

        {creating ? (
          <>
            <button className="iconbtn primary" onClick={submitCreate} disabled={!name.trim()} title="create">
              <Icon name="plus" size={14} />
            </button>
            <button className="iconbtn" onClick={() => { setCreating(false); setName(""); }} title="cancel">
              <Icon name="times" size={14} />
            </button>
          </>
        ) : (
          <>
            <button className="iconbtn" onClick={startCreate} title="new project">
              <Icon name="plus" size={14} />
            </button>
            {/* less-daily actions tucked behind a hamburger → more room for the title */}
            <div className="menuwrap">
              <button
                className={`iconbtn ${menuOpen ? "on" : ""}`}
                onClick={() => setMenuOpen((v) => !v)}
                title="more"
              >
                <Icon name="bars" size={14} />
              </button>
              {menuOpen && (
                <>
                  <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
                  <div className="menu">
                    {/* work-session length stepper */}
                    <div className="menu-stepper">
                      <Icon name="clock" size={13} />
                      <span className="menu-stepper-lbl">Cycle</span>
                      <button
                        className="stepbtn"
                        onClick={() => onSetWorkMin(workMin - 5)}
                        disabled={workMin <= 5}
                      >
                        −
                      </button>
                      <span className="menu-stepper-val">{workMin}m</span>
                      <button
                        className="stepbtn"
                        onClick={() => onSetWorkMin(workMin + 5)}
                        disabled={workMin >= 90}
                      >
                        +
                      </button>
                    </div>
                    <div className="menu-sep" />
                    <button
                      className="menu-item"
                      disabled={!md.trim()}
                      onClick={() => {
                        navigator.clipboard.writeText(md).catch(() => {});
                        setMenuOpen(false);
                      }}
                    >
                      <Icon name="copy" size={13} /> Copy note
                    </button>
                    <button
                      className="menu-item"
                      onClick={() => {
                        onHelp();
                        setMenuOpen(false);
                      }}
                    >
                      <Icon name="sun" size={13} /> Shortcuts
                    </button>
                    <button
                      className={`menu-item danger ${confirmDel ? "armed" : ""}`}
                      disabled={!active}
                      onClick={() => {
                        if (confirmDel) {
                          onDelete(active);
                          setConfirmDel(false);
                          setMenuOpen(false);
                        } else {
                          setConfirmDel(true);
                          setTimeout(() => setConfirmDel(false), 2500);
                        }
                      }}
                    >
                      <Icon name="trash" size={13} /> {confirmDel ? "Sure? delete" : "Delete project"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* voice memos referenced in this note — tap to play/stop (afplay) */}
      {memos.length > 0 && (
        <div className="memos">
          {memos.map((mm) => (
            <button
              key={mm.path}
              className={`memochip ${playing === mm.path ? "playing" : ""}`}
              onClick={() => onTogglePlay(mm.path)}
              title={mm.path}
            >
              <span className={playing === mm.path ? "sq" : "tri"} /> {mm.label}
            </button>
          ))}
        </div>
      )}

      {list.length === 0 ? (
        <div className="notes-empty">no projects — hit “+ new”</div>
      ) : (
        <div className="notes-edit" onClick={() => editor?.commands.focus()}>
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
}

export default App;
