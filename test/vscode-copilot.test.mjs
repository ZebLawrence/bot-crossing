import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import vscode, { pathFromFileUri, readWorkspace, readJsonl, readJson } from '../server/harnesses/vscode-copilot.mjs'

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
