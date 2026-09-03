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
