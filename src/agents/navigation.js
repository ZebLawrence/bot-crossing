/**
 * Where the astronauts are allowed to walk.
 *
 * The colony is a scattering of convex obstacles on flat ground, which is the case a grid
 * handles well and cheaply: buildings and the ship are rasterised into a blocked bitmap
 * whenever the roster changes, and agents route across it with A*.
 *
 * There are two independent guarantees here, and both matter:
 *
 * 1. **Routing** — A* finds a way around a building rather than through it, including
 *    threading the gaps between a ring of them. Paths are string-pulled afterwards so an
 *    astronaut walks a straight line where it can rather than a visible staircase.
 * 2. **Collision** — `slide()` is applied to every step regardless of whether the agent is
 *    following a path. Routing can fail (a site that got walled in between polls, a path
 *    budget that has not caught up yet); walking through a wall must not be what happens
 *    when it does.
 *
 * Search scratch is reused across calls and invalidated by a generation stamp rather than
 * being cleared, so a path costs no allocation and no 50k-element memset.
 */

/** Cell size, in metres. Small enough to resolve the gaps between neighbouring buildings. */
const CELL = 0.5
/** Half-width of the navigable square. Comfortably contains the colony and the landing pad. */
const HALF = 56
/**
 * Give up rather than stall the frame if a search goes pathological.
 *
 * Measured rather than guessed, against a 45-plot / 90-thread colony: the most expensive
 * *honest* route on that map costs 19,247 expansions, and raising the cap past 30,000
 * changes nothing, so 19,247 is the real ceiling and this is comfortable headroom over it.
 * The old 6,000 was under it, and the symptom was not a slow path but no path at all —
 * `findPath` returning null for a route that plainly exists, which sends an astronaut
 * steering straight at its goal and leaning on whatever is in the way.
 *
 * Most routes are nowhere near this: the median is ~2,000. It is the handful threading a
 * cluttered zone that need the room.
 *
 * Exposed as an instance field so a colony can be measured, not so it can be tuned by feel.
 */
const MAX_EXPANSIONS = 30000

const SQRT2 = Math.SQRT2

export class Navigation {
  constructor() {
    this.cell = CELL
    this.half = HALF
    this.size = Math.ceil((HALF * 2) / CELL)
    const n = this.size * this.size

    this.blocked = new Uint8Array(n)
    this.gScore = new Float32Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Int32Array(n) // which search last touched this node
    this.closed = new Uint8Array(n)

    this.heap = new Int32Array(n)
    this.heapKey = new Float32Array(n)
    this.heapSize = 0

    this.generation = 0
    /** Bumped on every rebuild; agents use it to notice their path is stale. */
    this.version = 0

    /**
     * Which cells are connected to `origin`, and the version that answer was computed for.
     * Built lazily, because a rebuild that nobody asks a reachability question about should
     * not pay for one.
     */
    this.reach = new Uint8Array(n)
    this.reachVersion = -1
    this.origin = { x: 0, z: 0 }
    this._queue = new Int32Array(n)

    this.maxExpansions = MAX_EXPANSIONS
    /** Expansions the last search actually used — diagnostics, and how the cap was chosen. */
    this.lastExpansions = 0
  }

  /**
   * Where the crew comes from. Reachability is asked from here, because an astronaut that
   * cannot walk from the ship to its site can never be at its site, however open the ground
   * immediately around that site happens to be.
   */
  setOrigin(x, z) {
    if (this.origin.x === x && this.origin.z === z) return
    this.origin.x = x
    this.origin.z = z
    this.reachVersion = -1
  }

  // ── grid <-> world ──────────────────────────────────────────────────────────────────

  toCell(v) {
    return Math.floor((v + this.half) / this.cell)
  }

  toWorld(i) {
    return i * this.cell - this.half + this.cell * 0.5
  }

  inBounds(ix, iz) {
    return ix >= 0 && iz >= 0 && ix < this.size && iz < this.size
  }

  /** True where an astronaut may not stand. Outside the grid counts as blocked. */
  isBlocked(x, z) {
    const ix = this.toCell(x)
    const iz = this.toCell(z)
    if (!this.inBounds(ix, iz)) return true
    return this.blocked[iz * this.size + ix] === 1
  }

  // ── building the map ────────────────────────────────────────────────────────────────

