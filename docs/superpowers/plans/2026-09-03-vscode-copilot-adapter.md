# VS Code Copilot Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `vscode-copilot` harness adapter so threads from VS Code's native Copilot Chat panel appear in the colony.

**Architecture:** One new adapter module reads `chatSessions/` under each VS Code workspace-storage directory, in both the `.json` and `.jsonl` formats VS Code has used. Every read is bounded — a 256 KB head for both formats plus an 8 KB tail for `.json` — and cached against mtime, because the scan runs on a poll and the files reach 24 MB. Nothing under `~/.copilot` is touched, so ids cannot collide with the existing `copilot-cli` adapter.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, no new dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-03-vscode-copilot-adapter-design.md`](../specs/2026-09-03-vscode-copilot-adapter-design.md)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/lib/fsutil.mjs` | **Modify** — add `readTail`, the mirror of `readHead` |
| `server/harnesses/vscode-copilot.mjs` | **Create** — the whole adapter |
| `server/harnesses/index.mjs` | **Modify** — one import, one list entry |
| `server/harnesses/copilot-cli.mjs` | **Modify** — label sidebar-born sessions |
| `test/vscode-copilot.test.mjs` | **Create** — adapter tests |
| `test/fsutil.test.mjs` | **Create** — `readTail` tests |
| `test/copilot-cli.test.mjs` | **Modify** — sidebar labelling test |
| `package.json` | **Modify** — add a `test` script |
| `README.md` | **Modify** — harness table row |
| `server/harnesses/README.md` | **Modify** — starting-points entry |

The adapter is one file because that is the contract in `server/harnesses/README.md`: one module per harness, registered in `index.mjs`, with nothing else in the codebase changing.

Inside it, the two format readers are separate functions that produce the same `meta` shape, so the mapping to a `Thread` is written once. **Both readers, plus `readWorkspace` and `pathFromFileUri`, are named exports** alongside the default export. They are the units under test: exporting them is what lets each task below finish with a green suite instead of committing red tests that only go green three tasks later.

---

## Task 1: Test script and `readTail`

Every later task runs `npm test`, so that comes first. `readTail` is the one shared helper the adapter needs.

**Files:**
- Modify: `package.json`
- Modify: `server/lib/fsutil.mjs`
- Test: `test/fsutil.test.mjs` (create)

- [ ] **Step 1: Add the test script**

The suite already exists but has no npm script. In `package.json`, add `test` to `scripts`, after `assets`:

```json
    "assets": "node tools/build-assets.mjs",
    "test": "node --test \"test/*.test.mjs\""
```

Note the quoting: the glob must reach Node, not be expanded by the shell. `node --test test/` does **not** work — it tries to load `test` as a module.

- [ ] **Step 2: Run it to confirm the existing suite passes**

Run: `npm test`
Expected: `pass 11`, `fail 0`, exit 0.

- [ ] **Step 3: Write the failing test**

Create `test/fsutil.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readTail } from '../server/lib/fsutil.mjs'

async function fileWith(content) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fsutil-test-'))
  const file = path.join(dir, 'sample.txt')
  await writeFile(file, content)
  return file
}

test('readTail returns the last bytes of a file', async () => {
  assert.equal(await readTail(await fileWith('0123456789'), 4), '6789')
})

test('readTail returns the whole file when it is shorter than the window', async () => {
  assert.equal(await readTail(await fileWith('abc'), 4096), 'abc')
})

test('readTail on an empty file returns an empty string', async () => {
  assert.equal(await readTail(await fileWith(''), 4096), '')
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `readTail is not a function`, because it does not exist yet.

- [ ] **Step 5: Implement `readTail`**

In `server/lib/fsutil.mjs`, add directly below `readHead`:

```js
/**
 * Read the last chunk of a file — the mirror of `readHead`, for a format that keeps its
 * scalars after the bulk of its data. A VS Code `.json` chat session puts `creationDate`,
 * `lastMessageDate` and `customTitle` after a `requests` array that runs to megabytes.
 *
 * Unlike `readHead` this does not trim a partial line: callers match patterns against the
 * text rather than parsing it line by line, and trimming the front would drop the first
 * field as often as not.
 */
