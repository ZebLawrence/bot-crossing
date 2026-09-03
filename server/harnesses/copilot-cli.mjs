/**
 * GitHub Copilot CLI — https://github.com/github/copilot-cli
 *
 * Sessions live in `~/.copilot/session-state/<uuid>/`, in two layers:
 *
 *   - `workspace.yaml` — present for EVERY session, old and new. Flat `key: value` pairs:
 *     `id`, `cwd`, `git_root`, `repository`, `branch`, `created_at`, `updated_at`. This is
 *     the base record, and reading it is what makes older sessions visible at all.
 *   - `events.jsonl` — only on sessions the current CLI has written. An append-only log,
 *     one JSON object per line, `{ id, parentId, timestamp, type, data }`. `session.start`
 *     carries the same context, and `user.message` / `assistant.message` /
 *     `tool.execution_*` are what give a thread its title, its unread state and its size.
 *
 * Measured twice: 22 of 22 sessions had `workspace.yaml` and 7 had `events.jsonl` on a Mac,
 * 78 of 78 and 37 on a Windows box. Treating the event log as the source would silently drop
 * half to two thirds of the colony.
 *
 * Read-only. Copilot CLI has no archive concept, so `setArchived` declines and the colony
 * keeps that state on its own side (see server/harnesses/README.md).
 */
import os from 'node:os'
import path from 'node:path'
import { readFile, stat, writeFile, chmod } from 'node:fs/promises'

import { listDirs, exists } from '../lib/fsutil.mjs'

const DEFAULT_ROOT = path.join(os.homedir(), '.copilot')
const stateDir = (root) => path.join(root || DEFAULT_ROOT, 'session-state')

/** Treat a session as live if it moved this recently. The CLI writes an event per turn and
 *  per tool call, so anything inside a minute is mid-work rather than finished. */
const RUNNING_WINDOW_MS = 60_000

const ms = (v) => {
  const t = Date.parse(v || '')
  return Number.isFinite(t) ? t : 0
}

/** Parsed sessions, keyed by dir, invalidated on mtime — the scan runs on a poll and these
 *  logs grow to megabytes. Same reason claude-code.mjs caches `transcriptMeta`. */
const cache = new Map()

/** Flat `key: value` YAML — no nesting, no lists, no anchors. A dependency would be
 *  disproportionate for seven scalar fields, so this reads exactly that shape and no more. */
function parseFlatYaml(text) {
  const out = {}
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

/** The always-present half. Returns null when there is no workspace.yaml to read. */
async function readWorkspace(dir) {
  let y
  try {
    y = parseFlatYaml(await readFile(path.join(dir, 'workspace.yaml'), 'utf8'))
  } catch {
    return null
  }
  return {
    context: { cwd: y.cwd || '', gitRoot: y.git_root || '', branch: y.branch || '' },
    repository: y.repository || '',
    createdAt: ms(y.created_at),
    lastActivityAt: ms(y.updated_at),
  }
}

async function readEvents(dir) {
  const file = path.join(dir, 'events.jsonl')
  const st = await stat(file)          // throws when there is no event log; caller treats
  const hit = cache.get(dir)           // that as "yaml-only session", not as an error
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.value

  const text = await readFile(file, 'utf8')
  const v = {
    context: {},
    createdAt: 0,
    lastActivityAt: 0,
    firstPrompt: '',
    lastUserAt: 0,
    lastAssistantAt: 0,
    hasError: false,
    sizeBytes: st.size,
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue // a session being written right now: skip the partial record, keep the rest
    }
    const at = ms(e.timestamp)
    if (at > v.lastActivityAt) v.lastActivityAt = at
    const type = e.type || ''
    if (type === 'session.start') {
      v.context = e.data?.context || {}
      v.createdAt = ms(e.data?.startTime) || at
    } else if (type === 'user.message') {
      if (!v.firstPrompt) v.firstPrompt = String(e.data?.content || '').trim()
      v.lastUserAt = at
    } else if (type === 'assistant.message') {
      v.lastAssistantAt = at
    } else if (type.includes('error')) {
      v.hasError = true
    }
  }
  if (!v.createdAt) v.createdAt = v.lastActivityAt
  cache.set(dir, { mtimeMs: st.mtimeMs, value: v })
  return v
}

/** The event log wins where it has an opinion; workspace.yaml fills everything else. */
function mergeSession(base, ev) {
  if (!ev) return { ...EMPTY, ...base }
  if (!base) return ev
  return {
    ...ev,
    context: { ...base.context, ...Object.fromEntries(
      Object.entries(ev.context || {}).filter(([, v]) => v)) },
    repository: base.repository,
    createdAt: ev.createdAt || base.createdAt,
    lastActivityAt: Math.max(ev.lastActivityAt || 0, base.lastActivityAt || 0),
  }
}

