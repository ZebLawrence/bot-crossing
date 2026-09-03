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
