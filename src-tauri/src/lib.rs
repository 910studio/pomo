// pomo — Tauri backend: notch docking, file shelf, Anton probe.
use std::fs::create_dir_all;
use std::path::PathBuf;

fn pomo_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".pomo")
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

/// Anton's read-only status feed (ops/anton-probe.sh in the Anton repo) over the
/// `protech` ssh alias — its ControlMaster makes polls ~250ms after the first.
/// Returns the raw pipe-delimited lines; the frontend parses. Blocking pool, not
/// the main thread: a cold probe takes ~6s (docker stats).
#[tauri::command]
async fn anton_probe() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("/usr/bin/ssh")
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "protech", "/usr/local/sbin/anton-probe"])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    // ⌃⌥ combos so the widget is controllable while any app is focused (a passive
    // notch widget can't hold key focus for bare keys). name → action for the UI.
    let keys: [(Modifiers, Code, &str); 2] = [
        (Modifiers::CONTROL.union(Modifiers::ALT), Code::KeyN, "notch"),
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
            notch_dock,
            mouse_local,
            drag_active,
            drop_ready,
            bg_is_dark,
            file_preview,
            drag_icon,
            anton_probe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
