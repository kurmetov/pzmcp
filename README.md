# pzmcp

An MCP server for Claude Code that launches Project Zomboid (B42) straight into a given save, runs Lua inside the game, reads `console.txt` and takes screenshots of the game window. It lets Claude test mods in game on its own.

Windows only. Needs Node ≥ 18, no dependencies. Works with the Steam version of the game.

## Setup

Add it to the project's `.mcp.json` (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "pz": { "command": "node", "args": ["C:/path/to/pzmcp/server.mjs"] }
  }
}
```

Environment variables for non-default locations:
- `PZ_GAME_DIR`: game folder. Default: `C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid`.
- `PZ_USER_DIR`: the game's user folder. Default: `%USERPROFILE%\Zomboid`.

## Tools

| Tool | What it does |
|---|---|
| `pz_saves` | Lists saves: mode, name, date, mods from `mods.txt`, and which save is the latest |
| `pz_launch` | Starts the game (with `-debug` by default), loads a save, gets past "click to start" and waits until the player is in the world |
| `pz_wait` | Waits until the game is in the world, for use after `pz_launch` with `wait=false` |
| `pz_status` | Game state (not running / main menu / in game / loading), player position, error count in the log |
| `pz_lua` | Runs Lua in the game and returns `print` output and return values; a single expression is returned automatically |
| `pz_console` | Tail of `console.txt`, filtered by regex or errors only |
| `pz_screenshot` | JPEG capture of the game window |
| `pz_click` | Clicks in the window (coordinates are fractions of the client area) |
| `pz_quit` | `getCore():quitToDesktop()`; `force=true` kills the process |

## How it works

The server and the game are connected by `ClaudeBridge`, a dev mod in this repo. They talk through files in `Zomboid/Lua`.

- **Bridge install.** On the first `pz_launch` the server links `ClaudeBridge` into `Zomboid/mods` as a junction and adds it to `mods/default.txt` (main-menu mods) and to the `mods.txt` of the save being loaded. Before a file is changed for the first time, a `.bak_claude` copy is saved next to it.
- **Loading a save.** The game has no command-line option for this. The server writes the mode and save name to `claude_bridge_autoload.txt`, and the bridge calls `MainScreen.continueLatestSave` from the main menu, which is what the Load button does.
- **"Click to start".** `GameLoadingState` waits for `Mouse.isButtonDown(0)`. When `game loading took` shows up in `console.txt`, the server clicks the center of the window: first via `PostMessage`, without stealing focus, then with a real mouse click if that didn't work.
- **Lua in game.** The Kahlua environment has no `loadstring`. Instead, the code is written to `claude_bridge_cmd.lua`, and every 10 ticks (`OnFETick` / `OnTickEvenPaused`) the bridge runs it with `reloadLuaFile(absolute path)`. `Zomboid/` and mod folders are among the allowed prefixes of `ZomboidFileSystem`. The result comes back through `claude_bridge_out.txt`, and once a second the bridge writes its state to `claude_bridge_status.txt`.
- **Screenshots.** [win.ps1](win.ps1) uses `PrintWindow(PW_RENDERFULLCONTENT)`, which captures the window even when it's covered by other windows, but not when it's minimized.

## Security

The bridge runs any Lua code it finds in a file in `Zomboid/Lua`. It is a developer tool: don't enable `ClaudeBridge` in multiplayer and don't publish it to the Workshop.
