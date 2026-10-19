// pomo — Tauri backend: daily JSONL logging (parity with ~/bin/pomo) + native notify.
use chrono::{Local, TimeZone, Timelike};
use serde_json::json;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

fn pomo_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".pomo")
}

/// Unix seconds → local "HH:MM", matching the python tracker's strftime('%H:%M').
fn fmt_hm(ts: f64) -> String {
    match Local.timestamp_opt(ts as i64, 0).single() {
        Some(dt) => format!("{:02}:{:02}", dt.hour(), dt.minute()),
        None => "00:00".into(),
    }
}

#[derive(serde::Deserialize)]
struct LogPayload {
    event_type: String,
    start_ts: f64,
    end_ts: f64,
    cycle: Option<u32>,
    note: Option<String>,
}

/// Append one event to ~/.pomo/YYYY-MM-DD.jsonl in the EXACT existing schema:
/// {"type","start","end","duration_m",[cycle],[note]}
#[tauri::command]
fn log_event(payload: LogPayload) -> Result<(), String> {
    let dir = pomo_dir();
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    let file = dir.join(format!("{today}.jsonl"));

    // round((end - start) / 60, 1) — same as the python tracker.
    let dur = (((payload.end_ts - payload.start_ts) / 60.0) * 10.0).round() / 10.0;

    // preserve_order keeps key order: type, start, end, duration_m, cycle, note.
    let mut entry = json!({
        "type": payload.event_type,
        "start": fmt_hm(payload.start_ts),
        "end": fmt_hm(payload.end_ts),
        "duration_m": dur,
    });
    if let Some(c) = payload.cycle {
        entry["cycle"] = json!(c);
    }
    if let Some(n) = payload.note {
        entry["note"] = json!(n);
    }

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", entry).map_err(|e| e.to_string())?;
    Ok(())
}

/// Native macOS notification titled "POMO" with the Glass sound — parity with the python notify().
#[tauri::command]
fn notify(label: String, dur: u32) {
    // labels are fixed ("WORK", "BREAK", "LONG BREAK") so no quote-escaping needed.
    let script = format!(
        "display notification \"{label} done · {dur}min\" with title \"POMO\" sound name \"Glass\""
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

/// Persist a sync-mode voice memo (base64 audio from the webview's MediaRecorder)
/// to ~/.pomo/memos/YYYY-MM-DD_HHMMSS.<ext>. Returns the absolute path written.
#[tauri::command]
fn save_memo(data_b64: String, ext: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let bytes = STANDARD.decode(data_b64).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty recording".into());
    }
    let dir = pomo_dir().join("memos");
    create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe_ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let ts = Local::now().format("%Y-%m-%d_%H%M%S").to_string();
    let file = dir.join(format!("{ts}.{safe_ext}"));
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// The notch-peek announcement keeps the notification's Glass sound, minus the banner.
#[tauri::command]
fn ding() {
    let _ = std::process::Command::new("afplay")
        .arg("/System/Library/Sounds/Glass.aiff")
        .spawn();
}

// ── notch mode: dock the widget under the MacBook notch, Dynamic Island style ──
// AppKit only lets a window sit in the menu-bar band when its level is above
// NSMainMenuWindowLevel; Tauri doesn't expose levels, so we talk to NSWindow raw.
#[cfg(target_os = "macos")]
unsafe fn notch_dock_impl(window: &tauri::WebviewWindow, w: f64, h: f64, float: bool) -> Result<f64, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = MainThreadMarker::new().ok_or("not on main thread")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
    let ns: &NSWindow = &*ptr;

    if float {
        // back to the normal floating widget (NSFloatingWindowLevel = 3)
        ns.setLevel(3);
        ns.setCollectionBehavior(NSWindowCollectionBehavior::Default);
        return Ok(0.0);
    }

    // prefer the notched display; fall back to the main screen
    let mut target = NSScreen::mainScreen(mtm).ok_or("no screen")?;
    let mut notch = 0.0f64;
    for s in NSScreen::screens(mtm).iter() {
        let t = s.safeAreaInsets().top;
        if t > notch {
            notch = t;
            target = s;
        }
    }
    let strip = if notch > 0.0 { notch } else { 24.0 }; // no notch → menu-bar height
    let h = if h <= 0.0 { strip } else { h }; // h=0 → collapsed to just the strip

    let f = target.frame(); // global coords, origin bottom-left
    // cold launch: NSScreen can report a degenerate frame before it's ready —
    // bail so the frontend retries instead of docking the window off-screen
    if f.size.width < 200.0 || f.size.height < 200.0 {
        return Err("screen not ready".into());
    }

    // ScreenSaver level (1000) sits above fullscreen apps' windows; the lower
    // menu-bar level got covered when another app went fullscreen. Combined with
    // CanJoinAllSpaces + FullScreenAuxiliary the widget rides onto every Space.
    ns.setLevel(1000);
    ns.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary,
    );
    let x = f.origin.x + (f.size.width - w) / 2.0;
    let y = f.origin.y + f.size.height - h;
    ns.setFrame_display(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)), true);
    Ok(strip)
}

