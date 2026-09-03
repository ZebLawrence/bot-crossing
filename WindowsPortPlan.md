# Windows port — findings and plan

Notes for whoever picks this up on a Windows machine. Everything below was established by
reading and running this fork **on macOS**, so it is split into what is *verified* and what is
*assumed* — the assumed half is exactly where a Windows box is needed, and it is called out
rather than smoothed over.

Context for the port: the target machine runs **Copilot CLI and no Claude Code**.

---

## The short version

The **scanning half is already portable**. Every blocker is in the layer that talks to the OS
— one npm gate, one process spawn, one path check, one launcher, one display helper. There is
no architectural problem here; the seam the project already has (`server/harnesses/`) holds up.

Estimate: a few hours, most of it verification rather than typing.

---

## Verified on macOS

These were checked by running the code, not by reading it.

| Claim | How it was checked |
| --- | --- |
| **A machine with no Claude Code works fine** | `detectedHarnesses()` calls `detect()` per harness and filters out false. Simulated a machine where every `detect()` returns false: returns an empty list, throws nothing. Claude Code's `ps -axo` call is inside the adapter, so it never runs when the harness is not detected. |
| **The Copilot CLI adapter has no POSIX-only code in its read path** | Uses only `os.homedir()`, `os.tmpdir()`, `path.join`, `path.basename`. No hardcoded separators, no shelling out. Only `openThread` / `newSession` are platform-bound. |
| **Copilot sessions come in two layers** | On the reference machine: **22 of 22** sessions had `workspace.yaml`; only **7** also had `events.jsonl`. Reading only the event log drops two thirds of them. |
| **Node ≥ 20 is the stated floor** | `package.json` `engines`. The test suite uses built-in `node:test`, no dependency. |

---

## Blockers, in the order you will hit them

### 1. npm refuses to install — `package.json`

```json
"os": [ "darwin" ]
```

`npm install` fails with `EBADPLATFORM` before anything else can be tried. Either widen the
array or drop the key. Nothing else in the tree depends on it.

### 2. The OS opener — `server/api.mjs:82`

```js
function launch(url) {
  const child = spawn('open', [url], { stdio: 'ignore', detached: true })
  child.unref()
}
```

`open` is macOS-only, and this one function serves **three** routes: `/api/open` (open a
thread), `/api/reveal` (show a folder), `/api/new-session`. All three break together.

Suggested shape — decide at runtime, not at install, so one checkout works on both:

```js
const opener = process.platform === 'win32'
  ? (url) => spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
  : (url) => spawn('open', [url], { stdio: 'ignore', detached: true })
```

Note the empty `''` argument after `start` — it is the window-title slot, and omitting it
makes `start` treat a quoted path as the title and silently do nothing.

### 3. Absolute-path check rejects every Windows path — `server/api.mjs:93`

```js
if (typeof folder !== 'string' || !folder.startsWith('/')) return null
```

`C:\Users\…` does not start with `/`, so `resolveFolder` returns null and **every reveal and
new-session fails** with "That folder is not on this machine any more". The message points at
a missing folder, so this one costs debugging time if you meet it before reading this.

Use `path.isAbsolute(folder)` — correct on both platforms. Keep the `stat` check that follows
it; that part is the actual security property and is already portable.

### 4. The Copilot CLI launcher is a bash script — `server/harnesses/copilot-cli.mjs`

`openThread` and `newSession` write a `.command` file containing `#!/bin/bash` and return its
`file://` URL, because Copilot CLI has no URL scheme. On Windows this needs to be a `.cmd`:

```bat
@echo off
cd /d "<cwd>"
copilot --resume=<id>
```

Both functions are small and adjacent; a single `launcherFor(platform)` helper covers them.
Keep the `JSON.stringify` quoting of the path — the reason it is there is paths with spaces,
which is *more* common on Windows, not less.

### 5. Cosmetic: home-directory shortening — `src/ui/hud.js:759`

```js
const home = dir.replace(/^\/Users\/[^/]+/, '~')
const parts = home.split('/')
```

Windows paths will not match `/Users/…` and will not split on `/`, so the HUD shows the full
`C:\Users\…` string untrimmed. Nothing breaks; it just looks wrong. Lowest priority.

### Not a blocker for this machine: `server/harnesses/claude-code.mjs:91,102`

