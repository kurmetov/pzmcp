#!/usr/bin/env node
// MCP server (stdio, no dependencies) that lets Claude launch Project Zomboid into a given save,
// run Lua inside the running game, read console.txt and take screenshots.
// The in-game half is the ClaudeBridge mod next to this file; they talk through files in Zomboid/Lua.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = process.env.PZ_GAME_DIR || "C:\\Program Files (x86)\\Steam\\steamapps\\common\\ProjectZomboid";
const USER = process.env.PZ_USER_DIR || path.join(process.env.USERPROFILE || "", "Zomboid");
const LUA = path.join(USER, "Lua");
const CONSOLE = path.join(USER, "console.txt");
const SAVES = path.join(USER, "Saves");
const MODS = path.join(USER, "mods");
const BRIDGE_ID = "ClaudeBridge";
const BRIDGE_SRC = path.join(HERE, BRIDGE_ID);
const F = {
  req: path.join(LUA, "claude_bridge_req.txt"),
  cmd: path.join(LUA, "claude_bridge_cmd.lua"),
  out: path.join(LUA, "claude_bridge_out.txt"),
  status: path.join(LUA, "claude_bridge_status.txt"),
  autoload: path.join(LUA, "claude_bridge_autoload.txt"),
};
const ERROR_RE = /ERROR|Exception|STACK TRACE|attempted index|Callframe at|function: .*\.lua/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
function writeAtomic(p, text) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}

function run(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: (stdout || "") + (stderr || "") });
    });
  });
}
const win = (...args) => run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "win.ps1"), ...args]);

async function gamePid() {
  const r = await run("tasklist.exe", ["/FI", "IMAGENAME eq ProjectZomboid64.exe", "/FO", "CSV", "/NH"]);
  const m = r.out.match(/"ProjectZomboid64\.exe","(\d+)"/);
  return m ? Number(m[1]) : null;
}

function bridgeStatus() {
  const text = read(F.status);
  if (text == null) return { alive: false };
  const st = { ageSec: (Date.now() - mtime(F.status)) / 1000 };
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) st[line.slice(0, i)] = line.slice(i + 1);
  }
  st.alive = st.ageSec < 4;
  return st;
}

function consoleLines() {
  return (read(CONSOLE) || "").split(/\r?\n/);
}

