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
import { readFile, stat } from 'node:fs/promises'

import { exists, listDirs, listFiles, num, readHead, readTail } from '../lib/fsutil.mjs'

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

/** How much of a session file a scan is willing to read. 256 KB is the knee of the curve
 *  for both formats: on 149 real files it recovers 37 of 42 `.jsonl` prompts against 34 at
 *  64 KB and 39 at 1 MB, for a 4.7 MB cold read against 14.9 MB. */
const HEAD_BYTES = 256 * 1024

/** A line 0 longer than the head is rare — 4 of 76 files — but reaches 1 MB when it happens. */
const LINE0_CAP = 4 * 1024 * 1024

/** Everything either reader can learn, so the mapping to a Thread is written once. */
export const emptyMeta = () => ({
  sawBase: false, // did we recover the document itself, or only patches?
  complete: false, // did the read cover the whole file? decides the empty-session skip
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

export default {
  id: 'vscode-copilot',
  name: 'VS Code Copilot',
  detect: async ({ roots } = {}) => {
    for (const root of roots || defaultRoots()) if (await exists(storageDir(root))) return true
    return false
  },
  scanThreads,
  openThread,
  newSession,
  setArchived: async () => ({
    ok: false,
    error: 'VS Code keeps no archived state for chat sessions',
  }),
  // `appStartedAt` is deliberately absent: it exists to tell a picked-up archive flag from
  // one still waiting on disk, and this adapter never writes a flag.
}