/// Global mouse pointer in WINDOW-LOCAL logical points (origin TOP-LEFT, same
/// coordinate space as the webview's CSS pixels). Values outside the frame are
/// returned as-is (negative / past the edge) so the caller can tell "off-window".
///
/// Two jobs, both of which DOM events can't do:
///  1. hover while another app is focused — an inactive window gets no mouseenter.
///  2. click-through hit testing — macOS `ignoresMouseEvents` is all-or-nothing
///     for the whole window, and ours is permanently card-sized (540×420) while
///     only a 210×60 pill is usually visible. The frontend rect-tests this point
///     against the VISIBLE sub-regions (pill/card, shelf) and keeps the window
///     click-through everywhere else, so the transparent slab stops eating the
///     clicks and scrolls of whatever sits under the notch.
#[tauri::command]
fn mouse_local(window: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let res = (|| -> Result<(f64, f64), String> {
                    unsafe {
                        use objc2_app_kit::{NSEvent, NSWindow};
                        let ptr = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
                        let ns: &NSWindow = &*ptr;
                        let f = ns.frame(); // global, bottom-left origin
                        let p = NSEvent::mouseLocation();
                        // global bottom-left → window-local top-left
                        Ok((p.x - f.origin.x, f.origin.y + f.size.height - p.y))
                    }
                })();
                let _ = tx.send(res);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("unsupported".into())
    }
}

/// SPIKE (notch drop-zone): is a file-drag in progress anywhere on screen right now?
/// The collapsed notch is click-through (ignoresMouseEvents), so it can't catch a
/// drop. We poll this: left button held + the system DRAG pasteboard carrying file
/// URLs ⇒ a drag is live ⇒ the frontend flips the window interactive to receive it.
#[tauri::command]
fn drag_active(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let res = (|| -> Result<bool, String> {
                    use std::sync::atomic::{AtomicI64, Ordering};
                    // changeCount of the drag pasteboard last time the button was UP.
                    // The drag pboard keeps its (stale) file URLs after a drag ends, so
                    // "button held + file URLs present" alone false-fires on a plain
                    // click. A real new drag BUMPS changeCount past that baseline.
                    static LAST_UP: AtomicI64 = AtomicI64::new(-1);
                    unsafe {
                        use objc2_app_kit::{
                            NSEvent, NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL,
                        };
                        use objc2_foundation::NSArray;
                        let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
                        let cc = pb.changeCount() as i64;
                        // no button → not dragging; remember this changeCount as baseline
                        if NSEvent::pressedMouseButtons() & 1 == 0 {
                            LAST_UP.store(cc, Ordering::Relaxed);
                            return Ok(false);
                        }
                        // button held: only a drag if the pboard changed since press
                        // AND it's carrying file URLs
                        let fresh = cc != LAST_UP.load(Ordering::Relaxed);
                        let wanted = NSArray::from_slice(&[NSPasteboardTypeFileURL]);
                        Ok(fresh && pb.availableTypeFromArray(&wanted).is_some())
                    }
                })();
                let _ = tx.send(res);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(false)
    }
}