  /**
   * Rasterise the obstacle list. Each is a circle `{ x, z, r }`, already inflated by the
   * caller for the astronaut's own width — doing it here would hide the one number that
   * decides whether the gaps between buildings stay walkable.
   */
  rebuild(obstacles) {
    this.blocked.fill(0)
    const { size, cell } = this

    for (const o of obstacles) {
      const r = o.r
      if (!(r > 0)) continue
      const minX = Math.max(0, this.toCell(o.x - r))
      const maxX = Math.min(size - 1, this.toCell(o.x + r))
      const minZ = Math.max(0, this.toCell(o.z - r))
      const maxZ = Math.min(size - 1, this.toCell(o.z + r))
      // Test against the cell's centre, so a cell is blocked when its middle is inside the
      // obstacle rather than when it merely touches it — that is what keeps thin corridors.
      const r2 = r * r
      for (let iz = minZ; iz <= maxZ; iz++) {
        const wz = this.toWorld(iz)
        const dz = wz - o.z
        const row = iz * size
        for (let ix = minX; ix <= maxX; ix++) {
          const dx = this.toWorld(ix) - o.x
          if (dx * dx + dz * dz <= r2) this.blocked[row + ix] = 1
        }
      }
    }
    this.version++
    void cell
  }

  // ── reachability ────────────────────────────────────────────────────────────────────

  /**
   * Flood the free cells connected to the origin.
   *
   * Four-connected on purpose, and that is not an approximation: A* here is 8-connected but
   * refuses to cut corners — a diagonal is only legal when both of its orthogonal neighbours
   * are clear — so anywhere a diagonal can go, the two orthogonals can go as well. The two
   * notions of "connected" are therefore the same one, and `findPath` succeeds exactly when
   * this says it should. There is a test that asserts precisely that.
   */
  _buildReach() {
    const { size, reach, blocked } = this
    reach.fill(0)
    // A building dropped on the door does not make the world unreachable; start from the
    // nearest cell somebody could actually stand on.
    const start = this.nearestFree(this.origin.x, this.origin.z)
    this.reachVersion = this.version
    if (!start) return

    const queue = this._queue
    let head = 0
    let tail = 0
    const startIdx = start.iz * size + start.ix
    reach[startIdx] = 1
    queue[tail++] = startIdx

    while (head < tail) {
      const cur = queue[head++]
      const cx = cur % size
      const cz = (cur - cx) / size
      // Orthogonals only — see the note above.
      for (let k = 0; k < 4; k++) {
        const nx = cx + NEIGHBOURS[k * 2]
        const nz = cz + NEIGHBOURS[k * 2 + 1]
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue
        const nIdx = nz * size + nx
        if (reach[nIdx] === 1 || blocked[nIdx] === 1) continue
        reach[nIdx] = 1
        queue[tail++] = nIdx
      }
    }
  }

  _reachMask() {
    if (this.reachVersion !== this.version) this._buildReach()
    return this.reach
  }

  /**
   * Can an astronaut standing at the origin ever get here? A cell can be perfectly free and
   * still be nowhere — a plot whose own buildings ring it closed is open ground with no way
   * in, and a site placed there is a trap the crew walks at for as long as the thread lives.
   */
  isReachable(x, z) {
    const ix = this.toCell(x)
    const iz = this.toCell(z)
    if (!this.inBounds(ix, iz)) return false
    return this._reachMask()[iz * this.size + ix] === 1
  }

