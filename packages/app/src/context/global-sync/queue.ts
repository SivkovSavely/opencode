type QueueInput = {
  paused: () => boolean
  bootstrap: () => Promise<void>
  bootstrapInstance: (directory: string) => Promise<void> | void
  key?: (directory: string) => string
}

type PushOptions = { priority?: boolean }

export function createRefreshQueue(input: QueueInput) {
  const queued = new Map<string, { directory: string; priority: boolean }>()
  let root = false
  let running = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const key = input.key ?? ((directory: string) => directory)

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  const take = (count: number) => {
    if (queued.size === 0) return [] as string[]
    const items = [...queued.entries()].sort((a, b) => Number(b[1].priority) - Number(a[1].priority)).slice(0, count)
    for (const [id] of items) {
      queued.delete(id)
    }
    return items.map(([, item]) => item.directory)
  }

  const schedule = () => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, 0)
  }

  const push = (directory: string, options?: PushOptions) => {
    if (disposed || !directory) return
    const id = key(directory)
    const existing = queued.get(id)
    if (existing) {
      if (options?.priority && !existing.priority) queued.set(id, { ...existing, priority: true })
      return
    }
    queued.set(id, { directory, priority: options?.priority === true })
    if (input.paused()) return
    schedule()
  }

  const refresh = () => {
    if (disposed) return
    root = true
    if (input.paused()) return
    schedule()
  }

  const resume = () => {
    if (disposed || input.paused()) return
    if (root || queued.size > 0) schedule()
  }

  async function drain() {
    if (running || disposed) return
    running = true
    try {
      while (true) {
        if (disposed || input.paused()) return
        if (root) {
          root = false
          await input.bootstrap()
          await tick()
          continue
        }
        const dirs = take(2)
        if (dirs.length === 0) return
        await Promise.all(dirs.map((dir) => Promise.resolve(input.bootstrapInstance(dir))))
        await tick()
      }
    } finally {
      running = false
      // oxlint-disable-next-line no-unsafe-finally -- intentional: early return skips rescheduling when paused or disposed
      if (disposed || input.paused()) return
      if (root || queued.size) schedule()
    }
  }

  return {
    push,
    refresh,
    resume,
    clear(directory: string) {
      queued.delete(key(directory))
    },
    dispose() {
      disposed = true
      root = false
      queued.clear()
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