That adapter parses POSIX paths (`cwd.split('/')`, and a leading-`-` encoding it expands to
`/`). It only runs if Claude Code is detected, which on the target machine it will not be. It
would need work for a *general* Windows port; it does not block this one.

---

## Already portable — do not spend time here

- `tools/build-assets.mjs` spawns `process.execPath`, not a shell.
- `DATA_DIR` / `STATE_FILE` (`server/api.mjs:16`) use `path.join`.
- `server/lib/fsutil.mjs` is `node:fs/promises` throughout.
- Vite, three.js, and the whole `src/` render path have no OS dependency beyond point 5.
- The Copilot CLI adapter's parsing, caching and Thread mapping.

---

## Unverified — this is what the Windows machine is for

Ranked by how much of the port depends on the answer.

1. **Where Copilot CLI stores sessions on Windows.** The adapter assumes
   `os.homedir()/.copilot/session-state/<uuid>/`, i.e. `%USERPROFILE%\.copilot\…`.
   `os.homedir()` resolves correctly either way, so **if the layout matches, detection just
   works**. If Copilot CLI uses `%APPDATA%` or `%LOCALAPPDATA%` instead, `DEFAULT_ROOT` in
   `copilot-cli.mjs:26` is the one line to change. **Check this first — everything else is
   wasted effort if it is wrong.**

   ```powershell
   dir $env:USERPROFILE\.copilot\session-state
   dir $env:APPDATA\copilot, $env:LOCALAPPDATA\copilot   # if the first is empty
   ```

2. **Whether the two file formats are identical on Windows.** The parser expects
   `workspace.yaml` with flat `key: value` (`cwd`, `git_root`, `repository`, `branch`,
   `created_at`, `updated_at`) and `events.jsonl` with
   `{ id, parentId, timestamp, type, data }`. Windows paths inside those files are fine —
   they are only ever displayed and passed back to `cd`.

3. **Whether `copilot --resume=<session-id>` behaves the same.** Verified present in
   `copilot --help` on macOS with CLI 1.0.81.

4. **The dev-server bind.** On macOS `npm run dev` lets Vite choose, and it picks IPv6 `::1`,
   so `http://127.0.0.1:5274` is **refused** while `http://localhost:5274` works — even though
   the README and `server/serve.mjs` both say 127.0.0.1. Worth knowing before concluding the
   server is broken. `npx vite --host 127.0.0.1` pins it.

5. **WebGL under whatever GPU/driver the machine has.** Expected fine, unconfirmed.

---

## Verifying the port

Steps 1–3 are from `server/harnesses/README.md`; the rest is specific to this port.

```powershell
node --check server\harnesses\copilot-cli.mjs
node --test test\copilot-cli.test.mjs          # 9 tests, synthetic fixtures, no real sessions
```

Those two prove nothing about Windows paths on their own — the fixtures build their own temp
tree — but they prove the parser survived any edits.

```powershell
curl http://localhost:5274/api/harnesses
# expect: copilot-cli detected:true, claude-code detected:false
```

Then the real check, which is the one that matters:

```powershell
node -e "import('./server/scan.mjs').then(async m => { const t = (await m.scanThreads()).filter(x => x.harness === 'copilot-cli'); console.log(t.length, 'threads'); console.dir(t[0], { depth: 4 }) })"
```

The count should match the number of directories under `session-state`, and **no field should
be `undefined`**. If the count is lower than the directory count, the `workspace.yaml` fallback
is not firing — that is the bug that cost the most time on macOS, and it fails quietly.

Finally, in the browser: astronauts on the right plots, thread cards filled in, and Open
actually launching a resumed session.

---

## Suggested order

1. Answer unverified question 1. Everything depends on it.
2. `package.json` — get `npm install` to run.
3. `server/api.mjs:93` — `path.isAbsolute`. One line, and it silently breaks two routes.
4. `server/api.mjs:82` — the opener.
5. `copilot-cli.mjs` — the `.cmd` launcher.
6. `src/ui/hud.js:759` — cosmetic, do it last or not at all.

Keep every change runtime-branched rather than platform-specific files, so one checkout runs
on both machines. That also keeps the diff small enough to be worth offering upstream, where
the README already says the Windows opener is the missing piece.