const EMPTY = {
  context: {}, createdAt: 0, lastActivityAt: 0, firstPrompt: '',
  lastUserAt: 0, lastAssistantAt: 0, hasError: false, sizeBytes: 0,
}

function toThread(id, s, now) {
  const cwd = s.context.cwd || ''
  const projectPath = s.context.gitRoot || cwd
  const title = s.firstPrompt ? s.firstPrompt.split('\n')[0].slice(0, 120) : 'Untitled thread'
  return {
    id: `copilot-cli:${id}`,
    harness: 'copilot-cli',
    harnessName: 'Copilot CLI',
    title,
    preview: s.firstPrompt.slice(0, 240),
    project: projectPath ? path.basename(projectPath) : '',
    projectPath,
    cwd,
    worktree: '',
    gitBranch: s.context.branch || '',
    model: '',
    effort: '',
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    lastFocusedAt: 0,
    running: now - s.lastActivityAt < RUNNING_WINDOW_MS,
    // It answered after your last message and nothing has been typed since: it is waiting on you.
    unread: s.lastAssistantAt > s.lastUserAt,
    hasError: s.hasError,
    archived: false,
    starred: false,
    sizeBytes: s.sizeBytes,
    source: 'cli',
    canOpen: true,
    canArchive: false, // Copilot CLI keeps no archive state of its own
    ref: { id, cwd },
  }
}

async function scanThreads({ root, now = Date.now() } = {}) {
  const base = stateDir(root)
  if (!(await exists(base))) return []
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
    threads.push(toThread(id, mergeSession(base, ev), now))
  }
  return threads
}

/**
 * There is no `copilot://` URL scheme, so reopening means running the CLI. We write a tiny
 * launcher into the temp dir and hand it to the opener, which is what makes a terminal come
 * up in the right directory on the right session.
 *
 * The two platforms differ in five ways at once — file extension, how a word is quoted, the
 * script body, whether the executable bit means anything, and what the opener wants handed
 * back — so they are one table rather than five branches. The Windows entry returns a bare
 * path, not a `file://` URL: `start` runs a `.cmd` handed to it as a path, but hands a
 * `file://` to the browser instead.
 *
 * Quoting matters here because paths with spaces are the common case on Windows rather than
 * the exception, and the two shells do not agree on what a quoted string means.
 */
const LAUNCHERS = {
  win32: {
    ext: '.cmd',
    /**
     * cmd.exe has no escape character inside double quotes, and Windows forbids `"` in a
     * path, so wrapping *is* quoting. `JSON.stringify` would be actively wrong: the `\\` it
     * emits is not an escaped backslash to cmd, it is two literal separators.
     */
    quote: (s) => `"${s}"`,
    body: (cd, run) => `@echo off\r\ncd /d ${cd} || exit /b 1\r\n${run}\r\n`,
    mode: null, // no executable bit to set; chmod on Windows only toggles read-only
    url: (file) => file,
  },
  posix: {
    ext: '.command',
    /** A bash double-quoted string, where `\\` really is an escaped backslash. */
    quote: (s) => JSON.stringify(s),
    body: (cd, run) => `#!/bin/bash\ncd ${cd} || exit 1\nexec ${run}\n`,
    mode: 0o755,
    url: (file) => `file://${file}`,
  },
}

const launcherFor = (platform = process.platform) =>
  platform === 'win32' ? LAUNCHERS.win32 : LAUNCHERS.posix

/** Writes the launcher and returns what the opener should be given. */
function writeLauncher(name, dir, args) {
  const l = launcherFor()
  const file = path.join(os.tmpdir(), name + l.ext)
  const body = l.body(l.quote(dir), ['copilot', ...args.map(l.quote)].join(' '))
  // Fire-and-forget: the opener only needs the path, and a failure here surfaces as the
  // window not appearing rather than a broken colony.
  writeFile(file, body)
    .then(() => (l.mode === null ? null : chmod(file, l.mode)))
    .catch(() => {})
  return { ok: true, url: l.url(file) }
}

function openThread(ref) {
  const id = ref?.id
  if (!id) return { ok: false, error: 'No session id on this thread' }
  const cwd = ref.cwd || os.homedir()
  return writeLauncher(`bot-crossing-copilot-${id}`, cwd, [`--resume=${id}`])
}

function newSession(dir) {
  return writeLauncher('bot-crossing-copilot-new', dir, [])
}

export default {
  id: 'copilot-cli',
  name: 'Copilot CLI',
  detect: async ({ root } = {}) => exists(stateDir(root)),
  scanThreads,
  openThread,
  newSession,
  setArchived: async () => ({
    ok: false,
    error: 'Copilot CLI has no archived state of its own',
  }),
}