/// SPIKE: Finder won't drop onto a screen-saver-level (1000) window, so when a
/// file-drag starts we drop the notch window to floating level (3, which DOES
/// accept drops) and restore 1000 when the drag ends. Toggled early — at drag
/// start, before the pointer reaches the notch — so there's no mid-drag retarget.
#[tauri::command]
fn drop_ready(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let res = (|| -> Result<(), String> {
                    unsafe {
                        use objc2_app_kit::NSWindow;
                        let ptr = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
                        let ns: &NSWindow = &*ptr;
                        ns.setLevel(if on { 3 } else { 1000 });
                        Ok(())
                    }
                })();
                let _ = tx.send(res);
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, on);
        Ok(())
    }
}

/// A file's preview: `thumb` is a chunky pixel-downscaled data URL for the shelf
/// chip; `icon` is the full-res QuickLook PNG path used as the drag-out cursor.
#[derive(serde::Serialize)]
struct Preview {
    thumb: String,
    icon: String,
}

/// Generate a preview for a stashed file. QuickLook renders a thumbnail for almost
/// anything (images, PDFs, code, docs — else a file-type icon); we then downscale
/// it to ~36px so it reads as pixel art in the widget.
#[tauri::command]
fn file_preview(path: String) -> Preview {
    let empty = Preview { thumb: String::new(), icon: String::new() };
    let src = PathBuf::from(&path);
    let name = match src.file_name().and_then(|s| s.to_str()) {
        Some(n) => n.to_string(),
        None => return empty,
    };
    let dir = std::env::temp_dir().join("pomo-prev");
    let _ = create_dir_all(&dir);
    let ok = std::process::Command::new("qlmanage")
        .args(["-t", "-s", "128", "-o"])
        .arg(&dir)
        .arg(&src)
        .output()
        .is_ok();
    if !ok {
        return empty;
    }
    let png = dir.join(format!("{}.png", name));
    if !png.exists() {
        return empty;
    }
    let icon = png.to_string_lossy().to_string();
    let thumb = (|| -> Option<String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let img = image::open(&png).ok()?;
        let small = img.resize(36, 36, image::imageops::FilterType::Triangle);
        let mut buf = std::io::Cursor::new(Vec::new());
        small.write_to(&mut buf, image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", STANDARD.encode(buf.get_ref())))
    })()
    .unwrap_or_default();
    Preview { thumb, icon }
}

/// Is the desktop wallpaper behind the notch dark? The doodle burst floats over the
/// wallpaper (outside the pill), so on a dark wallpaper the black strokes vanish —
/// we flip them to light ink. Reads the wallpaper file (no screen-recording perms),
/// downsamples via `sips` (handles .heic), and averages luminance of the top-center.
#[tauri::command]
fn bg_is_dark(window: tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let win = window.clone();
        if window
            .run_on_main_thread(move || {
                // prefer sampling what's ACTUALLY behind the window (desktop or any
                // app's window); fall back to reading the wallpaper file if screen-
                // recording permission isn't granted (capture returns None then).
                let r = behind_is_dark(&win).unwrap_or_else(wallpaper_is_dark);
                let _ = tx.send(r);
            })
            .is_err()
        {
            return false;
        }
        rx.recv().unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        false
    }
}

