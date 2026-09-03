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

import { exists, num, readHead } from '../lib/fsutil.mjs'

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
