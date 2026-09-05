import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Navigation } from '../src/agents/navigation.js'

/**
 * A ring of overlapping discs around a centre — the shape a plot makes of itself when its
 * building slots are large enough that neighbouring footprints touch. `gap` is how far apart
 * the disc *edges* are: negative overlaps, and anything under the cell size seals just as
 * effectively because no cell centre lands in the opening.
 */
function ring({ x = 0, z = 0, radius = 4.4, count = 6, r = 2.5 } = {}) {
  const out = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    out.push({ x: x + Math.cos(a) * radius, z: z + Math.sin(a) * radius, r })
  }
  return out
}

test('a point outside any obstacle is reachable from the origin', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  nav.rebuild([{ x: 10, z: 0, r: 2 }])
  assert.equal(nav.isReachable(20, 0), true)
  assert.equal(nav.isReachable(0, 0), true)
})

test('the middle of a sealed ring is free but NOT reachable', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  // Ring centred well away from the origin, with the discs overlapping.
  nav.rebuild(ring({ x: 20, z: 0, radius: 4.4, count: 6, r: 2.5 }))
  // The middle of the ring is open ground...
  assert.equal(nav.isBlocked(20, 0), false, 'the centre should be free ground')
  // ...but there is no way into it.
  assert.equal(nav.isReachable(20, 0), false, 'the centre should be walled in')
})

test('a ring with a real opening is reachable through it', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  // Five of six discs: the missing one leaves a gap wider than the crew.
  nav.rebuild(ring({ x: 20, z: 0, radius: 4.4, count: 6, r: 2.5 }).slice(0, 5))
  assert.equal(nav.isReachable(20, 0), true)
})

test('reachability agrees with findPath — the property that matters', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  nav.rebuild([...ring({ x: 20, z: 0 }), ...ring({ x: -18, z: 12 }), { x: 6, z: -6, r: 3 }])
  // A* is 8-connected but refuses to cut corners, so a diagonal is only legal when both of
  // its orthogonals are clear — which makes its connectivity exactly 4-connected. If these
  // two ever disagree, one of them is wrong.
  for (let x = -30; x <= 30; x += 3.5) {
    for (let z = -20; z <= 20; z += 3.5) {
      if (nav.isBlocked(x, z)) continue
      const reachable = nav.isReachable(x, z)
      const path = nav.findPath(0, 0, x, z)
      assert.equal(reachable, path !== null, `disagreement at ${x},${z}: reachable=${reachable} path=${!!path}`)
    }
  }
})

test('nearestReachable escapes a sealed pocket instead of settling inside it', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  nav.rebuild(ring({ x: 20, z: 0, radius: 4.4, count: 6, r: 2.5 }))

  // What the old code did: nearest *free* cell, which is the pocket itself.
  const free = nav.nearestFree(20, 0)
  assert.equal(nav.isReachable(nav.toWorld(free.ix), nav.toWorld(free.iz)), false)

  // What it should do: the nearest cell somebody can actually walk to.
  const got = nav.nearestReachable(20, 0)
  assert.notEqual(got, null, 'should find somewhere reachable')
  const wx = nav.toWorld(got.ix)
  const wz = nav.toWorld(got.iz)
  assert.equal(nav.isReachable(wx, wz), true)
  assert.notEqual(nav.findPath(0, 0, wx, wz), null, 'and a route to it must exist')
})

test('nearestReachable returns the point itself when it is already fine', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  nav.rebuild([{ x: 10, z: 0, r: 2 }])
  const got = nav.nearestReachable(20, 0)
  assert.equal(nav.toCell(20), got.ix)
  assert.equal(nav.toCell(0), got.iz)
})

test('the reachability mask is rebuilt when the obstacles change', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  nav.rebuild([])
  assert.equal(nav.isReachable(20, 0), true)
  nav.rebuild(ring({ x: 20, z: 0 }))
  assert.equal(nav.isReachable(20, 0), false, 'sealing it must invalidate the old mask')
  nav.rebuild([])
  assert.equal(nav.isReachable(20, 0), true, 'and opening it again must too')
})

test('an origin that is itself blocked still yields a usable mask', () => {
  const nav = new Navigation()
  nav.setOrigin(0, 0)
  // A building dropped straight on the ship door.
  nav.rebuild([{ x: 0, z: 0, r: 2 }])
  assert.equal(nav.isBlocked(0, 0), true)
  assert.equal(nav.isReachable(20, 0), true, 'the open world beyond it is still reachable')
})
