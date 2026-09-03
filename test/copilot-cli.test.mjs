import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import copilot from '../server/harnesses/copilot-cli.mjs'

/** Build a throwaway ~/.copilot with the given sessions. */
async function fakeHome(sessions) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-test-'))
  for (const [id, lines] of Object.entries(sessions)) {
    const dir = path.join(root, 'session-state', id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'events.jsonl'),
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  }
  return root
}

const start = (cwd, gitRoot, branch, ts) => ({
  type: 'session.start', timestamp: ts,
  data: { sessionId: 'x', startTime: ts, copilotVersion: '1.0.81',
          context: { cwd, gitRoot, branch, headCommit: 'abc123' } },
})
const userMsg = (content, ts) => ({ type: 'user.message', timestamp: ts, data: { content } })

/** The launcher write is fire-and-forget by design, so the test waits for it rather than racing. */
async function waitFor(file, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      await access(file)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  throw new Error(`launcher never appeared at ${file}`)
}

test('maps a session to a Thread with repo, path and branch from session.start', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000001': [
      start('/Users/z/Projects/flight-app', '/Users/z/Projects/flight-app', 'main',
            '2026-09-01T10:00:00.000Z'),
      userMsg('Fix the login redirect', '2026-09-01T10:00:05.000Z'),
    ],
  })

  const [t] = await copilot.scanThreads({ root })

  assert.equal(t.project, 'flight-app')
  assert.equal(t.projectPath, '/Users/z/Projects/flight-app')
  assert.equal(t.cwd, '/Users/z/Projects/flight-app')
  assert.equal(t.gitBranch, 'main')
})

test('uses the first user message as title and preview', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000002': [
      start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z'),
      userMsg('Fix the login redirect', '2026-09-01T10:00:05.000Z'),
      userMsg('now also the logout', '2026-09-01T10:05:00.000Z'),
    ],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.title, 'Fix the login redirect')
  assert.equal(t.preview, 'Fix the login redirect')
})

test('falls back to Untitled thread when the session has no user message', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000003': [start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z')],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.title, 'Untitled thread')
  assert.equal(t.preview, '')
})

test('namespaces the id so it cannot collide with another harness', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000004': [start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z')],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.id, 'copilot-cli:aaaaaaaa-0000-0000-0000-000000000004')
  assert.equal(t.harness, 'copilot-cli')
})

test('takes createdAt from session start and lastActivityAt from the newest event', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000005': [
      start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z'),
      userMsg('hi', '2026-09-01T10:00:05.000Z'),
      { type: 'assistant.message', timestamp: '2026-09-01T12:30:00.000Z', data: { content: 'ok' } },
    ],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.createdAt, Date.parse('2026-09-01T10:00:00.000Z'))
  assert.equal(t.lastActivityAt, Date.parse('2026-09-01T12:30:00.000Z'))
})

test('skips a malformed line instead of losing the session', async () => {
  const root = await fakeHome({
    'aaaaaaaa-0000-0000-0000-000000000006': [
      start('/r', '/r', 'main', '2026-09-01T10:00:00.000Z'),
      '{"type":"user.message","data":{"content":"half a rec',   // being written right now
      userMsg('survived', '2026-09-01T10:00:09.000Z'),
    ],
  })
  const [t] = await copilot.scanThreads({ root })
  assert.equal(t.title, 'survived')
})

test('openThread resumes that session by id', async () => {
  const r = copilot.openThread({ id: 'abc-123', cwd: '/r' })
  assert.equal(r.ok, true)
  assert.match(String(r.url), /abc-123/)
})

test('detect is false when the machine has no copilot directory', async () => {
  assert.equal(await copilot.detect({ root: path.join(tmpdir(), 'definitely-not-here-xyz') }), false)
})

/** Older sessions carry only workspace.yaml; newer ones add events.jsonl alongside it. */
async function fakeYamlHome(id, yaml) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-yaml-'))
  const dir = path.join(root, 'session-state', id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'workspace.yaml'), yaml)
  return root
}

test('finds a session that has only workspace.yaml and no event log', async () => {
  const root = await fakeYamlHome('bbbbbbbb-0000-0000-0000-000000000001', [
    'id: bbbbbbbb-0000-0000-0000-000000000001',
    'cwd: /Users/z/Projects/remotion-showcase',
    'created_at: 2026-03-22T16:02:48.457Z',
    'updated_at: 2026-03-22T17:00:00.000Z',
    'git_root: /Users/z/Projects/remotion-showcase',
    'repository: ZebLawrence/remotion-tests',
    'branch: main',
  ].join('\n') + '\n')

  const [t] = await copilot.scanThreads({ root })

  assert.equal(t.project, 'remotion-showcase')
  assert.equal(t.gitBranch, 'main')
  assert.equal(t.createdAt, Date.parse('2026-03-22T16:02:48.457Z'))
  assert.equal(t.lastActivityAt, Date.parse('2026-03-22T17:00:00.000Z'))
  assert.equal(t.title, 'Untitled thread')
})

/**
 * The launcher is the one part of this adapter that is platform-bound, so it is asserted
 * against whichever platform the suite is running on rather than skipped. The quoting is
 * the load-bearing detail: `JSON.stringify` is right for bash and wrong for cmd, where the
 * `\\` it emits is two literal separators rather than an escaped one.
 */
const SPACED = process.platform === 'win32' ? 'C:\\Program Files\\App' : '/Users/z/Some App'

test('openThread writes a launcher this platform can actually run', async () => {
  const id = 'cccccccc-0000-0000-0000-000000000001'
  const r = copilot.openThread({ id, cwd: SPACED })
  assert.equal(r.ok, true)

  const file = process.platform === 'win32' ? r.url : r.url.replace(/^file:\/\//, '')
  await waitFor(file)
  const body = await readFile(file, 'utf8')

  assert.match(body, new RegExp(`--resume=${id}`))
  if (process.platform === 'win32') {
    assert.equal(path.extname(file), '.cmd')
    assert.equal(r.url, file, 'Windows hands the opener a bare path, not a file:// URL')
    assert.match(body, /^@echo off/)
    assert.ok(body.includes(`cd /d "${SPACED}"`), `cmd path must not be backslash-escaped: ${body}`)
  } else {
    assert.equal(path.extname(file), '.command')
    assert.match(r.url, /^file:\/\//)
    assert.match(body, /^#!\/bin\/bash/)
    assert.ok(body.includes(`cd ${JSON.stringify(SPACED)}`), body)
  }
})

test('newSession launches the CLI with no session to resume', async () => {
  const r = copilot.newSession(SPACED)
  assert.equal(r.ok, true)

  const file = process.platform === 'win32' ? r.url : r.url.replace(/^file:\/\//, '')
  await waitFor(file)
  const body = await readFile(file, 'utf8')

  assert.doesNotMatch(body, /--resume/)
  assert.match(body, /copilot/)
})

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