/// Capture the screen region directly BELOW our window and average its luminance.
/// Returns None if the capture fails (e.g. no Screen Recording permission).
#[cfg(target_os = "macos")]
fn behind_is_dark(win: &tauri::WebviewWindow) -> Option<bool> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow};
    use std::os::raw::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CgPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CgSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CgRect {
        origin: CgPoint,
        size: CgSize,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // silent check — does NOT prompt (CGWindowListCreateImage would nag on every
        // launch of an unsigned build). If not already granted, we skip the capture.
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGWindowListCreateImage(b: CgRect, list: u32, wid: u32, img: u32) -> *mut c_void;
        fn CGImageGetWidth(i: *mut c_void) -> usize;
        fn CGImageGetHeight(i: *mut c_void) -> usize;
        fn CGImageGetBytesPerRow(i: *mut c_void) -> usize;
        fn CGImageGetDataProvider(i: *mut c_void) -> *mut c_void;
        fn CGImageRelease(i: *mut c_void);
        fn CGDataProviderCopyData(p: *mut c_void) -> *mut c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFDataGetLength(d: *mut c_void) -> isize;
        fn CFDataGetBytePtr(d: *mut c_void) -> *const u8;
        fn CFRelease(cf: *mut c_void);
    }

    let mtm = MainThreadMarker::new()?;
    let ptr = win.ns_window().ok()? as *mut NSWindow;
    let ns: &NSWindow = unsafe { &*ptr };
    let frame = ns.frame(); // NS coords: origin bottom-left, global
    let wid = ns.windowNumber() as u32;
    // primary display height (menu-bar screen) for the NS(bottom-left)→CG(top-left) flip
    let screens = NSScreen::screens(mtm);
    let main_h = screens.firstObject()?.frame().size.height;
    let rect = CgRect {
        origin: CgPoint {
            x: frame.origin.x,
            y: main_h - (frame.origin.y + frame.size.height),
        },
        size: CgSize {
            width: frame.size.width,
            height: frame.size.height,
        },
    };
    const BELOW_WINDOW: u32 = 1 << 2; // kCGWindowListOptionOnScreenBelowWindow
    unsafe {
        // only capture if permission is ALREADY granted — never trigger the prompt
        if !CGPreflightScreenCaptureAccess() {
            return None;
        }
        let img = CGWindowListCreateImage(rect, BELOW_WINDOW, wid, 0);
        if img.is_null() {
            return None;
        }
        let (w, h, bpr) = (CGImageGetWidth(img), CGImageGetHeight(img), CGImageGetBytesPerRow(img));
        let provider = CGImageGetDataProvider(img);
        if provider.is_null() || w == 0 || h == 0 {
            CGImageRelease(img);
            return None;
        }
        let data = CGDataProviderCopyData(provider);
        if data.is_null() {
            CGImageRelease(img);
            return None;
        }
        let len = CFDataGetLength(data) as usize;
        let base = CFDataGetBytePtr(data);
        let mut sum = 0f64;
        let mut n = 0u64;
        if !base.is_null() {
            let (xs, ys) = ((w / 24).max(1), (h / 24).max(1));
            let mut y = 0usize;
            while y < h {
                let mut x = 0usize;
                while x < w {
                    let idx = y * bpr + x * 4; // 32-bit BGRA (little-endian)
                    if idx + 2 < len {
                        let b = *base.add(idx) as f64;
                        let g = *base.add(idx + 1) as f64;
                        let r = *base.add(idx + 2) as f64;
                        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                        n += 1;
                    }
                    x += xs;
                }
                y += ys;
            }
        }
        CFRelease(data);
        CGImageRelease(img);
        if n == 0 {
            return None;
        }
        Some((sum / n as f64) < 115.0) // < ~45% luminance → dark
    }
}

