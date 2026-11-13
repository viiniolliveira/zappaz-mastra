export class ExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution exceeded ${timeoutMs}ms`)
    this.name = 'ExecutionTimeoutError'
  }
}

export interface Execution {
  signal: AbortSignal
  pending: Set<Promise<unknown>>
  deliveryStarted: boolean
  toolReplyAttempted?: boolean
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
    if (signal.aborted) onAbort()
  })
}

export function track<T>(execution: Execution, promise: Promise<T>): Promise<T> {
  execution.pending.add(promise)
  void promise.then(
    () => execution.pending.delete(promise),
    () => execution.pending.delete(promise),
  )
  return promise
}

export function positiveInteger(name: string, value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be a positive integer no greater than ${max}`)
  }
  return value
}

export class MessageDeduplicator {
  private readonly active = new Set<string>()
  private readonly completed = new Map<string, number>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  has(key: string): boolean {
    if (this.active.has(key)) return true
    const expires = this.completed.get(key)
    if (expires === undefined) return false
    if (expires > Date.now()) return true
    this.completed.delete(key)
    return false
  }

  reserve(keys: string[]): boolean {
    for (const [key, expires] of this.completed) {
      if (expires > Date.now()) break
      this.completed.delete(key)
    }
    if (this.active.size + keys.length > this.maxEntries) return false
    while (this.active.size + this.completed.size + keys.length > this.maxEntries) {
      const oldest = this.completed.keys().next().value
      if (oldest === undefined) break
      this.completed.delete(oldest)
    }
    for (const key of keys) this.active.add(key)
    return true
  }

  complete(keys: string[]): void {
    const expires = Date.now() + this.ttlMs
    for (const key of keys) {
      this.active.delete(key)
      this.completed.set(key, expires)
    }
  }

  release(keys: string[]): void {
    for (const key of keys) this.active.delete(key)
  }
}
