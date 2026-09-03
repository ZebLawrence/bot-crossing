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