export async function readTail(file, bytes) {
  const fh = await fsp.open(file, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(bytes, size)
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    const { bytesRead } = await fh.read(buf, 0, len, size - len)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: `pass 14`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add package.json server/lib/fsutil.mjs test/fsutil.test.mjs
git commit -m "Add readTail and an npm test script"
```

---

## Task 2: Roots, detection and the workspace folder

The adapter's outermost layer: which directories to look in, and how a workspace hash becomes a project.

**Files:**
- Create: `server/harnesses/vscode-copilot.mjs`
- Test: `test/vscode-copilot.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `test/vscode-copilot.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import vscode, { pathFromFileUri, readWorkspace } from '../server/harnesses/vscode-copilot.mjs'

/**
 * Build a throwaway VS Code roaming directory. `workspaces` maps a storage-hash name to
 * `{ folder | workspace, sessions: { '<uuid>.json(l)': '<file body>' } }`.
 */
async function fakeRoot(workspaces) {
  const root = await mkdtemp(path.join(tmpdir(), 'vscode-test-'))
  for (const [hash, ws] of Object.entries(workspaces)) {
    const dir = path.join(root, 'User', 'workspaceStorage', hash)
    await mkdir(dir, { recursive: true })
    if (ws.folder || ws.workspace) {
      const key = ws.folder ? 'folder' : 'workspace'
      await writeFile(path.join(dir, 'workspace.json'),
        JSON.stringify({ [key]: ws.folder || ws.workspace }))
    }
    for (const [name, body] of Object.entries(ws.sessions || {})) {
      await mkdir(path.join(dir, 'chatSessions'), { recursive: true })
      await writeFile(path.join(dir, 'chatSessions', name), body)
    }
  }
  return root
}

const wsDir = (root, hash) => path.join(root, 'User', 'workspaceStorage', hash)

test('decodes a Windows folder URI, upper-casing the drive letter', () => {
  assert.equal(pathFromFileUri('file:///c%3A/Projects/flight-app'),
    path.normalize('C:/Projects/flight-app'))
})

test('decodes a POSIX folder URI unchanged', () => {
  assert.equal(pathFromFileUri('file:///Users/z/Projects/flight-app'),
    path.normalize('/Users/z/Projects/flight-app'))
})

test('returns empty for something that is not a file URI', () => {
  assert.equal(pathFromFileUri('vscode-remote://ssh/x'), '')
  assert.equal(pathFromFileUri(undefined), '')
})

test('reads a project name and path out of a workspace folder', async () => {
  const root = await fakeRoot({ abc: { folder: 'file:///c%3A/Projects/flight-app' } })
  assert.deepEqual(await readWorkspace(wsDir(root, 'abc')), {
    projectPath: path.normalize('C:/Projects/flight-app'),
    project: 'flight-app',
  })
})

test('names a multi-root workspace after its .code-workspace file', async () => {
  const root = await fakeRoot({ abc: { workspace: 'file:///c%3A/Projects/agent-sessions.code-workspace' } })
  assert.deepEqual(await readWorkspace(wsDir(root, 'abc')), {
    projectPath: path.normalize('C:/Projects'),
    project: 'agent-sessions',
  })
})

test('reports no project when workspace.json is missing or unreadable', async () => {
  const root = await fakeRoot({ abc: {} })
  assert.deepEqual(await readWorkspace(wsDir(root, 'abc')), { projectPath: '', project: '' })
})

test('detect is false when the machine has no VS Code storage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vscode-empty-'))
  assert.equal(await vscode.detect({ roots: [root] }), false)
})

test('detect is true once a workspaceStorage directory exists', async () => {
  const root = await fakeRoot({ abc: { folder: 'file:///r' } })
  assert.equal(await vscode.detect({ roots: [root] }), true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server/harnesses/vscode-copilot.mjs'`.

- [ ] **Step 3: Create the adapter**

Create `server/harnesses/vscode-copilot.mjs`:

```js
/**
 * VS Code Copilot Chat — the chat panel built into VS Code.
 *
 * Sessions live per workspace, under `<root>/User/workspaceStorage/<hash>/chatSessions/`,
 * in two formats that coexist in the same directory:
 *
 *   - `<uuid>.json`  — one pretty-printed document, `version: 3`. `requests` sits in the
 *     middle and runs to megabytes; `creationDate`, `lastMessageDate` and `customTitle`
 *     come after it. Read as a bounded head plus a bounded tail.
 *   - `<uuid>.jsonl` — line 0 is that same document, then append-only patch records
 *     (`kind:1` sets the value at a path, `kind:2` appends to the array at a path). Line 0
 *     is written *before the first prompt exists*, so it is head-scanned rather than read
 *     alone: measured over 76 files, line 0 by itself yields a request for only 11.
 *
 * The sibling `workspace.json` is what turns a storage hash back into a project.
 *
 * This adapter deliberately does not read `~/.copilot`. The Copilot sidebar inside VS Code
 * writes *there*, and `copilot-cli.mjs` already returns those threads — claiming them here
 * too would produce two threads with one id. See server/harnesses/README.md.
 *
 * Read-only. VS Code keeps no archived state for chat sessions, so `setArchived` declines
 * and the colony keeps that state on its own side.
 */
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { exists } from '../lib/fsutil.mjs'

/** Stable and Insiders share a layout and a product; they differ only by directory name. */
const VARIANTS = ['Code', 'Code - Insiders']

export function defaultRoots() {
  const home = os.homedir()
  if (process.platform === 'darwin')
    return VARIANTS.map((v) => path.join(home, 'Library', 'Application Support', v))
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  return VARIANTS.map((v) => path.join(appData, v))
}

const storageDir = (root) => path.join(root, 'User', 'workspaceStorage')

/**
 * `file:///c%3A/Projects/foo` -> `C:\Projects\foo`, `file:///Users/z/foo` -> `/Users/z/foo`.
 *
 * The drive letter is why this is not `new URL(...).pathname`: that leaves the leading
 * slash on `/c:/Projects/foo`. The letter is upper-cased because VS Code is inconsistent
 * about its case, and two spellings of one path would otherwise look like two projects.
 */
export function pathFromFileUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return ''
  let p
  try {
    p = decodeURIComponent(uri.slice('file://'.length))
  } catch {
    return '' // a malformed percent-escape is not worth losing the thread over
  }
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1)
  return p ? path.normalize(p) : ''
}

/** Which project a workspace-storage directory belongs to. Empty when it cannot be told. */
export async function readWorkspace(dir) {
  let ws
  try {
    ws = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'))
  } catch {
    return { projectPath: '', project: '' }
  }
  if (ws?.folder) {
    const p = pathFromFileUri(ws.folder)
    if (p) return { projectPath: p, project: path.basename(p) }
  }
  if (ws?.workspace) {
    const p = pathFromFileUri(ws.workspace)
    // A multi-root workspace has no single repo root, so it is named after its own file.
    if (p) return { projectPath: path.dirname(p), project: path.basename(p, path.extname(p)) }
  }
  return { projectPath: '', project: '' }
}