// ---------- mod list files (default.txt, <save>/mods.txt) ----------
export function ensureModsInList(file, ids) {
  let text = read(file);
  if (text == null) text = "VERSION = 1,\n\nmods\n{\n}\n\nmaps\n{\n}\n";
  const m = text.match(/mods\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error(`can't parse mods block in ${file}`);
  const present = new Set([...m[1].matchAll(/mod\s*=\s*([^,\r\n]+),/g)].map((x) => x[1].trim().replace(/^\\/, "")));
  const missing = ids.filter((id) => !present.has(id));
  if (!missing.length) return [];
  if (!exists(file + ".bak_claude")) fs.writeFileSync(file + ".bak_claude", text, "utf8");
  const insert = missing.map((id) => `    mod = ${id},\n`).join("");
  const at = m.index + m[0].lastIndexOf("}");
  fs.writeFileSync(file, text.slice(0, at) + insert + text.slice(at), "utf8");
  return missing;
}

function ensureBridgeInstalled() {
  const dst = path.join(MODS, BRIDGE_ID);
  if (exists(dst)) return false;
  fs.symlinkSync(BRIDGE_SRC, dst, "junction");
  return true;
}

// ---------- saves ----------
export function listSaves() {
  const res = [];
  if (!exists(SAVES)) return res;
  const latest = (read(path.join(USER, "latestSave.ini")) || "").split(/\r?\n/);
  for (const mode of fs.readdirSync(SAVES)) {
    const md = path.join(SAVES, mode);
    if (!fs.statSync(md).isDirectory()) continue;
    for (const name of fs.readdirSync(md)) {
      const dir = path.join(md, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      const mods = [...(read(path.join(dir, "mods.txt")) || "").matchAll(/mod\s*=\s*([^,\r\n]+),/g)].map((x) => x[1].trim());
      const d = new Date(fs.statSync(dir).mtimeMs);
      const p2 = (n) => String(n).padStart(2, "0");
      res.push({ mode, name, modified: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
        latest: latest[0] === name && latest[1] === mode, mods });
    }
  }
  return res.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

function resolveSave(save, mode) {
  const all = listSaves();
  if (!save || save === "latest") {
    const l = all.find((s) => s.latest) || all[0];
    if (!l) throw new Error("no saves found");
    return l;
  }
  const hits = all.filter((s) => s.name === save && (!mode || s.mode === mode));
  if (!hits.length) throw new Error(`save '${save}' not found (mode ${mode || "any"})`);
  if (hits.length > 1) throw new Error(`save '${save}' exists in several modes: ${hits.map((h) => h.mode).join(", ")}; pass mode`);
  return hits[0];
}

// ---------- in-game Lua ----------
let reqCounter = 0;
function wrapCode(code) {
  const c = code.trim();
  const oneLine = !c.includes("\n");
  const statement = /^(local|if|for|while|function|do|repeat|return)\b/.test(c) || /[^=~<>]=[^=]/.test(c.replace(/(["']).*?\1/g, ""));
  return oneLine && !statement ? "return " + c : c;
}

async function runLua(code, timeoutSec = 15) {
  const id = `${Date.now()}_${++reqCounter}`;
  const body = `return ClaudeBridge.run("${id}", function(...)\n${wrapCode(code)}\nend)\n`;
  fs.mkdirSync(LUA, { recursive: true });
  fs.writeFileSync(F.cmd, body, "utf8");
  writeAtomic(F.req, `${id}\n${F.cmd.replace(/\\/g, "/")}\n`);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(100);
    const out = read(F.out);
    if (out && out.startsWith(`id=${id}\n`) && out.includes("\n--- end")) {
      try { fs.unlinkSync(F.req); } catch {}
      const status = (out.match(/^status=(\w+)/m) || [])[1];
      const output = (out.match(/--- output\n([\s\S]*?)--- result\n/) || [])[1] || "";
      const result = (out.match(/--- result\n([\s\S]*?)--- end/) || [])[1] || "";
      return { ok: status === "ok", output: output.trimEnd(), result: result.trimEnd() };
    }
  }
  try { fs.unlinkSync(F.req); } catch {}
  const st = bridgeStatus();
  throw new Error(`no answer from ClaudeBridge in ${timeoutSec}s (bridge ${st.alive ? "alive, state=" + st.state : "not responding: game closed, loading, or ClaudeBridge not in the active mod list"})`);
}

// ---------- launch / wait ----------
async function waitIngame({ timeoutSec = 300, click = true } = {}) {
  const t0 = Date.now();
  const log = [];
  let clicks = 0, lastClick = 0, loadedSeen = false;
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const st = bridgeStatus();
    if (st.alive && st.state === "ingame") {
      log.push(`in game after ${Math.round((Date.now() - t0) / 1000)}s, save=${st.save}, player=${st.player}`);
      return { ok: true, log };
    }
    if (!(await gamePid())) { log.push("game process is gone"); return { ok: false, log }; }
    const lines = consoleLines();
    const loaded = lines.some((l) => l.includes("game loading took"));
    const leftLoading = lines.some((l) => l.includes("exit zombie.gameStates.GameLoadingState"));
    if (loaded && !loadedSeen) { loadedSeen = true; log.push(lines.find((l) => l.includes("game loading took")).trim()); }
    if (loaded && !leftLoading && click && Date.now() - lastClick > 2000 && clicks < 12) {
      // GameLoadingState waits for mouse button 0 (bytecode: Mouse.isButtonDown(0) -> forceDone).
      const method = clicks < 4 ? "post" : "real";
      const r = await win("-Action", "click", "-X", "0.5", "-Y", "0.5", "-Method", method);
      log.push(`click-to-start: ${r.out.trim()}`);
      clicks++; lastClick = Date.now();
    }
    await sleep(1000);
  }
  log.push(`timeout after ${timeoutSec}s; bridge=${JSON.stringify(bridgeStatus())}`);
  return { ok: false, log };
}

async function launch({ save, mode, debug = true, wait = true, timeoutSec = 300, extraArgs = [] }) {
  if (await gamePid()) throw new Error("Project Zomboid is already running; use pz_quit first");
  const log = [];
  if (ensureBridgeInstalled()) log.push(`linked ${path.join(MODS, BRIDGE_ID)} -> ${BRIDGE_SRC}`);
  const addedDefault = ensureModsInList(path.join(MODS, "default.txt"), [BRIDGE_ID]);
  if (addedDefault.length) log.push(`added ${addedDefault} to mods/default.txt (main-menu mod list; backup .bak_claude)`);
  let target = null;
  if (save !== "none") {
    target = resolveSave(save, mode);
    const added = ensureModsInList(path.join(SAVES, target.mode, target.name, "mods.txt"), [BRIDGE_ID]);
    if (added.length) log.push(`added ${added} to ${target.mode}/${target.name}/mods.txt`);
    fs.mkdirSync(LUA, { recursive: true });
    fs.writeFileSync(F.autoload, `${target.mode}\n${target.name}\n`, "utf8");
    log.push(`autoload ${target.mode}/${target.name}`);
  } else {
    try { fs.writeFileSync(F.autoload, "", "utf8"); } catch {}
  }
  try { fs.unlinkSync(F.req); } catch {}
  try { fs.unlinkSync(F.status); } catch {}
  const args = [...(debug ? ["-debug"] : []), ...extraArgs];
  const child = spawn(path.join(GAME, "ProjectZomboid64.exe"), args, { cwd: GAME, detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  log.push(`started ProjectZomboid64.exe ${args.join(" ")} (pid ${child.pid})`);
  if (!wait) return log.join("\n");
  if (!target) {
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < timeoutSec) {
      const st = bridgeStatus();
      if (st.alive && st.state === "menu") { log.push(`main menu after ${Math.round((Date.now() - t0) / 1000)}s`); break; }
      await sleep(1000);
    }
  } else {
    const r = await waitIngame({ timeoutSec });
    log.push(...r.log);
  }
  const errs = consoleLines().filter((l) => ERROR_RE.test(l));
  if (errs.length) log.push(`console.txt has ${errs.length} error-looking lines; last ones:\n` + errs.slice(-15).join("\n"));
  return log.join("\n");
}

async function quit({ force = false, timeoutSec = 90 }) {
  const pid = await gamePid();
  if (!pid) return "game is not running";
  const log = [];
  if (!force) {
    try {
      await runLua("getCore():quitToDesktop()", 10);
      log.push("called getCore():quitToDesktop()");
    } catch (e) {
      return `graceful quit failed (${e.message}). Call pz_quit with force=true to kill pid ${pid} (unsaved progress is lost).`;
    }
  } else {
    await run("taskkill.exe", ["/PID", String(pid), "/F"]);
    log.push(`killed pid ${pid}`);
  }
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (!(await gamePid())) { log.push(`exited after ${Math.round((Date.now() - t0) / 1000)}s`); return log.join("\n"); }
    await sleep(1000);
  }
  log.push(`still running after ${timeoutSec}s`);
  return log.join("\n");
}

async function screenshot({ maxWidth = 1280 }) {
  if (!(await gamePid())) throw new Error("game is not running");
  const dir = path.join(process.env.TEMP || USER, "pzmcp");
  fs.mkdirSync(dir, { recursive: true });
  const png = path.join(dir, "shot.png"), jpg = path.join(dir, "shot.jpg");
  const r = await win("-Action", "capture", "-Out", png);
  if (!r.out.includes("saved=")) throw new Error(r.out.trim());
  const s = await win("-Action", "shrink", "-In", png, "-Out", jpg, "-MaxWidth", String(maxWidth));
  if (!s.out.includes("ok")) throw new Error(s.out.trim());
  return fs.readFileSync(jpg).toString("base64");
}

// ---------- MCP plumbing ----------
const TOOLS = [
  {
    name: "pz_saves",
    description: "List Project Zomboid saves (mode, name, last modified, mods from mods.txt). 'latest' marks the save the Continue button would load.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => JSON.stringify(listSaves(), null, 1),
  },
  {
    name: "pz_launch",
    description: "Start Project Zomboid and load a save automatically (via the ClaudeBridge dev mod: it is linked into Zomboid/mods and added to mods/default.txt and to the save's mods.txt if missing). Clicks through the 'click to start' screen and waits until the player is in the world. Fails if the game is already running. Loading with many main-menu mods can take a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        save: { type: "string", description: "Save folder name (e.g. 2026-09-27_13-51-15), 'latest' (default) or 'none' for main menu only" },
        mode: { type: "string", description: "Save mode folder (Sandbox, Apocalypse, ...), only needed if the name is ambiguous" },
        debug: { type: "boolean", description: "Pass -debug (default true)" },
        wait: { type: "boolean", description: "Wait until in game (default true); otherwise return right after start and use pz_wait" },
        timeout_sec: { type: "number", description: "Max wait, default 300" },
      },
    },
    handler: async (a) => launch({ save: a.save, mode: a.mode, debug: a.debug ?? true, wait: a.wait ?? true, timeoutSec: a.timeout_sec ?? 300 }),
  },
  {
    name: "pz_wait",
    description: "Wait until the game is in the world (clicking 'click to start' if needed). Use after pz_launch with wait=false.",
    inputSchema: { type: "object", properties: { timeout_sec: { type: "number" } } },
    handler: async (a) => { const r = await waitIngame({ timeoutSec: a.timeout_sec ?? 300 }); return (r.ok ? "OK\n" : "NOT IN GAME\n") + r.log.join("\n"); },
  },
  {
    name: "pz_status",
    description: "Is the game running, what state (menu / ingame / loading), current save, player position, and error count in console.txt.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const pid = await gamePid();
      const st = bridgeStatus();
      const lines = consoleLines();
      const state = !pid ? "not running" : st.alive ? st.state
        : st.ageSec == null ? "running, no ClaudeBridge status (bridge not loaded - game not started through pz_launch?)"
        : `loading/unresponsive (bridge silent ${Math.round(st.ageSec)}s, last state ${st.state})`;
      return JSON.stringify({ pid, state, save: st.save, player: st.player, consoleLines: lines.length,
        errorLines: lines.filter((l) => ERROR_RE.test(l)).length }, null, 1);
    },
  },
  {
    name: "pz_lua",
    description: "Run Lua inside the running game (main menu or in game) through ClaudeBridge and return print() output and return values. A single expression is auto-returned. Examples: `getPlayer():getX()`, `getClimateManager():getSnowIntensity()`, `reloadLuaFile(\"C:/Users/<you>/Zomboid/mods/<ModId>/42/media/lua/client/<File>.lua\")` (absolute path) to hot-reload a mod file. Compile errors land in console.txt.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, timeout_sec: { type: "number", description: "default 15" } },
      required: ["code"],
    },
    handler: async (a) => {
      const r = await runLua(a.code, a.timeout_sec ?? 15);
      return `${r.ok ? "OK" : "ERROR"}\n${r.output ? "--- print\n" + r.output + "\n" : ""}--- ${r.ok ? "returned" : "error"}\n${r.result}`;
    },
  },
  {
    name: "pz_console",
    description: "Read Zomboid/console.txt of the current/last run: last N lines, optionally filtered by a regex or errors only.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", description: "How many lines to return (default 80)" },
        grep: { type: "string", description: "JS regex filter (case-insensitive)" },
        errors: { type: "boolean", description: "Only error-looking lines" },
      },
    },
    handler: async (a) => {
      let lines = consoleLines().map((l, i) => `${i + 1}: ${l}`);
      if (a.errors) lines = lines.filter((l) => ERROR_RE.test(l));
      if (a.grep) { const re = new RegExp(a.grep, "i"); lines = lines.filter((l) => re.test(l)); }
      return lines.slice(-(a.lines ?? 80)).join("\n") || "(no matching lines)";
    },
  },
  {
    name: "pz_screenshot",
    description: "Capture the game window (works while it is covered by other windows, not while minimized) and return it as an image.",
    inputSchema: { type: "object", properties: { max_width: { type: "number", description: "Downscale to this width, default 1280" } } },
    handler: async (a) => ({ image: await screenshot({ maxWidth: a.max_width ?? 1280 }) }),
  },
  {
    name: "pz_click",
    description: "Left-click in the game window. x/y are fractions of the client area (0..1). method 'post' sends window messages without stealing focus; 'real' briefly focuses the window and moves the real cursor.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, method: { type: "string", enum: ["post", "real"] } },
      required: ["x", "y"],
    },
    handler: async (a) => (await win("-Action", "click", "-X", String(a.x), "-Y", String(a.y), "-Method", a.method || "post")).out.trim(),
  },
  {
    name: "pz_quit",
    description: "Quit the game: getCore():quitToDesktop() through the bridge (same as the menu's Quit to desktop, the game saves). force=true kills the process instead (progress since the last save is lost) - only when the user agreed or the game hangs.",
    inputSchema: { type: "object", properties: { force: { type: "boolean" }, timeout_sec: { type: "number" } } },
    handler: async (a) => quit({ force: !!a.force, timeoutSec: a.timeout_sec ?? 90 }),
  },
];

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "pzmcp", version: "0.1.0" },
    } });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
    try {
      const r = await tool.handler(params.arguments || {});
      const content = r && r.image ? [{ type: "image", data: r.image, mimeType: "image/jpeg" }] : [{ type: "text", text: String(r) }];
      return send({ jsonrpc: "2.0", id, result: { content } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => process.stderr.write(String(e?.stack || e) + "\n"));
  }
});
