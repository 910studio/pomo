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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // Run as a menubar/widget-style accessory: no Dock icon, no menu bar,
            // hidden from cmd-tab.
            #[cfg(target_os = "macos")]
            _app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            log_event,
            notify,
            list_notes,
            read_note,
            write_note,
            active_note,
            set_active_note,
            create_note,
            consume_open_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