  /**
   * The nearest cell that is both free *and* connected to the origin. This is what a stand
   * position wants: `nearestFree` will happily hand back the middle of a sealed pocket,
   * which is exactly the trap it was meant to avoid.
   */
  nearestReachable(x, z, maxRings = 48) {
    const reach = this._reachMask()
    const cx = this.toCell(x)
    const cz = this.toCell(z)
    if (this.inBounds(cx, cz) && reach[cz * this.size + cx] === 1) return { ix: cx, iz: cz }

    for (let ring = 1; ring <= maxRings; ring++) {
      let best = null
      let bestD = Infinity
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
          const ix = cx + dx
          const iz = cz + dz
          if (!this.inBounds(ix, iz)) continue
          if (reach[iz * this.size + ix] !== 1) continue
          const d = dx * dx + dz * dz
          if (d < bestD) {
            bestD = d
            best = { ix, iz }
          }
        }
      }
      if (best) return best
    }
    return null
  }

  /**
   * The nearest walkable cell to a point, searched in expanding rings. Used both for a goal
   * that has been built over and for an agent that a new building landed on top of.
   */
  nearestFree(x, z, maxRings = 24) {
    const cx = this.toCell(x)
    const cz = this.toCell(z)
    if (this.inBounds(cx, cz) && this.blocked[cz * this.size + cx] === 0) return { ix: cx, iz: cz }

    for (let ring = 1; ring <= maxRings; ring++) {
      let best = null
      let bestD = Infinity
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the shell of the ring; the inside was covered by earlier iterations.
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
          const ix = cx + dx
          const iz = cz + dz
          if (!this.inBounds(ix, iz)) continue
          if (this.blocked[iz * this.size + ix] === 1) continue
          const d = dx * dx + dz * dz
          if (d < bestD) {
            bestD = d
            best = { ix, iz }
          }
        }
      }
      if (best) return best
    }
    return null
  }

  // ── line of sight ───────────────────────────────────────────────────────────────────

  /** Sampled along the segment at half-cell steps — dense enough that nothing slips through. */
  lineOfSight(x0, z0, x1, z1) {
    const dx = x1 - x0
    const dz = z1 - z0
    const dist = Math.hypot(dx, dz)
    const steps = Math.ceil(dist / (this.cell * 0.5))
    if (steps === 0) return !this.isBlocked(x0, z0)
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      if (this.isBlocked(x0 + dx * t, z0 + dz * t)) return false
    }
    return true
  }

  // ── A* ──────────────────────────────────────────────────────────────────────────────

  /**
   * A route from one world point to another, as world-space waypoints, or `null` if there
   * is no way through. The returned path excludes the start and ends exactly on the goal.
   */
  findPath(sx, sz, tx, tz) {
    const start = this.nearestFree(sx, sz)
    const goal = this.nearestFree(tx, tz)
    if (!start || !goal) return null

    const size = this.size
    const startIdx = start.iz * size + start.ix
    const goalIdx = goal.iz * size + goal.ix

    // A goal that has been built over — a stand position a new building landed on, or a
    // point simply inside a wall — resolves to the nearest walkable spot. Routing to the
    // requested point instead would end every such path with a leg through the obstacle.
    const reachableX = this.isBlocked(tx, tz) ? this.toWorld(goal.ix) : tx
    const reachableZ = this.isBlocked(tx, tz) ? this.toWorld(goal.iz) : tz

    // Straight shot: by far the common case in an open colony, and it skips the search.
    if (this.lineOfSight(sx, sz, reachableX, reachableZ)) return [{ x: reachableX, z: reachableZ }]

    const gen = ++this.generation
    const { gScore, parent, stamp, closed } = this
    this.heapSize = 0

    gScore[startIdx] = 0
    parent[startIdx] = -1
    stamp[startIdx] = gen
    closed[startIdx] = 0
    this._push(startIdx, this._heuristic(start.ix, start.iz, goal.ix, goal.iz))

    let expansions = 0
    let found = false

    while (this.heapSize > 0) {
      const current = this._pop()
      if (closed[current] === 1) continue
      closed[current] = 1
      if (current === goalIdx) {
        found = true
        break
      }
      if (++expansions > this.maxExpansions) break

      const cx = current % size
      const cz = (current - cx) / size
      const g = gScore[current]

      for (let k = 0; k < 8; k++) {
        const nx = cx + NEIGHBOURS[k * 2]
        const nz = cz + NEIGHBOURS[k * 2 + 1]
        if (!this.inBounds(nx, nz)) continue
        const nIdx = nz * size + nx
        if (this.blocked[nIdx] === 1) continue
        if (stamp[nIdx] === gen && closed[nIdx] === 1) continue

        // No corner cutting: a diagonal is only legal when both of its orthogonal
        // neighbours are clear, or agents will clip the corners of buildings.
        const diagonal = k >= 4
        if (diagonal) {
          if (this.blocked[cz * size + nx] === 1 || this.blocked[nz * size + cx] === 1) continue
        }

        const tentative = g + (diagonal ? SQRT2 : 1)
        if (stamp[nIdx] === gen && tentative >= gScore[nIdx]) continue

        stamp[nIdx] = gen
        closed[nIdx] = 0
        gScore[nIdx] = tentative
        parent[nIdx] = current
        this._push(nIdx, tentative + this._heuristic(nx, nz, goal.ix, goal.iz))
      }
    }

    this.lastExpansions = expansions
    if (!found) return null

    // Walk the parents back, then smooth.
    const cells = []
    let node = goalIdx
    while (node !== -1) {
      cells.push(node)
      node = parent[node]
    }
    cells.reverse()
    return this._smooth(cells, sx, sz, reachableX, reachableZ)
  }

  /** Octile distance — admissible for 8-connected movement, and never overestimates. */
  _heuristic(ax, az, bx, bz) {
    const dx = Math.abs(ax - bx)
    const dz = Math.abs(az - bz)
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz)
  }

  /**
   * String-pulling: keep the furthest waypoint still visible from the last kept one. Turns
   * a staircase of grid cells into the handful of corners an astronaut actually needs.
   */
  _smooth(cells, sx, sz, tx, tz) {
    const size = this.size
    const pts = cells.map((idx) => {
      const ix = idx % size
      const iz = (idx - ix) / size
      return { x: this.toWorld(ix), z: this.toWorld(iz) }
    })
    // The true endpoints, not their cell centres.
    pts[pts.length - 1] = { x: tx, z: tz }

    const out = []
    let fromX = sx
    let fromZ = sz
    let i = 0
    while (i < pts.length) {
      // Keep the furthest waypoint still visible from here; `i` itself is the floor, and it
      // is always reachable because consecutive cells in an A* result are adjacent.
      let furthest = i
      for (let j = pts.length - 1; j > i; j--) {
        if (this.lineOfSight(fromX, fromZ, pts[j].x, pts[j].z)) {
          furthest = j
          break
        }
      }
      const p = pts[furthest]
      out.push(p)
      fromX = p.x
      fromZ = p.z
      if (furthest === pts.length - 1) break
      i = furthest + 1
    }
    return out.length ? out : [{ x: tx, z: tz }]
  }

  // ── movement ────────────────────────────────────────────────────────────────────────

  /**
   * Apply a step with collision. Blocked head-on, the move is retried on each axis alone so
   * the agent slides along the obstacle instead of stopping dead against it.
   *
   * This runs on every step whether or not a path is being followed, which is what makes
   * "never walks through a building" a property of the movement rather than a property of
   * the pathfinder having succeeded.
   */
  slide(pos, dx, dz) {
    // An agent a building was dropped on top of has no legal move at all; walk it out.
    if (this.isBlocked(pos.x, pos.z)) {
      const free = this.nearestFree(pos.x, pos.z)
      if (free) {
        const fx = this.toWorld(free.ix)
        const fz = this.toWorld(free.iz)
        const len = Math.hypot(fx - pos.x, fz - pos.z) || 1
        const step = Math.min(len, Math.hypot(dx, dz) + 0.04)
        pos.x += ((fx - pos.x) / len) * step
        pos.z += ((fz - pos.z) / len) * step
      }
      return false
    }

    const nx = pos.x + dx
    const nz = pos.z + dz
    if (!this.isBlocked(nx, nz)) {
      pos.x = nx
      pos.z = nz
      return true
    }
    if (dx !== 0 && !this.isBlocked(nx, pos.z)) {
      pos.x = nx
      return true
    }
    if (dz !== 0 && !this.isBlocked(pos.x, nz)) {
      pos.z = nz
      return true
    }
    return false
  }

  // ── heap ────────────────────────────────────────────────────────────────────────────

  _push(node, key) {
    let i = this.heapSize++
    this.heap[i] = node
    this.heapKey[i] = key
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.heapKey[p] <= this.heapKey[i]) break
      this._swap(i, p)
      i = p
    }
  }

  _pop() {
    const top = this.heap[0]
    const last = --this.heapSize
    this.heap[0] = this.heap[last]
    this.heapKey[0] = this.heapKey[last]
    let i = 0
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let small = i
      if (l < this.heapSize && this.heapKey[l] < this.heapKey[small]) small = l
      if (r < this.heapSize && this.heapKey[r] < this.heapKey[small]) small = r
      if (small === i) break
      this._swap(i, small)
      i = small
    }
    return top
  }

  _swap(a, b) {
    const n = this.heap[a]
    this.heap[a] = this.heap[b]
    this.heap[b] = n
    const k = this.heapKey[a]
    this.heapKey[a] = this.heapKey[b]
    this.heapKey[b] = k
  }
}

// Orthogonals first, then diagonals — the loop relies on index >= 4 meaning diagonal.
const NEIGHBOURS = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1])
