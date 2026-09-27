-- Dev bridge for tools/pzmcp (MCP server). All traffic goes through files in Zomboid/Lua:
--   claude_bridge_autoload.txt  "<gameMode>\n<saveName>": main menu loads that save once, then clears the file
--   claude_bridge_req.txt       "<id>\n<absolute path of cmd .lua>": run it via reloadLuaFile (cache dir is an allowed prefix)
--   claude_bridge_out.txt       result of the last request, written by ClaudeBridge.run
--   claude_bridge_status.txt    heartbeat once a second: state=menu|ingame, save, player position
ClaudeBridge = ClaudeBridge or {}
local B = ClaudeBridge

local REQ, OUT, STATUS, AUTOLOAD = "claude_bridge_req.txt", "claude_bridge_out.txt", "claude_bridge_status.txt", "claude_bridge_autoload.txt"
local POLL_TICKS = 10
local AUTOLOAD_DELAY_TICKS = 30

local function readLines(name)
    local r = getFileReader(name, false)
    if not r then return nil end
    local t = {}
    local l = r:readLine()
    while l do
        t[#t + 1] = l
        l = r:readLine()
    end
    r:close()
    return t
end

local function writeFile(name, text)
    local w = getFileWriter(name, true, false)
    if not w then return end
    w:write(text)
    w:close()
end

local function quote(s)
    return '"' .. s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n") .. '"'
end

local function ser(v, depth, seen)
    local tv = type(v)
    if tv == "string" then return quote(v) end
    if tv ~= "table" then return tostring(v) end
    if seen[v] or depth > 3 then return "{...}" end
    seen[v] = true
    local parts, n = {}, 0
    for k, x in pairs(v) do
        n = n + 1
        if n > 60 then
            parts[#parts + 1] = "..."
            break
        end
        parts[#parts + 1] = "[" .. ser(k, depth + 1, seen) .. "]=" .. ser(x, depth + 1, seen)
    end
    return "{" .. table.concat(parts, ", ") .. "}"
end

local function pack(...)
    return { n = select("#", ...), ... }
end

-- Called by the generated cmd file: return ClaudeBridge.run("<id>", function() <code> end)
function B.run(id, fn)
    B.ranId = id
    local out = {}
    local oldPrint = print
    print = function(...)
        local s = {}
        for i = 1, select("#", ...) do s[i] = tostring((select(i, ...))) end
        out[#out + 1] = table.concat(s, "\t")
        oldPrint(...)
    end
    local res = pack(pcall(fn))
    print = oldPrint
    local text = { "id=" .. id }
    if res[1] then
        text[#text + 1] = "status=ok"
    else
        text[#text + 1] = "status=error"
    end
    text[#text + 1] = "--- output"
    for i = 1, #out do text[#text + 1] = out[i] end
    text[#text + 1] = "--- result"
    if res[1] then
        for i = 2, res.n do text[#text + 1] = ser(res[i], 0, {}) end
    else
        text[#text + 1] = tostring(res[2])
    end
    text[#text + 1] = "--- end"
    writeFile(OUT, table.concat(text, "\n") .. "\n")
end

local function poll()
    local lines = readLines(REQ)
    if not lines or not lines[1] or lines[1] == "" then return end
    local id = lines[1]
    if id == B.lastReq then return end
    B.lastReq = id
    B.ranId = nil
    local ok, err = pcall(reloadLuaFile, lines[2])
    if B.ranId ~= id then
        writeFile(OUT, "id=" .. id .. "\nstatus=error\n--- output\n--- result\nscript did not run (compile error? see console.txt) "
            .. tostring(err) .. "\n--- end\n")
    end
end

local function writeStatus(state)
    local now = getTimestampMs()
    if B.lastStatus and now - B.lastStatus < 1000 then return end
    B.lastStatus = now
    local s = "state=" .. state .. "\n"
    local world = getWorld()
    if world then s = s .. "save=" .. tostring(world:getGameMode()) .. "/" .. tostring(world:getWorld()) .. "\n" end
    local p = getPlayer()
    if p then
        s = s .. string.format("player=%.2f,%.2f,%.1f\n", p:getX(), p:getY(), p:getZ())
    end
    writeFile(STATUS, s)
end

local function tryAutoload()
    local a = readLines(AUTOLOAD)
    if not a or not a[1] or a[1] == "" or not a[2] then return end
    writeFile(AUTOLOAD, "")
    if not (MainScreen and MainScreen.instance and MainScreen.continueLatestSave) then
        print("ClaudeBridge: autoload skipped, no MainScreen")
        return
    end
    print("ClaudeBridge: autoload " .. a[1] .. "/" .. a[2])
    MainScreen.continueLatestSave(a[1], a[2])
end

local ticks = 0
local menuTicks = 0

local function onFETick()
    ticks = ticks + 1
    if MainScreen and MainScreen.instance then
        menuTicks = menuTicks + 1
        if menuTicks == AUTOLOAD_DELAY_TICKS then tryAutoload() end
    end
    if ticks % POLL_TICKS == 0 then poll() end
    writeStatus("menu")
end

local function onTick()
    ticks = ticks + 1
    if ticks % POLL_TICKS == 0 then poll() end
    writeStatus("ingame")
end

-- After a Lua reset don't replay whatever request is still on disk.
local stale = readLines(REQ)
B.lastReq = stale and stale[1] or nil

Events.OnFETick.Add(onFETick)
Events.OnTickEvenPaused.Add(onTick)
