import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import vscode, { pathFromFileUri, readWorkspace, readJsonl } from '../server/harnesses/vscode-copilot.mjs'

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