#[cfg(target_os = "macos")]
fn wallpaper_is_dark() -> bool {
    let path = (|| -> Option<String> {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSScreen, NSWorkspace};
        let mtm = MainThreadMarker::new()?;
        // the notched screen (fall back to main)
        let mut target = NSScreen::mainScreen(mtm)?;
        let mut notch = 0.0f64;
        for s in NSScreen::screens(mtm).iter() {
            let t = s.safeAreaInsets().top;
            if t > notch {
                notch = t;
                target = s.clone();
            }
        }
        let url = NSWorkspace::sharedWorkspace().desktopImageURLForScreen(&target)?;
        url.path().map(|p| p.to_string())
    })();
    let path = match path {
        Some(p) => p,
        None => return false,
    };
    // downsample the wallpaper to a tiny png (sips reads heic/jpg/png/tiff)
    let small = std::env::temp_dir().join("pomo-wp.png");
    let ok = std::process::Command::new("sips")
        .args(["-s", "format", "png", "-Z", "80", "--out"])
        .arg(&small)
        .arg(&path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        return false;
    }
    let img = match image::open(&small) {
        Ok(i) => i.to_rgb8(),
        Err(_) => return false,
    };
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return false;
    }
    // average luminance of the top-center strip (where the widget sits)
    let (x0, x1) = (w / 5, w * 4 / 5);
    let y1 = (h / 5).max(1);
    let mut sum = 0f64;
    let mut n = 0u64;
    for y in 0..y1 {
        for x in x0..x1 {
            let p = img.get_pixel(x, y).0;
            sum += 0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64;
            n += 1;
        }
    }
    n > 0 && (sum / n as f64) < 115.0 // < ~45% luminance → treat as dark
}

/// SPIKE: path to the little icon shown under the cursor while dragging a stashed
/// file back out. Written once from the bundled app icon.
#[tauri::command]
fn drag_icon() -> String {
    let p = pomo_dir().join("dragicon.png");
    if !p.exists() {
        let _ = create_dir_all(pomo_dir());
        let _ = std::fs::write(&p, include_bytes!("../icons/128x128.png"));
    }
    p.to_string_lossy().to_string()
}

/// Dock top-center on the notched screen (float=true restores normal mode).
/// Returns the notch height so the frontend can offset the card below it.
#[tauri::command]
fn notch_dock(window: tauri::WebviewWindow, w: f64, h: f64, float: bool) -> Result<f64, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let win = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(unsafe { notch_dock_impl(&win, w, h, float) });
            })
            .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, w, h, float);
        Ok(0.0)
    }
}

// ── memo playback: native afplay, one at a time ──────────
static PLAYER: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

fn kill_player(guard: &mut Option<std::process::Child>) {
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// Play a memo file through afplay (kills any current playback first).
/// Paths are pinned to ~/.pomo/memos — the note text is user-editable.
#[tauri::command]
fn memo_play(path: String) -> Result<(), String> {
    let canon = PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    let memos = pomo_dir().join("memos").canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&memos) {
        return Err("not a memo file".into());
    }
    let mut guard = PLAYER.lock().unwrap();
    kill_player(&mut guard);
    let child = std::process::Command::new("afplay")
        .arg(canon)
        .spawn()
        .map_err(|e| e.to_string())?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
fn memo_stop() {
    kill_player(&mut PLAYER.lock().unwrap());
}

/// True while afplay is still running — the frontend polls to reset the ▶ chip.
#[tauri::command]
fn memo_playing() -> bool {
    let mut guard = PLAYER.lock().unwrap();
    match guard.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true, // still going
        Some(_) => {
            *guard = None; // finished or errored
            false
        }
        None => false,
    }
}

// ── shared notes/todo store (~/.pomo/notes/<project>.md) — the bridge to Raycast ──
fn notes_dir() -> PathBuf {
    pomo_dir().join("notes")
}

fn sanitize(name: &str) -> String {
    name.chars().filter(|c| !"/\\:".contains(*c)).collect::<String>().trim().to_string()
}

fn note_file(name: &str) -> PathBuf {
    notes_dir().join(format!("{}.md", sanitize(name)))
}

