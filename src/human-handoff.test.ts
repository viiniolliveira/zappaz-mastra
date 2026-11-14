import { describe, expect, spyOn, test } from 'bun:test'
import { ZappazMastra, type ZappazMastraOptions } from './index.js'
import { ConversationPausedError } from './human-handoff.js'

type Message = ReturnType<typeof message>
function message(id: string, conversationId = 'a', fromMe = false, type: 'text' | 'image' = 'text') {
  return { id, messageId: id, chatId: 'chat', conversationId, remoteJid: null, lid: null, fromMe, isGroup: false, sender: { id: 'sender' }, timestamp: '2026-01-01T00:00:00Z', type, text: id }
}
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve() }

function setup(options: {
  agentId?: ZappazMastraOptions['agentId']
  humanHandoff?: ZappazMastraOptions['humanHandoff']
  allowedConversationIds?: string[]
  maxPendingMessages?: number
  debounceMs?: number
  timeoutMs?: number
  memory?: boolean
  generate?: (signal?: AbortSignal) => Promise<{ text: string }>
  failSave?: () => boolean
  onError?: ZappazMastraOptions['onError']
} = {}) {
  let event!: (event: { event: string; session: { id: string }; payload: unknown }) => Promise<void>
  const handlers: Record<string, (ctx: ReturnType<typeof context>) => Promise<void>> = {}
  let debounce!: (ctx: { session: { id: string }; event: string; messages: Message[]; reply: (s: string) => Promise<void> }) => Promise<void>
  const replies: string[] = [], generated: unknown[] = [], saved: Array<{ id: string; role: string; threadId: string; resourceId: string; content: { parts: Array<{ text: string }> } }> = [], reports: string[] = [], downloads: string[] = []
  const threads = new Map<string, { resourceId: string }>()
  const selected: string[] = []
  const memory = {
    async getThreadById({ threadId }: { threadId: string }) { return threads.get(threadId) },
    async createThread({ threadId, resourceId }: { threadId: string; resourceId: string }) { threads.set(threadId, { resourceId }) },
    async saveMessages({ messages }: { messages: typeof saved }) { if (options.failSave?.()) throw Error('storage failed'); saved.push(...messages) },
  }
  const sdk = {
    onEvent(fn: typeof event) { event = fn },
    onMessage(type: string, fn: typeof handlers[string]) { handlers[type] = fn },
    onTextDebounced(_: unknown, fn: typeof debounce) { debounce = fn; return () => {} },
    messages: { async sendText() {}, async getMediaBase64() { downloads.push('image'); return { data: { media: 'x', mimeType: 'image/png' } } } },
  }
  const agent = {
    async getMemory() { return options.memory ? memory : undefined },
    async generate(input: unknown, opts: { abortSignal?: AbortSignal; memory?: unknown }) { generated.push({ input, memory: opts.memory }); return options.generate ? options.generate(opts.abortSignal) : { text: 'answer' } },
  }
  const integration = new ZappazMastra({ zappaz: sdk as unknown as ZappazMastraOptions['zappaz'], mastra: { getAgentById: (id: string) => { selected.push(id); return agent } } as unknown as ZappazMastraOptions['mastra'], agentId: 'agent', enableImages: true, ...options, onError: async (e) => { reports.push(e.stage); await options.onError?.(e) } })
  function context(m: Message) { return { message: m, session: { id: 'session' }, event: 'inbound-message.upsert', reply: async (s: string) => { replies.push(s) } } }
  return { integration, handlers, context, replies, generated, saved, reports, downloads, selected,
    emit: (kind: string, m: unknown) => event({ event: kind, session: { id: 'session' }, payload: { message: m } }),
    batch: (messages: Message[]) => debounce({ session: { id: 'session' }, event: 'inbound-message.upsert', messages, reply: async (s) => { replies.push(s) } }),
  }
}

