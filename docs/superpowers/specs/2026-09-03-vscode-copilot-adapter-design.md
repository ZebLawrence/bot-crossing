# VS Code Copilot harness adapter — design

**Date:** 2026-09-03
**Status:** approved, ready to plan

A third harness adapter, `vscode-copilot`, so that threads from VS Code's native Copilot Chat
panel appear in the colony alongside Claude Code and Copilot CLI.

Every count in this document was measured on one Windows machine with 149 VS Code chat session
files. They are there to justify the design, and as a sanity check on the shape of a scan's
result — not as fixtures to assert against.

## Why this is not "share the CLI's logs"

The obvious guess is that VS Code Copilot and Copilot CLI write the same session records.
There are three stores, not one:

| Store | Written by | Sessions found |
| --- | --- | --- |
| `~/.copilot/session-state/<uuid>/` | Copilot CLI in a terminal **and** the Copilot CLI sidebar inside VS Code | 78 |
| `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\` | VS Code's native Copilot Chat panel | 149 |
| `%APPDATA%\Code\User\globalStorage\github.copilot-chat\session-store.db` | VS Code's bundled CLI agent (`host_type='vscode'`) | 1 |

There *is* an overlap, and it runs the other way from the guess.
`~/.copilot/sidebar-sessions-state/*.json` holds `{ schemaVersion, cwd, sessionIds }`, and those
ids are ordinary directories in `~/.copilot/session-state/` — the VS Code Copilot sidebar writes
into the CLI's own store, through the `copilotCLIShim.js` the extension ships. The existing
`copilot-cli` adapter already returns those threads.

So reading `~/.copilot` from a second adapter would hand back ids the first one owns. That is
exactly the id collision `server/harnesses/README.md` forbids: the colony keys its archive list
and saved layout on `id`, and two adapters claiming one id merge two unrelated threads into one
astronaut.

The new adapter therefore owns **only** `chatSessions/`, and touches nothing under `~/.copilot`.

## Scope

In:

- Both generations of VS Code chat session file, `.json` and `.jsonl`.
- VS Code stable and Insiders, on Windows and macOS, under one harness id.
- Labelling sidebar-born threads in the *existing* `copilot-cli` adapter.

Out:

- Cursor, Windsurf, VSCodium. They fork the workspace-storage layout but do not run Copilot Chat.
- `globalStorage\github.copilot-chat\session-store.db` (see [Rejected](#rejected-alternatives)).
- Reading `.git/HEAD` for a branch. No other adapter does; `gitBranch` stays `''`.

## Where the data lives

```
<root>\User\workspaceStorage\<hash>\
  workspace.json              "folder": "file:///c%3A/Projects/foo"   (61 of 63 here)
                              "workspace": "file:///…/foo.code-workspace"  (2 of 63)
  chatSessions\<uuid>.json     one JSON document, version 3, pretty-printed
  chatSessions\<uuid>.jsonl    line 0 = the same document, then append-only patch records
```

Roots, all scanned:

| Platform | Roots |
| --- | --- |
| win32 | `%APPDATA%\Code`, `%APPDATA%\Code - Insiders` |
| darwin | `~/Library/Application Support/Code`, `~/Library/Application Support/Code - Insiders` |

Both file generations coexist inside a single workspace's `chatSessions/` — four workspaces here
hold a mix — so reading one format silently drops about half the colony.

### `.json` — one document

Measured key order, which is what decides whether a bounded read can reach a field:

```
version, responderUsername, responderAvatarIconUri, initialLocation,
requests[ … ],                       ← the bulk of the file
sessionId, creationDate, lastMessageDate, customTitle, hasPendingEdits, inputState
```

A request is `{ requestId, message, variableData, response, agent, timestamp, modelId,
responseId, result, … }`, and a message is `{ parts, text }`.

Two consequences that are easy to get wrong:

- **The file is pretty-printed** — `"version": 3`, with spaces and newlines. Every pattern needs
  `\s*` around the colon. A naive `"text":"` matches nothing in any of the 73 files.
- `modelId` and `agent` sit *after* `response` inside a request, and `customTitle` sits *after*
  the whole `requests` array. Neither is reliably reachable from a head.

### `.jsonl` — snapshot plus patches

- `{"kind":0,"v":{ … }}` — the document, same shape as `.json`, written once, compact.
- `{"kind":1,"k":["requests",0,"result"],"v":{…}}` — set the value at that path.
- `{"kind":2,"k":["requests"],"v":[{…}]}` — append to the array at that path.

The trap here is that **line 0 is written before the first prompt exists**. Measured over 76
files, line 0 alone yields `sessionId`, `creationDate` and `initialLocation` 76/76, but a
request only 11/76 and `customTitle` 10/76 — and `lastMessageDate` never. The requests arrive
later, as `kind:2` appends. So "parse line 0 and stop" would leave most threads nameless.

## Reading strategy

Sizes, across all 149 files:

| | files | total | median | max |
| --- | --- | --- | --- | --- |
| `.json` | 73 | **151.57 MB** | 202 KB | 24.28 MB |
| `.jsonl` | 76 | 55.48 MB | 12 KB | 12.87 MB |

Full parsing is out. Both readers take a **256 KB head**, and everything is cached against mtime
the way `transcriptMeta` is in `claude-code.mjs`, because the scan runs on a poll. 256 KB is the
knee of the curve for both formats and is the same order as the Claude adapter's 192 KB.

### `.jsonl` — head-scan the patch log

`readHead` + `jsonLines`, the helpers that already exist, then walk the records:

| Record | Take |
| --- | --- |
| `kind:0` | `sessionId`, `creationDate`, `initialLocation`, `customTitle`, `hasPendingEdits`, and any `requests` already inlined |
| `kind:2`, `k = ["requests"]` | appended requests → first `message.text`, latest `modelId`, latest `agent.id` |
| `kind:1`, `k = ["customTitle"]` / `["hasPendingEdits"]` | override the line-0 value |

**Line-0 fallback.** `readHead` drops a trailing partial line, so a line 0 longer than 256 KB
leaves nothing parseable. Four files here have one (346 KB to 1043 KB). When the head yields no
`kind:0` record, re-read line 0 on its own, capped at 4 MB, and use that.

Coverage of the 42 sessions that have a prompt at all: 34 from a 64 KB head, **37 from 256 KB**,
**40 with the fallback**. The last two are a request appended beyond 256 KB and a request whose
message carries no text. Cold read ≈ 4.7 MB.

`lastMessageDate` is absent from line 0 in all 76 files, so mtime is the only source of last
activity for this format.

### `.json` — 256 KB head plus 8 KB tail

**Head**, for the prompt: find the first `"message"\s*:\s*\{`, brace-match that object, and
`JSON.parse` just it. Recovers `text` for **64/73**; the other 9 have no prompt anywhere. A
plain regex on `"text"` is wrong here — `message` is `{ parts, text }` and `parts[]` entries
carry their own `text`, so the first match can be a fragment. The brace-match must track string
state so a `}` inside a string value does not close the object early.

Also from the head: `initialLocation` (byte ~322 in every file), and best-effort `modelId`
(38/48 of the files that have one) and `agent.id` (53/73).

**Tail**, for the trailing scalars: `creationDate` 72/73, `lastMessageDate` 72/73,
`customTitle` 47 of the 48 that have one, `hasPendingEdits` 32/73 — that key is optional, and
absent means false. The single miss on the dates is a file with a large trailing `inputState`;
fall back to mtime.

Cold read ≈ 15 MB, against 151 MB for a full parse.

`readTail(file, bytes)` does not exist yet and is added next to `readHead` in
`server/lib/fsutil.mjs`. It is harness-agnostic and belongs there.

### Empty sessions are skipped

43 of the 149 files — 34 `.jsonl` and 9 `.json` — contain no request at all: sessions opened and
abandoned without a prompt. They would otherwise become nameless astronauts on the map.

The skip rule is made safe by construction rather than by guessing: **skip only when the read
covered the entire file and found no request.** If `size <= 256 KB` the head is the whole file,
so "no requests" is certain; if the file is larger, keep it and title it `'Untitled thread'`,
because absence of evidence is not evidence there. All 43 empty files here are under 256 KB, and
no file over 256 KB lacks a request, so the rule drops exactly the empty ones.

### One session can exist in both formats

Two uuids here have **both** a `.json` and a `.jsonl` — sessions VS Code migrated to the newer
format without removing the old file. Since the id is the filename stem, emitting both would
hand the colony two threads with the same `vscode-copilot:<uuid>`, which is the id collision the
adapter contract forbids, arrived at from inside a single adapter rather than between two.

Sessions are therefore deduplicated by uuid after the empty-session skip, preferring the
`.jsonl` — it is the format the session was migrated *to*. Doing it after the skip matters: if
the surviving copy of a pair is the older one because the newer is empty, the thread is still
kept.

Expected result: **104 threads** from 149 files.

## The `Thread` mapping

| Field | Source |
| --- | --- |
| `id` | `vscode-copilot:<uuid>`, the uuid being the filename stem |
| `harness` / `harnessName` | `vscode-copilot` / `VS Code Copilot` |
| `title` | `customTitle`, else the first line of the first `message.text` (120 chars), else `'Untitled thread'` |
| `preview` | first `message.text`, 240 chars |
| `project` | basename of `projectPath` |
| `projectPath` | `workspace.json` `folder`, URI-decoded; for `workspace`, the dirname of the `.code-workspace` file |
| `cwd` | same as `projectPath` |
| `worktree` | `''` |
| `gitBranch` | `''` |
| `model` | `modelId` where reachable, `github.copilot-chat/` prefix stripped — `claude-sonnet-4` |
| `effort` | chat mode from `agent.id`: `github.copilot.editsAgent` → `agent`, `github.copilot.default` → `ask`, otherwise the bare suffix |
| `createdAt` | `creationDate`, else mtime |
| `lastActivityAt` | `max(lastMessageDate, mtime)` — `.jsonl` has only mtime |
| `lastFocusedAt` | `0` |
| `running` | `now - lastActivityAt < 60_000`, the same window Copilot CLI uses |
| `unread` | `hasPendingEdits` |
| `hasError` | `errorDetails` seen in what was read |
| `archived` / `starred` | `false` |
| `sizeBytes` | file size |
| `source` | `initialLocation` — `panel`, `editor` or `terminal` |
| `canOpen` / `canArchive` | `true` / `false` |
| `ref` | `{ id, file, projectPath }` |

For a `.code-workspace`, `project` is the workspace file's basename without its extension — a
multi-root workspace has no single repo root, and the workspace name is what a human calls it.

A workspace whose folder no longer exists still yields its threads; the path is history, and the
project name derives from the path either way.

`model`, `effort` and `hasError` are **best-effort by design**: each is filled when the bounded
read happens to reach it and left empty or false otherwise. A blank model on a card is a smaller
cost than a 24 MB parse on a poll, and a missed error only means an astronaut is not slumped.

### `hasPendingEdits` → `unread`

VS Code records no read/unread state, so the literal mapping is "always `false`" and the
astronaut never holds a `?`. Pending edits — model changes sitting unaccepted in the working
tree — is the one thing Copilot Chat records that means *this is waiting on you*, which is what
`unread` drives.

It is rare in the data: 1 of 76 `.jsonl` sessions is genuinely pending, and line 0 disagrees
with a full replay of the patch log in exactly 1 of 76. That rarity is the point rather than an
objection — a pending edit is transient because you accept or reject it, so the sessions that
show it are the ones actually waiting on you. Reading a tail as well to catch the last
`hasPendingEdits` patch was measured and rejected: it would fix that one file and finds no
`errorDetails` at all.

## Open, new session, archive

`openThread(ref)` returns `{ ok: true, url: 'vscode://file/<projectPath>' }`, which opens or
focuses that folder in VS Code. `newSession(dir)` returns the same for `dir`.

This lands in the project, not on the thread, and that is the ceiling. Verified by inspection
rather than assumed: the bundled `copilot` extension (`copilot-chat` 0.64.0) declares `onUri`,
but its handler accepts only `/fixTestFailure` and a named-pipe path, and VS Code core's own URI
paths are `/` and `/upgrade-success`. There is no chat-session deep link to use.

No launcher script and no dependency on `code` being on `PATH`: unlike Copilot CLI, reopening
here does not mean running a command, so the `vscode://` URL goes straight through the OS opener
the server already has.

`setArchived` declines with *"VS Code keeps no archived state for chat sessions"*. The colony
records the archive on its own side and the astronaut still walks back to the ship.

`appStartedAt` is omitted. It exists to tell "flag picked up" from "flag still on disk" for an
app that rewrites its records from memory; this adapter never writes a flag.

## Failure behaviour

Per the ground rules in `server/harnesses/README.md`:

- `detect()` is true when any root's `workspaceStorage` directory exists. Cheap, so installing
  VS Code while the colony is open is noticed on the next poll. VS Code present without Copilot
  means a detected harness with zero threads, which is the same bargain `copilot-cli` makes.
- A workspace directory with no `chatSessions/` is skipped.
- A `workspace.json` that is missing or unparseable leaves `projectPath` empty; the thread still
  appears, with no zone of its own.
- A session file that is unreadable, truncated or being written right now is skipped. One bad
  file costs its own thread and nothing else — never the pass.
- Read-only throughout. The adapter writes nothing.

## Change to `copilot-cli.mjs`

`~/.copilot/sidebar-sessions-state/*.json` is read once per scan — two files of ~180 bytes here
— and its `sessionIds` are collected into a set. A thread whose id is in that set gets
`source: 'vscode-sidebar'` rather than `'cli'`.

Attribution only. The threads stay with `copilot-cli`, which is where their files are. Moving
them to the new adapter was considered and rejected: it would make both adapters depend on the
same directory, and a stale marker file would then silently drop or duplicate threads instead of
just mislabelling one.

## Rejected alternatives

**`globalStorage\github.copilot-chat\session-store.db`.** Its `sessions` table is keyed by the
same chat-session uuid and carries `repository`, `branch`, `summary`, `agent_name` and
`host_type` — it would fill in `gitBranch` and give better titles. It holds **one row** on the
machine this was measured on, and reading it needs `node:sqlite`, which arrives in Node 22.5
while `package.json` declares `>=20`. One field is not worth raising the engine floor.

**Reading `~/.copilot` from this adapter.** Id collision with `copilot-cli`; see above.

**Parsing line 0 of a `.jsonl` and stopping.** Yields a request for only 11 of 76 files.

**A 1 MB head.** Buys 39/42 prompts against 40/42 for 256 KB plus the line-0 fallback, for a
14.9 MB cold read against 4.7 MB.

**Brace-matching `requests[0]` in a `.json` to read `modelId` properly.** A request runs to
hundreds of kilobytes; `modelId` sits after `response`, so this is the 151 MB parse again.

## Verification

Against the checklist in `server/harnesses/README.md`:

1. `node --check server/harnesses/vscode-copilot.mjs`
2. `curl -s localhost:5274/api/harnesses` shows `vscode-copilot` with `detected: true`.
3. A scan straight from node returns **104** threads from 149 files — 43 skipped as empty, two
   uuids deduplicated — with no field `undefined`, **102** carrying a real title rather than
   `'Untitled thread'`, 76 a model and 91 a chat mode. Every `id` in the result is unique.
4. `npm run dev` — astronauts land on the right plots, thread cards fill in, Open focuses the
   right VS Code window, Archive is greyed out.
5. `copilot-cli` still returns 78 threads, of which the four ids listed in
   `sidebar-sessions-state/` carry `source: 'vscode-sidebar'`.
6. A second scan does no re-reading: the mtime cache holds, so only changed files are re-read.