/// Project note names (sorted), one per .md file.
#[tauri::command]
fn list_notes() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(notes_dir())
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) == Some("md") {
                        p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[tauri::command]
fn read_note(name: String) -> String {
    std::fs::read_to_string(note_file(&name)).unwrap_or_default()
}

#[tauri::command]
fn write_note(name: String, content: String) -> Result<(), String> {
    create_dir_all(notes_dir()).map_err(|e| e.to_string())?;
    std::fs::write(note_file(&name), content).map_err(|e| e.to_string())
}

/// Which project the widget currently shows.
#[tauri::command]
fn active_note() -> String {
    if let Ok(s) = std::fs::read_to_string(notes_dir().join(".active")) {
        let name = s.trim().to_string();
        if !name.is_empty() && note_file(&name).exists() {
            return name;
        }
    }
    list_notes().into_iter().next().unwrap_or_default()
}

#[tauri::command]
fn set_active_note(name: String) -> Result<(), String> {
    create_dir_all(notes_dir()).map_err(|e| e.to_string())?;
    std::fs::write(notes_dir().join(".active"), sanitize(&name)).map_err(|e| e.to_string())
}

/// Create a project note if it doesn't exist yet.
#[tauri::command]
fn create_note(name: String) -> Result<(), String> {
    create_dir_all(notes_dir()).map_err(|e| e.to_string())?;
    let f = note_file(&name);
    if !f.exists() {
        std::fs::write(&f, format!("# {}\n", sanitize(&name))).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Delete a project note. If it was the active one, fall back to the first remaining.
#[tauri::command]
fn delete_note(name: String) -> Result<(), String> {
    let f = note_file(&name);
    if f.exists() {
        std::fs::remove_file(&f).map_err(|e| e.to_string())?;
    }
    let active_raw = std::fs::read_to_string(notes_dir().join(".active"))
        .unwrap_or_default()
        .trim()
        .to_string();
    if active_raw == sanitize(&name) {
        let next = list_notes().into_iter().next().unwrap_or_default();
        let _ = std::fs::write(notes_dir().join(".active"), next);
    }
    Ok(())
}

/// Raycast drops a `.open` file with a project name to pop that project in the widget.
/// The frontend polls this, acts on it, and clears it (one-shot).
#[tauri::command]
fn consume_open_request() -> String {
    let p = notes_dir().join(".open");
    if let Ok(s) = std::fs::read_to_string(&p) {
        let _ = std::fs::remove_file(&p);
        return s.trim().to_string();
    }
    String::new()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    // ⌃⌥ combos so the widget is controllable while any app is focused (a passive
    // notch widget can't hold key focus for bare keys). name → action for the UI.
    let keys: [(Modifiers, Code, &str); 6] = [
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyS, "sync"),
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyP, "pause"),
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyM, "memo"),
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyN, "notch"),
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::Enter, "skip"),
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyK, "peek"),
    ];
    let shortcuts: Vec<Shortcut> = keys.iter().map(|(m, c, _)| Shortcut::new(Some(*m), *c)).collect();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, sc, ev| {
                    if ev.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some((_, _, name)) = keys.iter().find(|(m, c, _)| {
                        sc.mods == *m && sc.key == *c
                    }) {
                        let _ = app.emit("hotkey", *name);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // Run as a menubar/widget-style accessory: no Dock icon, no menu bar,
            // hidden from cmd-tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // register the global hotkeys (ignore failures — e.g. already taken)
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            for s in &shortcuts {
                let _ = app.global_shortcut().register(s.clone());
            }

            // cold-launch hardening: make sure the window is actually shown so the
            // webview gets a render pass (first launch sometimes comes up blank)
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_event,
            notify,
            save_memo,
            memo_play,
            memo_stop,
            memo_playing,
            notch_dock,
            mouse_local,
            drag_active,
            drop_ready,
            bg_is_dark,
            file_preview,
            drag_icon,
            ding,
            list_notes,
            read_note,
            write_note,
            active_note,
            set_active_note,
            create_note,
            delete_note,
            consume_open_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