describe('human handoff', () => {
  test('dynamic routing selects the agent for paused history and resumed generation', async () => {
    const s = setup({
      agentId: async ({ conversationId }) => conversationId === 'owner' ? 'supervisor' : 'secretary',
      memory: true, humanHandoff: { enabled: true },
    })
    expect(s.selected).toEqual([])
    await s.emit('outbound-message.upsert', message('human', 'clinic', true))
    const inbound = message('question', 'clinic')
    await s.emit('inbound-message.upsert', inbound)
    await s.handlers.text!(s.context(inbound))
    expect(s.selected).toEqual(['secretary', 'secretary'])
    expect(s.saved.map((m) => m.threadId)).toEqual(['clinic', 'clinic'])
    expect(s.generated).toEqual([])
    s.integration.resumeConversation('clinic')
    await s.handlers.text!(s.context(message('next', 'clinic')))
    await s.handlers.text!(s.context(message('hello', 'owner')))
    expect(s.selected).toEqual(['secretary', 'secretary', 'secretary', 'supervisor'])
  })

  test('validates durations, supports fractions, manual control and isolated expiry', () => {
    for (const pauseMinutes of [0, -1, NaN, Infinity, Number.MAX_VALUE]) expect(() => setup({ humanHandoff: { pauseMinutes } })).toThrow('pauseMinutes')
    const clock = spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const { integration } = setup({ humanHandoff: { pauseMinutes: 0.5 } })
      expect(() => integration.pauseConversation(' ')).toThrow()
      integration.pauseConversation('a')
      expect(integration.isConversationPaused('a')).toBe(true)
      expect(integration.isConversationPaused('b')).toBe(false)
      clock.mockReturnValue(129_999); expect(integration.isConversationPaused('a')).toBe(true)
      clock.mockReturnValue(130_000); expect(integration.isConversationPaused('a')).toBe(false)
      integration.pauseConversation('a'); integration.resumeConversation('a'); expect(integration.isConversationPaused('a')).toBe(false)
    } finally { clock.mockRestore() }
  })

  test('outbound validation, allowlist, event kind and duplicate do not spuriously pause or renew', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const s = setup({ humanHandoff: { enabled: true, pauseMinutes: 1 }, allowedConversationIds: ['a'] })
      for (const [kind, payload] of [['messages.send', message('x', 'a', true)], ['outbound-message.upsert', message('x', 'b', true)], ['outbound-message.upsert', message('x')], ['outbound-message.upsert', { ...message('x', 'a', true), fromMe: 'true' }], ['outbound-message.upsert', { ...message('x', 'a', true), sender: null }], ['outbound-message.upsert', null]] as const) await s.emit(kind, payload)
      expect(s.integration.isConversationPaused('a')).toBe(false)
      const outbound = message('out', 'a', true)
      await s.emit('outbound-message.upsert', outbound)
      clock.mockReturnValue(150_000); await s.emit('outbound-message.upsert', outbound)
      clock.mockReturnValue(160_000); expect(s.integration.isConversationPaused('a')).toBe(false)
      const disabled = setup(); await disabled.emit('outbound-message.upsert', outbound); expect(disabled.integration.isConversationPaused('a')).toBe(false)
    } finally { clock.mockRestore() }
  })

  test('records outbound and paused inbound as assistant and user; generates after expiry with memory identity', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const s = setup({ memory: true, humanHandoff: { enabled: true, pauseMinutes: 1 } })
      await s.emit('outbound-message.upsert', message('human', 'a', true))
      const inbound = message('customer')
      await s.emit('inbound-message.upsert', inbound)
      await s.handlers.text!(s.context(inbound))
      expect(s.saved.map((m) => [m.role, m.content.parts[0]!.text, m.threadId, m.resourceId])).toEqual([['assistant', 'human', 'a', 'session'], ['user', 'customer', 'a', 'session']])
      expect(new Set(s.saved.map((m) => m.id)).size).toBe(2)
      expect(s.generated).toEqual([]); expect(s.replies).toEqual([])
      clock.mockReturnValue(160_000)
      await s.handlers.text!(s.context(message('next')))
      expect(s.generated).toEqual([{ input: 'next', memory: { resource: 'session', thread: 'a' } }])
      expect(s.replies).toEqual(['answer'])
    } finally { clock.mockRestore() }
  })

  test('paused media and unsupported messages do not download, generate or reply', async () => {
    const s = setup(); s.integration.pauseConversation('a')
    await s.handlers.image!(s.context(message('picture', 'a', false, 'image')))
    expect(s.downloads).toEqual([]); expect(s.generated).toEqual([]); expect(s.replies).toEqual([])
    await s.handlers.text!(s.context(message('other', 'b')))
    expect(s.generated).toHaveLength(1)
  })

  test('pause aborts active generation and holds queue until uncooperative work settles', async () => {
    const pending = gate<{ text: string }>(); let signal: AbortSignal | undefined
    const s = setup({ memory: true, humanHandoff: { enabled: true }, generate: async (value) => { signal = value; return pending.promise } })
    const first = s.handlers.text!(s.context(message('first'))); await flush()
    const outbound = s.emit('outbound-message.upsert', message('human', 'a', true)); await flush()
    expect(signal?.aborted).toBe(true); expect(signal?.reason).toBeInstanceOf(ConversationPausedError)
    expect(s.saved).toEqual([]); expect(s.replies).toEqual([])
    pending.resolve({ text: 'late' }); await Promise.all([first, outbound])
    expect(s.saved.map((m) => m.role)).toEqual(['assistant']); expect(s.replies).toEqual([]); expect(s.reports).toEqual([])
  })

  test('debounced receipts from before and during pause never generate after resume', async () => {
    const s = setup({ debounceMs: 10, memory: true })
    const before = message('before'), during = message('during')
    await s.emit('inbound-message.upsert', before)
    s.integration.pauseConversation('a')
    await s.emit('inbound-message.upsert', during)
    s.integration.resumeConversation('a')
    await s.batch([before, during])
    expect(s.generated).toEqual([]); expect(s.replies).toEqual([])
    expect(s.saved.map((m) => [m.role, m.content.parts[0]!.text])).toEqual([['user', 'during'], ['user', 'before']])
  })

  test('failed memory recording propagates, reports and permits retry', async () => {
    let fail = true
    const s = setup({ memory: true, failSave: () => fail })
    s.integration.pauseConversation('a')
    const m = message('retry')
    await expect(s.handlers.text!(s.context(m))).rejects.toThrow('storage failed')
    expect(s.reports).toEqual(['memory']); fail = false
    await s.handlers.text!(s.context(m))
    expect(s.saved.map((item) => item.content.parts[0]!.text)).toEqual(['retry'])
  })

  test('queued pre-pause work becomes user history even after resume', async () => {
    const pending = gate<{ text: string }>()
    const s = setup({ memory: true, generate: async () => pending.promise })
    const first = s.handlers.text!(s.context(message('first')))
    await flush()
    const queued = s.handlers.text!(s.context(message('queued')))
    s.integration.pauseConversation('a')
    s.integration.resumeConversation('a')
    pending.resolve({ text: 'late' })
    await Promise.all([first, queued])
    expect(s.generated).toHaveLength(1)
    expect(s.replies).toEqual([])
    expect(s.saved.map((m) => [m.role, m.content.parts[0]!.text])).toEqual([['user', 'queued']])
  })

  test('paused record-only work rejects at capacity without a busy reply and can retry', async () => {
    const pending = gate<{ text: string }>()
    const s = setup({ memory: true, maxPendingMessages: 1, generate: async () => pending.promise })
    const active = s.handlers.text!(s.context(message('active', 'b')))
    await flush()
    s.integration.pauseConversation('a')
    const ctx = s.context(message('waiting'))
    try {
      await expect(s.handlers.text!(ctx)).rejects.toThrow('Pending message limit')
      expect(s.replies).toEqual([])
      expect(s.reports).toEqual(['queue'])
    } finally {
      pending.resolve({ text: 'ok' })
      await active
    }
    await s.handlers.text!(ctx)
    expect(s.saved.map((m) => m.content.parts[0]!.text)).toEqual(['waiting'])
    expect(s.replies).toEqual(['ok'])
  })

  test('pause and resume during the queue error observer suppresses the overflow notice', async () => {
    const generation = gate<{ text: string }>()
    const observerStarted = gate<void>()
    const observerRelease = gate<void>()
    const s = setup({
      maxPendingMessages: 1,
      generate: () => generation.promise,
      onError: async (event) => {
        if (event.stage === 'queue') { observerStarted.resolve(); await observerRelease.promise }
      },
    })
    const active = s.handlers.text!(s.context(message('active', 'b')))
    const overflow = s.handlers.text!(s.context(message('overflow')))
    try {
      await observerStarted.promise
      s.integration.pauseConversation('a')
      s.integration.resumeConversation('a')
      expect(s.integration.isConversationPaused('a')).toBe(false)
      observerRelease.resolve()
      await overflow
      expect(s.reports).toEqual(['queue'])
      expect(s.replies).toEqual([])
    } finally {
      observerRelease.resolve()
      generation.resolve({ text: '' })
      await Promise.all([active, overflow])
    }
    expect(s.replies).toEqual([])
  })

  test('pause and resume during the timeout observer suppresses the timeout notice', async () => {
    const generation = gate<{ text: string }>()
    const observerStarted = gate<void>()
    const observerRelease = gate<void>()
    const s = setup({
      timeoutMs: 100,
      generate: () => generation.promise,
      onError: async (event) => {
        if (event.stage === 'timeout') { observerStarted.resolve(); await observerRelease.promise }
      },
    })
    const active = s.handlers.text!(s.context(message('active')))
    try {
      await observerStarted.promise
      s.integration.pauseConversation('a')
      s.integration.resumeConversation('a')
      expect(s.integration.isConversationPaused('a')).toBe(false)
      observerRelease.resolve()
      generation.resolve({ text: 'late' })
      await active
      expect(s.reports).toEqual(['timeout'])
      expect(s.replies).toEqual([])
    } finally {
      observerRelease.resolve()
      generation.resolve({ text: 'late' })
      await active
    }
  })
})