export default {
  id: 'vscode-copilot',
  name: 'VS Code Copilot',
  detect: async ({ roots } = {}) => {
    for (const root of roots || defaultRoots()) if (await exists(storageDir(root))) return true
    return false
  },
  scanThreads: async () => [],
  openThread: () => ({ ok: false, error: 'not implemented yet' }),
  newSession: () => ({ ok: false, error: 'not implemented yet' }),
  setArchived: async () => ({ ok: false, error: 'not implemented yet' }),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `pass 22`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/vscode-copilot.mjs test/vscode-copilot.test.mjs
git commit -m "Find VS Code workspace storage and resolve a workspace to a project"
```

---

## Task 3: The `.jsonl` reader

**Files:**
- Modify: `server/harnesses/vscode-copilot.mjs`
- Test: `test/vscode-copilot.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/vscode-copilot.test.mjs`. Add `readJsonl` to the existing import from the adapter first:

```js
import vscode, { pathFromFileUri, readWorkspace, readJsonl } from '../server/harnesses/vscode-copilot.mjs'
```

Then append:

```js
import { stat } from 'node:fs/promises'

/** Write one session file and hand back the path and its size, which the readers take. */
async function sessionFile(name, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vscode-session-'))
  const file = path.join(dir, name)
  await writeFile(file, body)
  return { file, size: (await stat(file)).size }
}

/** A `.jsonl` session: line 0, then patch records, exactly as VS Code writes them. */
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

const base = (over = {}) => ({
  kind: 0,
  v: {
    version: 3,
    initialLocation: 'panel',
    sessionId: 'ignored',
    creationDate: Date.parse('2026-09-01T10:00:00.000Z'),
    requests: [],
    hasPendingEdits: false,
    ...over,
  },
})

const appendRequest = (text, over = {}) => ({
  kind: 2,
  k: ['requests'],
  v: [{
    requestId: 'r1',
    message: { parts: [], text },
    modelId: 'github.copilot-chat/claude-sonnet-4',
    agent: { id: 'github.copilot.editsAgent' },
    ...over,
  }],
})

const readJsonlFile = async (name, body) => {
  const { file, size } = await sessionFile(name, body)
  return readJsonl(file, size)
}

test('takes the prompt from a request appended after line 0', async () => {
  const m = await readJsonlFile('a.jsonl', jsonl([base(), appendRequest('Fix the login redirect')]))
  assert.equal(m.prompt, 'Fix the login redirect')
  assert.equal(m.modelId, 'github.copilot-chat/claude-sonnet-4')
  assert.equal(m.agentId, 'github.copilot.editsAgent')
  assert.equal(m.requests, 1)
  assert.equal(m.createdAt, Date.parse('2026-09-01T10:00:00.000Z'))
  assert.equal(m.location, 'panel')
  assert.equal(m.complete, true)
})

test('reads a request that line 0 already carried', async () => {
  const m = await readJsonlFile('b.jsonl', jsonl([
    base({ requests: [{ message: { parts: [], text: 'inline prompt' }, modelId: 'github.copilot-chat/gpt-5' }] }),
  ]))
  assert.equal(m.prompt, 'inline prompt')
  assert.equal(m.modelId, 'github.copilot-chat/gpt-5')
})

test('a later customTitle patch wins over line 0', async () => {
  const m = await readJsonlFile('c.jsonl', jsonl([
    base({ customTitle: 'stale' }),
    appendRequest('Fix the login redirect'),
    { kind: 1, k: ['customTitle'], v: 'Login redirect bug' },
  ]))
  assert.equal(m.customTitle, 'Login redirect bug')
  assert.equal(m.prompt, 'Fix the login redirect')
})

test('a later hasPendingEdits patch beats the value line 0 was created with', async () => {
  const m = await readJsonlFile('d.jsonl', jsonl([
    base({ hasPendingEdits: false }),
    appendRequest('Refactor the router'),
    { kind: 1, k: ['hasPendingEdits'], v: true },
  ]))
  assert.equal(m.pendingEdits, true)
})

test('flags an error reported in a request result', async () => {
  const m = await readJsonlFile('e.jsonl', jsonl([
    base(),
    appendRequest('Do the thing'),
    { kind: 1, k: ['requests', 0, 'result'], v: { errorDetails: { message: 'model failed' } } },
  ]))
  assert.equal(m.hasError, true)
})

test('skips a malformed line instead of losing the session', async () => {
  const body =
    JSON.stringify(base()) + '\n' +
    '{"kind":2,"k":["requests"],"v":[{"message":{"text":"half a rec' + '\n' +
    JSON.stringify(appendRequest('survived')) + '\n'
  const m = await readJsonlFile('f.jsonl', body)
  assert.equal(m.prompt, 'survived')
})

test('reports an empty session as having no requests', async () => {
  const m = await readJsonlFile('g.jsonl', jsonl([base()]))
  assert.equal(m.requests, 0)
  assert.equal(m.complete, true)
  assert.equal(m.sawBase, true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `readJsonl is not a function`.

- [ ] **Step 3: Add the meta shape and the `.jsonl` reader**

In `server/harnesses/vscode-copilot.mjs`, extend the `fsutil` import:

```js
import { exists, num, readHead } from '../lib/fsutil.mjs'
```

Then add above the default export:

```js
/** How much of a session file a scan is willing to read. 256 KB is the knee of the curve
 *  for both formats: on 149 real files it recovers 37 of 42 `.jsonl` prompts against 34 at
 *  64 KB and 39 at 1 MB, for a 4.7 MB cold read against 14.9 MB. */
const HEAD_BYTES = 256 * 1024

/** A line 0 longer than the head is rare — 4 of 76 files — but reaches 1 MB when it happens. */
const LINE0_CAP = 4 * 1024 * 1024

/** Everything either reader can learn, so the mapping to a Thread is written once. */
export const emptyMeta = () => ({
  sawBase: false,      // did we recover the document itself, or only patches?
  complete: false,     // did the read cover the whole file? decides the empty-session skip
  requests: 0,
  prompt: '',
  customTitle: '',
  modelId: '',
  agentId: '',
  location: '',
  createdAt: 0,
  lastMessageDate: 0,
  pendingEdits: false,
  hasError: false,
})

function takeRequest(m, q) {
  if (!q || typeof q !== 'object') return
  m.requests++
  const text = q.message?.text
  if (!m.prompt && typeof text === 'string' && text.trim()) m.prompt = text.trim()
  if (q.modelId) m.modelId = String(q.modelId)
  if (q.agent?.id) m.agentId = String(q.agent.id)
  if (q.result?.errorDetails) m.hasError = true
}

/**
 * Fold the patch log into `m`. Only the paths that feed a Thread are honoured — this is
 * deliberately not a general JSON-patch replayer, because nothing on a thread card needs
 * one.
 */
function applyRecords(m, records) {
  for (const r of records) {
    if (r?.kind === 0) {
      const v = r.v || {}
      m.sawBase = true
      if (v.creationDate) m.createdAt = num(v.creationDate)
      if (v.initialLocation) m.location = String(v.initialLocation)
      if (v.customTitle) m.customTitle = String(v.customTitle)
      m.pendingEdits = !!v.hasPendingEdits
      for (const q of v.requests || []) takeRequest(m, q)
      continue
    }
    const k = r?.k
    if (!Array.isArray(k)) continue
    if (r.kind === 2 && k.length === 1 && k[0] === 'requests') {
      for (const q of r.v || []) takeRequest(m, q)
    } else if (r.kind === 1 && k.length === 1) {
      if (k[0] === 'customTitle' && r.v) m.customTitle = String(r.v)
      else if (k[0] === 'hasPendingEdits') m.pendingEdits = !!r.v
    } else if (r.kind === 1 && k.length === 3 && k[0] === 'requests' && k[2] === 'result') {
      if (r.v?.errorDetails) m.hasError = true
    }
  }
}

/** Parse a JSONL blob, skipping the partial or malformed lines a live file always has. */
function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial or malformed record — skip it, keep the rest */
    }
  }
  return out
}

export async function readJsonl(file, size) {
  const m = emptyMeta()
  applyRecords(m, parseLines(await readHead(file, HEAD_BYTES)))
  if (!m.sawBase) {
    // `readHead` drops a trailing partial line, so a line 0 longer than the head leaves
    // nothing parseable. Such a line 0 is long *because* it already holds the requests,
    // so reading it alone recovers the prompt as well as the metadata.
    const text = await readHead(file, LINE0_CAP)
    const nl = text.indexOf('\n')
    applyRecords(m, parseLines(nl < 0 ? text : text.slice(0, nl)))
  }
  m.complete = size <= HEAD_BYTES
  return m
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/vscode-copilot.mjs test/vscode-copilot.test.mjs
git commit -m "Read a VS Code .jsonl chat session by head-scanning its patch log"
```

---

## Task 4: The `.json` reader

**Files:**
- Modify: `server/harnesses/vscode-copilot.mjs`
- Test: `test/vscode-copilot.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `readJson` to the adapter import in `test/vscode-copilot.test.mjs`:

```js
import vscode, { pathFromFileUri, readWorkspace, readJsonl, readJson } from '../server/harnesses/vscode-copilot.mjs'
```

Then append:

```js
/** A pretty-printed `.json` session, which is how VS Code actually writes them. */
const jsonSession = (text = 'Fix the login redirect', extra = {}) =>
  JSON.stringify({
    version: 3,
    initialLocation: 'panel',
    requests: [{
      requestId: 'r1',
      message: { parts: [], text },
      modelId: 'github.copilot-chat/claude-sonnet-4',
      agent: { id: 'github.copilot.editsAgent' },
    }],
    sessionId: 'ignored',
    creationDate: Date.parse('2026-09-01T10:00:00.000Z'),
    lastMessageDate: Date.parse('2026-09-01T12:30:00.000Z'),
    ...extra,
  }, null, 2)

const readJsonFile = async (name, body) => {
  const { file, size } = await sessionFile(name, body)
  return readJson(file, size)
}

test('reads a pretty-printed .json session', async () => {
  const m = await readJsonFile('a.json', jsonSession())
  assert.equal(m.prompt, 'Fix the login redirect')
  assert.equal(m.modelId, 'github.copilot-chat/claude-sonnet-4')
  assert.equal(m.agentId, 'github.copilot.editsAgent')
  assert.equal(m.location, 'panel')
  assert.equal(m.requests, 1)
  assert.equal(m.createdAt, Date.parse('2026-09-01T10:00:00.000Z'))
  assert.equal(m.lastMessageDate, Date.parse('2026-09-01T12:30:00.000Z'))
})

/**
 * `message` is `{ parts, text }` and a `parts` entry carries its own `text`, so a regex on
 * the first `"text"` picks up a fragment. The reader must brace-match the message object.
 */
test('takes the message text, not a text fragment from message.parts', async () => {
  const body = JSON.stringify({
    version: 3,
    initialLocation: 'panel',
    requests: [{ requestId: 'r1', message: { parts: [{ kind: 'text', text: 'FRAGMENT' }], text: 'the real prompt' } }],
    creationDate: 1,
    lastMessageDate: 2,
  }, null, 2)
  const m = await readJsonFile('b.json', body)
  assert.equal(m.prompt, 'the real prompt')
})

/** A `}` inside a string value must not close the object early. */
test('brace-matching survives braces inside the prompt', async () => {
  const body = JSON.stringify({
    version: 3,
    initialLocation: 'panel',
    requests: [{ message: { parts: [], text: 'why does {"a": 1} fail?' } }],
    creationDate: 1,
    lastMessageDate: 2,
  }, null, 2)
  const m = await readJsonFile('c.json', body)
  assert.equal(m.prompt, 'why does {"a": 1} fail?')
})

test('takes customTitle and hasPendingEdits from the tail', async () => {
  const m = await readJsonFile('d.json',
    jsonSession('Fix the login redirect', { customTitle: 'Login redirect bug', hasPendingEdits: true }))
  assert.equal(m.customTitle, 'Login redirect bug')
  assert.equal(m.pendingEdits, true)
})

test('unescapes a customTitle that contains a quote', async () => {
  const m = await readJsonFile('e.json', jsonSession('x', { customTitle: 'the "real" bug' }))
  assert.equal(m.customTitle, 'the "real" bug')
})

test('reports an empty requests array as no requests', async () => {
  const body = JSON.stringify(
    { version: 3, initialLocation: 'panel', requests: [], creationDate: 1, lastMessageDate: 2 }, null, 2)
  const m = await readJsonFile('f.json', body)
  assert.equal(m.requests, 0)
  assert.equal(m.complete, true)
})

test('flags an error recorded in a request result', async () => {
  const body = JSON.stringify({
    version: 3,
    initialLocation: 'panel',
    requests: [{ message: { parts: [], text: 'do it' }, result: { errorDetails: { message: 'nope' } } }],
    creationDate: 1,
    lastMessageDate: 2,
  }, null, 2)
  const m = await readJsonFile('g.json', body)
  assert.equal(m.hasError, true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `readJson is not a function`.

- [ ] **Step 3: Add the brace matcher and the `.json` reader**

Extend the `fsutil` import in `server/harnesses/vscode-copilot.mjs`:

```js
import { exists, num, readHead, readTail } from '../lib/fsutil.mjs'
```

Add below `readJsonl`:

```js
/** `.json` keeps its scalars in the last few hundred bytes; 8 KB is generous. */
const TAIL_BYTES = 8 * 1024

/**
 * The index of the `}` closing the object that opens at `open`, or -1 if it never closes
 * inside `s`. String state is tracked because a `}` inside a prompt is ordinary text.
 */
function matchObject(s, open) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/** Unescape one JSON string body captured by a regex. Empty when it will not parse. */
function jsonString(body) {
  try {
    return String(JSON.parse(`"${body}"`))
  } catch {
    return ''
  }
}

/**
 * These files are **pretty-printed** — `"version": 3`, with whitespace around every colon.
 * Every pattern here needs `\s*`; a plain `"text":"` matches none of the 73 real files.
 *
 * A parser is not an option: `requests` runs to 24 MB, and `JSON.parse` cannot be given a
 * truncated object. So the prompt is brace-matched out of the head, and everything else is
 * matched out of one end or the other.
 */
export async function readJson(file, size) {
  const m = emptyMeta()
  const head = await readHead(file, HEAD_BYTES)
  m.sawBase = true

  const location = /"initialLocation"\s*:\s*"([^"]*)"/.exec(head)
  if (location) m.location = location[1]

  // Whether there are any requests at all, which is what the empty-session skip turns on.
  const requests = /"requests"\s*:\s*\[\s*(.)/.exec(head)
  if (requests) m.requests = requests[1] === ']' ? 0 : 1

  const message = /"message"\s*:\s*\{/.exec(head)
  if (message) {
    const open = message.index + message[0].length - 1
    const end = matchObject(head, open)
    if (end > 0) {
      try {
        const text = JSON.parse(head.slice(open, end + 1))?.text
        if (typeof text === 'string' && text.trim()) m.prompt = text.trim()
      } catch {
        /* not the shape we expect — the thread falls back to Untitled */
      }
    }
  }

  // Best-effort: both sit after `response` inside a request, so a bounded head reaches them
  // for some sessions and not others — 38 of the 48 real files that carry a model, 53 of 73
  // for the mode. A blank field on a card beats a 24 MB parse on a poll.
  const model = /"modelId"\s*:\s*"([^"]*)"/.exec(head)
  if (model) m.modelId = model[1]
  const agent = /"id"\s*:\s*"(github\.copilot\.[A-Za-z]+)"/.exec(head)
  if (agent) m.agentId = agent[1]
  if (head.includes('"errorDetails"')) m.hasError = true

  // When the head already covered the file, it *is* the tail — do not read twice.
  const tail = size > HEAD_BYTES ? await readTail(file, TAIL_BYTES) : head
  const created = /"creationDate"\s*:\s*(\d+)/.exec(tail)
  if (created) m.createdAt = num(created[1])
  const last = /"lastMessageDate"\s*:\s*(\d+)/.exec(tail)
  if (last) m.lastMessageDate = num(last[1])
  const custom = /"customTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tail)
  if (custom) m.customTitle = jsonString(custom[1])
  if (/"hasPendingEdits"\s*:\s*true/.test(tail)) m.pendingEdits = true
  if (tail.includes('"errorDetails"')) m.hasError = true

  m.complete = size <= HEAD_BYTES
  return m
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/vscode-copilot.mjs test/vscode-copilot.test.mjs
git commit -m "Read a VS Code .json chat session from a bounded head and tail"
```

---

## Task 5: The Thread mapping, the empty-session skip and the dedupe

**Files:**
- Modify: `server/harnesses/vscode-copilot.mjs`
- Test: `test/vscode-copilot.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/vscode-copilot.test.mjs`:

```js
test('maps a session to a Thread with project, title, model and mode', async () => {
  const root = await fakeRoot({
    abc: { folder: 'file:///c%3A/Projects/flight-app', sessions: { 'aaaa-1.json': jsonSession() } },
  })
  const [t] = await vscode.scanThreads({ roots: [root] })
  assert.equal(t.project, 'flight-app')
  assert.equal(t.projectPath, path.normalize('C:/Projects/flight-app'))
  assert.equal(t.cwd, t.projectPath)
  assert.equal(t.title, 'Fix the login redirect')
  assert.equal(t.preview, 'Fix the login redirect')
  assert.equal(t.model, 'claude-sonnet-4')
  assert.equal(t.effort, 'agent')
  assert.equal(t.createdAt, Date.parse('2026-09-01T10:00:00.000Z'))
})

test('namespaces the id so it cannot collide with another harness', async () => {
  const root = await fakeRoot({
    abc: { folder: 'file:///r', sessions: { 'dddddddd-0000-0000-0000-000000000001.json': jsonSession() } },
  })
  const [t] = await vscode.scanThreads({ roots: [root] })
  assert.equal(t.id, 'vscode-copilot:dddddddd-0000-0000-0000-000000000001')
  assert.equal(t.harness, 'vscode-copilot')
  assert.equal(t.harnessName, 'VS Code Copilot')
})

test('scans every root it is given', async () => {
  const a = await fakeRoot({ h1: { folder: 'file:///r1', sessions: { 'x-1.json': jsonSession('one') } } })
  const b = await fakeRoot({ h2: { folder: 'file:///r2', sessions: { 'x-2.json': jsonSession('two') } } })
  assert.equal((await vscode.scanThreads({ roots: [a, b] })).length, 2)
})

test('keeps a session whose workspace.json is missing, with no project', async () => {
  const root = await fakeRoot({ abc: { sessions: { 'x-3.json': jsonSession() } } })
  const [t] = await vscode.scanThreads({ roots: [root] })
  assert.equal(t.project, '')
  assert.equal(t.projectPath, '')
  assert.equal(t.title, 'Fix the login redirect')
})

test('skips a session that was opened and abandoned without a prompt', async () => {
  const empty = JSON.stringify(
    { version: 3, initialLocation: 'panel', requests: [], creationDate: 1, lastMessageDate: 2 }, null, 2)
  const root = await fakeRoot({
    abc: {
      folder: 'file:///r',
      sessions: { 'eeee-1.json': empty, 'eeee-2.jsonl': jsonl([base()]), 'eeee-3.json': jsonSession() },
    },
  })
  const threads = await vscode.scanThreads({ roots: [root] })
  assert.equal(threads.length, 1)
  assert.equal(threads[0].id, 'vscode-copilot:eeee-3')
})

/** The same session migrated between formats: one thread, from the newer file. */
test('deduplicates a session that exists as both .json and .jsonl', async () => {
  const root = await fakeRoot({
    abc: {
      folder: 'file:///r',
      sessions: {
        'ffff-1.json': jsonSession('the old copy'),
        'ffff-1.jsonl': jsonl([base(), appendRequest('the migrated copy')]),
      },
    },
  })
  const threads = await vscode.scanThreads({ roots: [root] })
  assert.equal(threads.length, 1)
  assert.equal(threads[0].title, 'the migrated copy')
})

/** If the newer copy is the empty one, the older copy is still a thread. */
test('keeps the .json when its .jsonl counterpart is empty', async () => {
  const root = await fakeRoot({
    abc: {
      folder: 'file:///r',
      sessions: { 'ffff-2.json': jsonSession('the only real copy'), 'ffff-2.jsonl': jsonl([base()]) },
    },
  })
  const threads = await vscode.scanThreads({ roots: [root] })
  assert.equal(threads.length, 1)
  assert.equal(threads[0].title, 'the only real copy')
})

test('falls back to Untitled thread when nothing names the session', async () => {
  const body = JSON.stringify({
    version: 3, initialLocation: 'panel',
    requests: [{ requestId: 'r1', message: { parts: [] } }],
    creationDate: 1, lastMessageDate: 2,
  }, null, 2)
  const root = await fakeRoot({ abc: { folder: 'file:///r', sessions: { 'x-4.json': body } } })
  const [t] = await vscode.scanThreads({ roots: [root] })
  assert.equal(t.title, 'Untitled thread')
  assert.equal(t.preview, '')
})

test('a session touched just now is running; an old one is not', async () => {
  const root = await fakeRoot({ abc: { folder: 'file:///r', sessions: { 'x-5.json': jsonSession() } } })
  const [live] = await vscode.scanThreads({ roots: [root], now: Date.now() })
  assert.equal(live.running, true)
  const [stale] = await vscode.scanThreads({ roots: [root], now: Date.now() + 3_600_000 })
  assert.equal(stale.running, false)
})

test('reports what it cannot do rather than pretending', async () => {
  const root = await fakeRoot({ abc: { folder: 'file:///r', sessions: { 'x-6.json': jsonSession() } } })
  const [t] = await vscode.scanThreads({ roots: [root] })
  assert.equal(t.canOpen, true)
  assert.equal(t.canArchive, false)
  assert.equal(t.archived, false)
  assert.equal(t.gitBranch, '')
  assert.equal(t.worktree, '')
  assert.equal(t.source, 'panel')
  assert.equal(t.sizeBytes > 0, true)
  assert.deepEqual(Object.keys(t.ref).sort(), ['file', 'id', 'projectPath'])
})

test('every field the colony reads is defined', async () => {
  const root = await fakeRoot({ abc: { folder: 'file:///r', sessions: { 'x-7.json': jsonSession() } } })
  const [t] = await vscode.scanThreads({ roots: [root] })
  for (const key of [
    'id', 'harness', 'harnessName', 'title', 'preview', 'project', 'projectPath', 'cwd',
    'worktree', 'gitBranch', 'model', 'effort', 'createdAt', 'lastActivityAt', 'lastFocusedAt',
    'running', 'unread', 'hasError', 'archived', 'starred', 'sizeBytes', 'source', 'canOpen',
    'canArchive', 'ref',
  ]) {
    assert.notEqual(t[key], undefined, `${key} is undefined`)
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `scanThreads` still returns `[]`, so destructuring gives `undefined`.

- [ ] **Step 3: Add the mapping, the cache and the real `scanThreads`**

Extend the imports in `server/harnesses/vscode-copilot.mjs`:

```js
import { readFile, stat } from 'node:fs/promises'

import { exists, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'
```

Add below `readJson`:

```js
/** The CLI writes an event per turn, so anything inside a minute is mid-work. */
const RUNNING_WINDOW_MS = 60_000

const MODEL_PREFIX = 'github.copilot-chat/'

/** VS Code's agent ids, as the chat mode a human would name. */
const MODES = { editsAgent: 'agent', default: 'ask', editingSessionAgent: 'edit' }

const chatMode = (agentId) => {
  const suffix = agentId.split('.').pop() || ''
  return MODES[suffix] || suffix
}

const isSession = (name) => name.endsWith('.json') || name.endsWith('.jsonl')

/**
 * Parsed sessions, keyed by file and invalidated on mtime and size. The scan runs on a
 * poll and these files reach 24 MB, so re-reading an unchanged one every few seconds is
 * what this exists to prevent. Same reason `claude-code.mjs` caches `transcriptMeta`.
 */
const cache = new Map()

async function readSession(file, size, mtimeMs) {
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.meta
  const meta = file.endsWith('.jsonl') ? await readJsonl(file, size) : await readJson(file, size)
  cache.set(file, { mtimeMs, size, meta })
  return meta
}

function toThread(id, file, m, st, projectPath, project, now) {
  const fromPrompt = m.prompt ? m.prompt.split('\n')[0].slice(0, 120) : ''
  const mtime = Math.round(st.mtimeMs)
  const lastActivityAt = Math.max(m.lastMessageDate, mtime)
  return {
    id: `vscode-copilot:${id}`,
    harness: 'vscode-copilot',
    harnessName: 'VS Code Copilot',
    title: m.customTitle || fromPrompt || 'Untitled thread',
    preview: m.prompt.slice(0, 240),
    project,
    projectPath,
    cwd: projectPath,
    worktree: '',
    gitBranch: '', // VS Code records none on a chat session
    model: m.modelId.startsWith(MODEL_PREFIX) ? m.modelId.slice(MODEL_PREFIX.length) : m.modelId,
    effort: m.agentId ? chatMode(m.agentId) : '',
    createdAt: m.createdAt || mtime,
    lastActivityAt,
    lastFocusedAt: 0,
    running: now - lastActivityAt < RUNNING_WINDOW_MS,
    // VS Code keeps no read state. Edits sitting unaccepted in the working tree is the one
    // thing it does record that means "this is waiting on you", which is what unread drives.
    unread: m.pendingEdits,
    hasError: m.hasError,
    archived: false,
    starred: false,
    sizeBytes: st.size,
    source: m.location,
    canOpen: true,
    canArchive: false, // VS Code keeps no archived state for chat sessions
    ref: { id, file, projectPath },
  }
}

async function scanThreads({ roots, now = Date.now() } = {}) {
  // Keyed by session uuid: one session can exist as both a .json and a .jsonl after VS Code
  // migrates it, and two threads with one id would merge into one astronaut.
  const found = new Map()

  for (const root of roots || defaultRoots()) {
    for (const dir of await listDirs(storageDir(root))) {
      const files = await listFiles(path.join(dir, 'chatSessions'), isSession)
      if (!files.length) continue
      const { projectPath, project } = await readWorkspace(dir)

      for (const file of files) {
        let entry
        try {
          const st = await stat(file)
          const m = await readSession(file, st.size, st.mtimeMs)
          // An abandoned session with no request is not a thread. Only skip when the read
          // covered the whole file, so "no requests" is known rather than merely unseen.
          if (m.complete && m.requests === 0) continue
          const id = path.basename(file).replace(/\.jsonl?$/, '')
          entry = {
            id,
            jsonl: file.endsWith('.jsonl'),
            thread: toThread(id, file, m, st, projectPath, project, now),
          }
        } catch {
          continue // unreadable, or being written right now: skip it, never the pass
        }
        const prev = found.get(entry.id)
        // Prefer the .jsonl — it is the format the session was migrated *to*.
        if (!prev || (entry.jsonl && !prev.jsonl)) found.set(entry.id, entry)
      }
    }
  }
  return [...found.values()].map((e) => e.thread)
}
```

Then replace `scanThreads: async () => []` in the default export with `scanThreads,`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/vscode-copilot.mjs test/vscode-copilot.test.mjs
git commit -m "Map a VS Code chat session to a Thread, skipping empties and duplicates"
```

---

## Task 6: Open, new session and archive

**Files:**
- Modify: `server/harnesses/vscode-copilot.mjs`
- Test: `test/vscode-copilot.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/vscode-copilot.test.mjs`:

```js
test('openThread returns a vscode:// URL for the workspace folder', () => {
  const r = vscode.openThread({ id: 'abc-123', projectPath: path.normalize('C:/Projects/flight-app') })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'vscode://file/C:/Projects/flight-app')
})

test('openThread percent-encodes a space but leaves the drive colon alone', () => {
  const r = vscode.openThread({ projectPath: path.normalize('C:/Program Files/App') })
  assert.equal(r.url, 'vscode://file/C:/Program%20Files/App')
})

test('openThread declines when the thread has no folder', () => {
  const r = vscode.openThread({ id: 'abc-123', projectPath: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /folder/i)
})

test('newSession opens the directory it is given', () => {
  const r = vscode.newSession(path.normalize('C:/Projects/flight-app'))
  assert.equal(r.ok, true)
  assert.equal(r.url, 'vscode://file/C:/Projects/flight-app')
})

test('setArchived declines and says why', async () => {
  const r = await vscode.setArchived({ id: 'abc-123' }, true)
  assert.equal(r.ok, false)
  assert.match(r.error, /archived/i)
})
```

On POSIX `path.normalize('C:/Projects/flight-app')` is a no-op, so these hold on either platform.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the five new tests FAIL — `openThread` still returns `not implemented yet`.

- [ ] **Step 3: Implement the three actions**

In `server/harnesses/vscode-copilot.mjs`, add below `toThread`:

```js
/**
 * `vscode://file/C:/Projects/foo`. `encodeURI` rather than `encodeURIComponent`: the drive
 * colon and the separators have to survive, and only characters like a space need escaping.
 * Backslashes become forward slashes because a URL has no other kind.
 */
const fileUri = (p) => `vscode://file/${encodeURI(p.replace(/\\/g, '/'))}`

/**
 * There is no deep link to a chat session — the bundled extension's `onUri` handler takes
 * only `/fixTestFailure` and a named-pipe path — so the best available is to open or focus
 * the window the session belongs to, and let its history list do the rest.
 */
function openThread(ref) {
  const dir = ref?.projectPath
  if (!dir) return { ok: false, error: 'This thread has no workspace folder to open' }
  return { ok: true, url: fileUri(dir) }
}

function newSession(dir) {
  if (!dir) return { ok: false, error: 'No directory to open' }
  return { ok: true, url: fileUri(dir) }
}
```

Then replace the remaining stubs in the default export:

```js
  scanThreads,
  openThread,
  newSession,
  setArchived: async () => ({
    ok: false,
    error: 'VS Code keeps no archived state for chat sessions',
  }),
```

`appStartedAt` is deliberately absent: it exists to tell a picked-up archive flag from one still waiting on disk, and this adapter never writes a flag.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/vscode-copilot.mjs test/vscode-copilot.test.mjs
git commit -m "Open a VS Code chat thread's workspace, and decline what VS Code cannot do"
```

---

## Task 7: Register the harness

**Files:**
- Modify: `server/harnesses/index.mjs`
- Test: `test/vscode-copilot.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/vscode-copilot.test.mjs`:

```js
test('the harness is registered, with an id nothing else uses', async () => {
  const { HARNESSES, harnessById } = await import('../server/harnesses/index.mjs')
  assert.equal(harnessById('vscode-copilot')?.name, 'VS Code Copilot')
  const ids = HARNESSES.map((h) => h.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate harness id in ${ids.join(', ')}`)
})
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm test`
Expected: FAIL — `harnessById('vscode-copilot')` is `null`, so `?.name` is `undefined`.

- [ ] **Step 3: Register it**

In `server/harnesses/index.mjs`, add the import beneath the others and extend the list:

```js
import claudeCode from './claude-code.mjs'
import copilotCli from './copilot-cli.mjs'
import vscodeCopilot from './vscode-copilot.mjs'

export const HARNESSES = [claudeCode, copilotCli, vscodeCopilot]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/index.mjs test/vscode-copilot.test.mjs
git commit -m "Register the VS Code Copilot harness"
```

---

## Task 8: Label sidebar-born Copilot CLI sessions

The Copilot sidebar inside VS Code writes into `~/.copilot/session-state/`, so those threads belong to `copilot-cli`. They should say where they came from.

**Files:**
- Modify: `server/harnesses/copilot-cli.mjs`
- Test: `test/copilot-cli.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/copilot-cli.test.mjs`:

```js
/** `~/.copilot/sidebar-sessions-state/<hash>.json` — the VS Code sidebar's own bookkeeping. */
async function withSidebar(root, cwd, sessionIds) {
  const dir = path.join(root, 'sidebar-sessions-state')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'a'.repeat(64) + '.json'),
    JSON.stringify({ schemaVersion: 1, cwd, sessionIds }))
  return root
}

test('marks a session the VS Code sidebar started, and leaves the others as cli', async () => {
  const inSidebar = 'dddddddd-0000-0000-0000-000000000001'
  const inTerminal = 'dddddddd-0000-0000-0000-000000000002'
  const root = await fakeHome({
    [inSidebar]: [start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z'), userMsg('from vscode', '2026-09-01T10:00:05.000Z')],
    [inTerminal]: [start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z'), userMsg('from a terminal', '2026-09-01T10:00:05.000Z')],
  })
  await withSidebar(root, '/r', [inSidebar])

  const threads = await copilot.scanThreads({ root })
  const byId = Object.fromEntries(threads.map((t) => [t.id, t]))

  assert.equal(byId[`copilot-cli:${inSidebar}`].source, 'vscode-sidebar')
  assert.equal(byId[`copilot-cli:${inTerminal}`].source, 'cli')
})

test('sessions are still cli when there is no sidebar state at all', async () => {
  const root = await fakeHome({
    'dddddddd-0000-0000-0000-000000000003': [start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z')],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.source, 'cli')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `source` is `'cli'` for the sidebar session, because nothing reads that directory yet.

- [ ] **Step 3: Read the sidebar state and thread it through**

In `server/harnesses/copilot-cli.mjs`, add `listFiles` to the `fsutil` import:

```js
import { listDirs, listFiles, exists } from '../lib/fsutil.mjs'
```

Add below `stateDir`:

```js
const sidebarDir = (root) => path.join(root || DEFAULT_ROOT, 'sidebar-sessions-state')

/**
 * Session ids the Copilot sidebar inside VS Code started. It writes into this same store
 * through the `copilotCLIShim.js` that VS Code ships, so these threads are ours — but they
 * did not come from a terminal, and the card should not claim they did.
 *
 * Attribution only. Handing them to the VS Code adapter instead would make two adapters
 * depend on this directory, and a stale marker would then drop or duplicate a thread
 * rather than merely mislabel one.
 */
async function sidebarSessionIds(root) {
  const ids = new Set()
  for (const file of await listFiles(sidebarDir(root), (n) => n.endsWith('.json'))) {
    try {
      for (const id of JSON.parse(await readFile(file, 'utf8'))?.sessionIds || []) ids.add(id)
    } catch {
      /* one unreadable marker should not cost the labelling of the rest */
    }
  }
  return ids
}
```

Change `toThread` to take the flag — its signature and its `source` line:

```js
function toThread(id, s, now, fromSidebar) {
```

```js
    source: fromSidebar ? 'vscode-sidebar' : 'cli',
```

Then in `scanThreads`, read the set once and pass it per thread:

```js
async function scanThreads({ root, now = Date.now() } = {}) {
  const base = stateDir(root)
  if (!(await exists(base))) return []
  const sidebar = await sidebarSessionIds(root)
  const threads = []
  for (const dir of await listDirs(base)) {
    const id = path.basename(dir) // listDirs returns full paths, not bare names
    const base = await readWorkspace(dir)
    let ev = null
    try {
      ev = await readEvents(dir)
    } catch {
      ev = null // no event log on this session, or it is unreadable — the yaml still stands
    }
    if (!base && !ev) continue // neither half readable: skip, never throw the pass away
    threads.push(toThread(id, mergeSession(base, ev), now, sidebar.has(id)))
  }
  return threads
}
```

Finally extend the module header comment. Replace the closing paragraph:

```
 * Read-only. Copilot CLI has no archive concept, so `setArchived` declines and the colony
 * keeps that state on its own side (see server/harnesses/README.md).
 */
```

with:

```
 * Read-only. Copilot CLI has no archive concept, so `setArchived` declines and the colony
 * keeps that state on its own side (see server/harnesses/README.md).
 *
 * Some of these sessions were started by the Copilot sidebar *inside VS Code*, which writes
 * into this same store. They stay here, where their files are, and carry
 * `source: 'vscode-sidebar'` to say so.
 */
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: `fail 0`, with the 11 pre-existing `copilot-cli` tests still passing.

- [ ] **Step 5: Commit**

```bash
git add server/harnesses/copilot-cli.mjs test/copilot-cli.test.mjs
git commit -m "Say when a Copilot CLI session came from the VS Code sidebar"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`
- Modify: `server/harnesses/README.md`

- [ ] **Step 1: Update the harness table in `README.md`**

Add a row directly beneath the Copilot CLI row:

```markdown
| **[VS Code Copilot](https://code.visualstudio.com/docs/copilot/overview)** (GitHub) | ✅ **Supported** — both session formats (`.json` and `.jsonl`), stable and Insiders; opens the workspace |
```

- [ ] **Step 2: Add a starting-points entry in `server/harnesses/README.md`**

Under `## Starting points`, after the **Copilot CLI** bullet, add:

```markdown
- **VS Code Copilot** — the chat panel's own records, per workspace, in
  `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\` (and
  `~/Library/Application Support/Code/…` on macOS), with the sibling `workspace.json`
  naming the folder. Two formats coexist there: `<uuid>.json`, one pretty-printed document,
  and `<uuid>.jsonl`, that document on line 0 followed by patch records. Two traps, both
  measured over 149 real files: line 0 of a `.jsonl` is written *before* the first prompt
  exists and yields a request for only 11 of 76, and the `.json` files are pretty-printed,
  so a pattern without `\s*` matches none of the 73. Note the sidebar overlap — the Copilot
  sidebar in VS Code writes into `~/.copilot/session-state/`, so those threads belong to
  `copilot-cli.mjs`, not here. Implemented in `vscode-copilot.mjs`.
```

- [ ] **Step 3: Check the table still lines up**

Read the modified table block in `README.md` and confirm the new row has the same column count as its neighbours, and that the suite is unaffected:

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add README.md server/harnesses/README.md
git commit -m "Document the VS Code Copilot adapter"
```

---

## Task 10: Verify against the real machine

The suite proves the logic; this proves the adapter reads what is actually on disk. This is the checklist from `server/harnesses/README.md`.

- [ ] **Step 1: Syntax check**

Run: `node --check server/harnesses/vscode-copilot.mjs`
Expected: no output, exit 0.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 3: Scan the real machine**

Run:

```bash
node -e 'import("./server/scan.mjs").then(async m => {
  const t = (await m.scanThreads()).filter(x => x.harness === "vscode-copilot")
  const ids = new Set(t.map(x => x.id))
  console.log("threads:", t.length, "unique ids:", ids.size)
  console.log("titled:", t.filter(x => x.title !== "Untitled thread").length)
  console.log("with a model:", t.filter(x => x.model).length, "with a mode:", t.filter(x => x.effort).length)
  console.log("undefined fields:", t.flatMap(x => Object.entries(x).filter(([, v]) => v === undefined).map(([k]) => k)))
  console.dir(t[0], { depth: 4 })
})'
```

Expected on the machine this was designed against: **104 threads, 104 unique ids, 102 titled, 76 with a model, 91 with a mode, no undefined fields.** Counts differ per machine — what must hold anywhere is that `threads === unique ids`, that no field is `undefined`, and that the count is the number of session files on disk minus the empty ones.

- [ ] **Step 4: Confirm the sidebar labelling on real data**

Run:

```bash
node -e 'import("./server/scan.mjs").then(async m => {
  const t = (await m.scanThreads()).filter(x => x.harness === "copilot-cli")
  const bySource = {}
  for (const x of t) bySource[x.source] = (bySource[x.source] || 0) + 1
  console.log("copilot-cli threads:", t.length, bySource)
})'
```

Expected: the total is unchanged from before this branch (78 here), and a few threads now report `vscode-sidebar` rather than every one saying `cli`.

- [ ] **Step 5: Confirm the harness is detected through the API**

Run `npm run serve` in one shell, then in another:

```bash
curl -s localhost:5274/api/harnesses
```

Expected: three entries, including `{"id":"vscode-copilot","name":"VS Code Copilot","detected":true}`. Stop the server afterwards.

- [ ] **Step 6: Look at it**

Run `npm run dev` and open the colony.
Expected: VS Code Copilot astronauts appear on the plots of the right projects; a thread card shows a real title, a model and a chat mode; **Open** focuses the right VS Code window; **Archive** is greyed out.

- [ ] **Step 7: Commit anything the verification changed**

If steps 1–6 needed no fixes there is nothing to commit. If they did, commit the fix with a message naming what the real data disagreed with.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Roots, stable + Insiders, both platforms | 2 |
| `workspace.json` → project, incl. `.code-workspace` | 2 |
| `detect()` | 2 |
| `.jsonl` head-scan, patch records, line-0 fallback | 3 |
| `.json` 256 KB head + 8 KB tail, pretty-printed, brace-match | 4 |
| `readTail` in `fsutil.mjs` | 1 |
| Thread mapping, incl. `hasPendingEdits → unread` | 5 |
| mtime cache | 5 |
| Empty-session skip | 5 |
| Dedupe across formats | 5 |
| `openThread` / `newSession` / `setArchived` | 6 |
| No `appStartedAt` | 6 |
| Failure behaviour — skip a file, never the pass | 5 (`try`/`continue` in `scanThreads`) |
| Registration | 7 |
| `copilot-cli` sidebar labelling | 8 |
| Docs | 9 |
| Verification checklist | 10 |

**Type consistency:** `emptyMeta()` defines the field names used by `takeRequest`, `applyRecords`, `readJsonl`, `readJson` and `toThread` — `sawBase`, `complete`, `requests`, `prompt`, `customTitle`, `modelId`, `agentId`, `location`, `createdAt`, `lastMessageDate`, `pendingEdits`, `hasError`. `readWorkspace` returns `{ projectPath, project }`, which `scanThreads` destructures and passes to `toThread` in that order. `ref` is `{ id, file, projectPath }` in `toThread`, and `openThread` reads `ref.projectPath`.

**Every task ends green.** Tasks 2–4 test `pathFromFileUri`, `readWorkspace`, `readJsonl` and `readJson` directly rather than through `scanThreads`, which is why they are named exports. No task commits a red suite.
