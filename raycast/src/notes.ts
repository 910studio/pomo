// Shared access to pomo's per-project todo store — the same files the widget reads.
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "fs";

const DIR = join(homedir(), ".pomo", "notes");
const ACTIVE = join(DIR, ".active");

function ensure(): void {
  mkdirSync(DIR, { recursive: true });
}
function sanitize(name: string): string {
  return name.replace(/[/\\:]/g, "").trim();
}
function fileFor(name: string): string {
  return join(DIR, `${sanitize(name)}.md`);
}

export function listProjects(): string[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function readNote(name: string): string {
  try {
    return readFileSync(fileFor(name), "utf8");
  } catch {
    return "";
  }
}

export function writeNote(name: string, content: string): void {
  ensure();
  writeFileSync(fileFor(name), content, "utf8");
}

export function createProject(name: string): void {
  ensure();
  const f = fileFor(name);
  if (!existsSync(f)) writeFileSync(f, `# ${sanitize(name)}\n`, "utf8");
}

export function deleteProject(name: string): void {
  try {
    rmSync(fileFor(name));
  } catch {
    /* already gone */
  }
}

export function renameProject(oldName: string, newName: string): void {
  const content = readNote(oldName);
  writeNote(newName, content);
  if (sanitize(oldName) !== sanitize(newName)) deleteProject(oldName);
  if (getActive() === oldName) setActive(newName);
}

export function appendTodo(name: string, text: string): void {
  const cur = readNote(name);
  const line = `- [ ] ${text}`;
  writeNote(name, cur.trim().length > 0 ? `${cur.replace(/\n*$/, "")}\n${line}\n` : `${line}\n`);
}

export function getActive(): string {
  try {
    const a = readFileSync(ACTIVE, "utf8").trim();
    if (a && existsSync(fileFor(a))) return a;
  } catch {
    /* fall through */
  }
  return listProjects()[0] ?? "";
}

export function setActive(name: string): void {
  ensure();
  writeFileSync(ACTIVE, sanitize(name), "utf8");
}

// Drop a one-shot trigger the widget polls — pops this project open in the pomo UI.
export function requestOpenInPomo(name: string): void {
  ensure();
  setActive(name);
  writeFileSync(join(DIR, ".open"), sanitize(name), "utf8");
}

// Tell the widget to open straight into "name a new project" mode.
export function requestNewInPomo(): void {
  ensure();
  writeFileSync(join(DIR, ".open"), "__new__", "utf8");
}
