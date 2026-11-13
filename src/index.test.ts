import { describe, expect, test } from 'bun:test'
import { MESSAGE_TYPES, type MessageType } from '@zappaz/zappaz-lite-sdk'
import { ZappazMastra, type ZappazMastraOptions } from './index.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

type Context = {
  session: { id: string }
  event: object
  message: {
    type: MessageType
    conversationId: string | null
    chatId: string | null
    messageId: string
    text: string
    isGroup: boolean
    sender: { id: string; name?: string }
    replyTo?: { id: string; senderId: string; type: MessageType; text: string }
    media: { mimeType: string }
  }
  reply: (text: string) => Promise<void>
}

function context(type: Context['message']['type'], id: string, text: string): Context {
  return {
    session: { id: 'session' },
    event: {},
    message: { type, conversationId: id, chatId: 'chat', messageId: text, text, isGroup: false, sender: { id: 'sender' }, media: { mimeType: type === 'image' ? 'image/png' : 'audio/ogg' } },
    reply: async () => {},
  }
}

function setup(options: {
  generate?: (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<{ text: string }>
  allowedConversationIds?: readonly string[]
  debounceMs?: number
  downloadError?: Error
  downloadImage?: (signal?: AbortSignal) => Promise<{ data: { media: string; mimeType: string } }>
  downloadAudio?: (signal?: AbortSignal) => Promise<{ data: Uint8Array; headers: Headers }>
} & Partial<Pick<ZappazMastraOptions, 'commandPrefix' | 'enableImages' | 'enableAudio' | 'errorMessages' | 'onError' | 'transcribeAudio' | 'timeoutMs' | 'maxPendingMessages' | 'deduplication' | 'timeoutMessage' | 'queueFullMessage'>> = {}) {
  const handlers: Partial<Record<Context['message']['type'], (ctx: Context) => Promise<void>>> = {}
  let debounced!: (ctx: { session: Context['session']; event: object; messages: Context['message'][]; reply: Context['reply'] }) => Promise<void>
  const calls: string[] = []
  const sdk = {
    onEvent() {},
    onMessage(type: Context['message']['type'], handler: (ctx: Context) => Promise<void>) { handlers[type] = handler },
    onTextDebounced(_options: unknown, handler: typeof debounced) { debounced = handler; return () => {} },
    messages: {
      async getMediaBase64(id: string, opts?: { signal?: AbortSignal }) { calls.push(`image:${id}`); if (options.downloadError) throw options.downloadError; return options.downloadImage ? options.downloadImage(opts?.signal) : { data: { media: 'base64', mimeType: 'image/png' } } },
      async getMediaBinary(id: string, opts?: { signal?: AbortSignal }) { calls.push(`audio:${id}`); if (options.downloadError) throw options.downloadError; return options.downloadAudio ? options.downloadAudio(opts?.signal) : { data: new Uint8Array([1]), headers: new Headers({ 'content-type': 'audio/ogg' }) } },
    },
  }
  const agent = {
    async getMemory() { return undefined },
    async generate(input: unknown, generateOptions: { abortSignal?: AbortSignal }) {
      calls.push(`generate:${typeof input === 'string' ? input : 'image'}`)
      return options.generate ? options.generate(input, generateOptions) : { text: 'response' }
    },
  }
  new ZappazMastra({
    zappaz: sdk as unknown as ZappazMastraOptions['zappaz'],
    mastra: { getAgentById: () => agent } as unknown as ZappazMastraOptions['mastra'],
    agentId: 'agent',
    debounceMs: options.debounceMs,
    allowedConversationIds: options.allowedConversationIds,
    commandPrefix: options.commandPrefix,
    enableImages: options.enableImages,
    enableAudio: options.enableAudio,
    errorMessages: options.errorMessages,
    onError: options.onError,
    transcribeAudio: options.transcribeAudio,
    timeoutMs: options.timeoutMs,
    maxPendingMessages: options.maxPendingMessages,
    deduplication: options.deduplication,
    timeoutMessage: options.timeoutMessage,
    queueFullMessage: options.queueFullMessage,
  })
  return { handlers, calls, debounce: (ctx: Parameters<typeof debounced>[0]) => debounced(ctx) }
}

describe('conversation serialization', () => {
  test('same conversation waits for generation and delivery; another conversation runs concurrently', async () => {
    const generation = deferred<{ text: string }>()
    const reply = deferred()
    const { handlers, calls } = setup({ generate: async (input) => input === 'first' ? generation.promise : { text: 'response' } })
    const first = context('text', 'a', 'first')
    first.reply = async () => { calls.push('reply:first'); await reply.promise }
    const p1 = handlers.text!(first)
    const p2 = handlers.text!(context('text', 'a', 'second'))
    const p3 = handlers.text!(context('text', 'b', 'other'))
    await p3
    expect(calls).toEqual(['generate:first', 'generate:other'])
    generation.resolve({ text: 'response' })
    await flush()
    expect(calls).toEqual(['generate:first', 'generate:other', 'reply:first'])
    reply.resolve()
    await Promise.all([p1, p2])
    expect(calls).toEqual(['generate:first', 'generate:other', 'reply:first', 'generate:second'])
  })

  for (const failure of ['generate', 'reply'] as const) {
    test(`${failure} failure leaves the next message unblocked`, async () => {
      const gate = deferred()
      const error = new Error(`${failure} failed`)
      const { handlers, calls } = setup({
        generate: async (input) => {
          if (input === 'first' && failure === 'generate') { await gate.promise; throw error }
          return { text: 'response' }
        },
      })
      const first = context('text', 'a', 'first')
      if (failure === 'reply') first.reply = async () => { await gate.promise; throw error }
      const p1 = handlers.text!(first)
      const replies: string[] = []
      if (failure === 'generate') first.reply = async (text) => { replies.push(text) }
      const outcome = p1.then(() => undefined, (caught) => caught)
      const p2 = handlers.text!(context('text', 'a', 'second'))
      await flush()
      expect(calls).toEqual(['generate:first'])
      gate.resolve()
      expect(await outcome).toBe(failure === 'reply' ? error : undefined)
      if (failure === 'generate') expect(replies).toEqual(['Não consegui responder. Por favor, tente novamente.'])
      await p2
      expect(calls).toEqual(['generate:first', 'generate:second'])
    })
  }

  test('completion of an older task does not remove a queue with pending work', async () => {
    const first = deferred<{ text: string }>()
    const second = deferred<{ text: string }>()
    const { handlers, calls } = setup({ generate: async (input) => {
      if (input === 'first') return first.promise
      if (input === 'second') return second.promise
      return { text: 'response' }
    } })
    const p1 = handlers.text!(context('text', 'a', 'first'))
    const p2 = handlers.text!(context('text', 'a', 'second'))
    first.resolve({ text: 'response' })
    await p1
    await flush()
    expect(calls).toEqual(['generate:first', 'generate:second'])
    const p3 = handlers.text!(context('text', 'a', 'third'))
    await flush()
    expect(calls).toEqual(['generate:first', 'generate:second'])
    second.resolve({ text: 'response' })
    await Promise.all([p2, p3])
    expect(calls).toEqual(['generate:first', 'generate:second', 'generate:third'])
  })

  test('allowlist and missing identifiers prevent downloads, generation and replies', async () => {
    const { handlers, calls } = setup({ allowedConversationIds: ['allowed'] })
    let replies = 0
    for (const type of ['text', 'image', 'audio'] as const) {
      for (const id of ['blocked', 'allowed']) {
        const ctx = context(type, id, `${type}-${id}`)
        if (id === 'allowed') ctx.message.chatId = null
        ctx.reply = async () => { replies++ }
        await handlers[type]!(ctx)
      }
      const missing = context(type, 'allowed', 'missing')
      missing.message.conversationId = null
      await handlers[type]!(missing)
    }
    expect(calls).toEqual([])
    expect(replies).toBe(0)
    await handlers.text!(context('text', 'allowed', 'permitted'))
    expect(calls).toEqual(['generate:permitted'])
  })

  test('text, image and audio share the conversation queue including media downloads', async () => {
    const gate = deferred<{ text: string }>()
    const { handlers, calls } = setup({ enableImages: true, enableAudio: true, transcribeAudio: async () => 'transcribed', generate: async (input) => input === 'first' ? gate.promise : { text: 'response' } })
    const p1 = handlers.text!(context('text', 'a', 'first'))
    const p2 = handlers.image!(context('image', 'a', 'picture'))
    const p3 = handlers.audio!(context('audio', 'a', 'voice'))
    await flush()
    expect(calls).toEqual(['generate:first'])
    gate.resolve({ text: 'response' })
    await Promise.all([p1, p2, p3])
    expect(calls).toEqual(['generate:first', 'image:picture', 'generate:image', 'audio:voice', 'generate:Áudio: transcribed'])
  })

  test('debounced text shares the media queue and filters blocked batch messages', async () => {
    const gate = deferred<{ text: string }>()
    const { handlers, calls, debounce } = setup({
      debounceMs: 50,
      enableImages: true, enableAudio: true, transcribeAudio: async () => 'transcribed',
      allowedConversationIds: ['a'],
      generate: async (input) => typeof input !== 'string' ? gate.promise : { text: 'response' },
    })
    const p1 = handlers.image!(context('image', 'a', 'picture'))
    const a = context('text', 'a', ' first ')
    const blocked = context('text', 'blocked', 'secret')
    const last = context('text', 'a', ' second ')
    const p2 = debounce({ session: a.session, event: a.event, reply: a.reply, messages: [a.message, blocked.message, last.message] })
    const p3 = handlers.audio!(context('audio', 'a', 'voice'))
    await flush()
    expect(calls).toEqual(['image:picture', 'generate:image'])
    gate.resolve({ text: 'response' })
    await Promise.all([p1, p2, p3])
    expect(calls).toEqual(['image:picture', 'generate:image', 'generate:first\nsecond', 'audio:voice', 'generate:Áudio: transcribed'])
    await debounce({ session: a.session, event: a.event, reply: a.reply, messages: [blocked.message] })
    expect(calls).toHaveLength(5)
  })
})

describe('message handling contract', () => {
  test('all message types have defaults and support per-type overrides', async () => {
    const defaults: Record<MessageType, string> = {
      text: 'Não consegui responder. Por favor, tente novamente.',
      image: 'Não consegui processar essa imagem. Por favor, envie sua mensagem em texto.',
      audio: 'Não consegui processar esse áudio. Por favor, envie sua mensagem em texto.',
      video: 'Não consigo analisar vídeos. Por favor, envie sua mensagem em texto.',
      document: 'Não consigo ler documentos. Por favor, envie sua mensagem em texto.',
      sticker: 'Não consigo interpretar figurinhas. Por favor, envie sua mensagem em texto.',
      location: 'Não consigo processar localizações. Por favor, descreva o endereço em texto.',
      contact: 'Não consigo processar contatos. Por favor, envie os dados em texto.',
      reaction: 'Não consigo interpretar reações. Por favor, envie sua mensagem em texto.',
      poll: 'Não consigo processar enquetes. Por favor, envie sua mensagem em texto.',
      album: 'Não consigo processar álbuns. Por favor, envie sua mensagem em texto.',
      group_invite: 'Não consigo processar convites de grupo. Por favor, envie sua mensagem em texto.',
      system: 'Não consigo processar esse tipo de mensagem. Por favor, envie uma mensagem em texto.',
      unavailable: 'Essa mensagem não está disponível. Por favor, envie novamente em texto.',
      unknown: 'Não reconheço esse tipo de mensagem. Por favor, envie sua mensagem em texto.',
    }
    for (const type of MESSAGE_TYPES) {
      for (const override of [false, true]) {
        const { handlers } = setup({
          errorMessages: override ? { [type]: `custom ${type}` } : undefined,
          generate: async () => { throw new Error('generation failed') },
        })
        const ctx = context(type, 'a', 'message')
        const replies: string[] = []
        ctx.reply = async (text) => { replies.push(text) }
        await handlers[type]!(ctx)
        expect(replies).toHaveLength(1)
        if (override) expect(replies[0]).toBe(`custom ${type}`)
        else expect(replies[0]).toBe(defaults[type])
      }
    }
  })

  test('images and audio default to disabled even with a transcriber', async () => {
    let transcriptions = 0
    const disabled = setup({ transcribeAudio: async () => { transcriptions++; return 'text' } })
    const replies: string[] = []
    for (const type of ['image', 'audio'] as const) {
      const ctx = context(type, 'a', type)
      ctx.reply = async (text) => { replies.push(text) }
      await disabled.handlers[type]!(ctx)
    }
    expect(disabled.calls).toEqual([])
    expect(transcriptions).toBe(0)
    expect(replies).toHaveLength(2)
  })

  test('allowlist blocks warnings and enabled downloads before any work', async () => {
    for (const options of [{}, { enableImages: true, enableAudio: true, transcribeAudio: async () => 'ok' }]) {
      const { handlers, calls } = setup({ ...options, allowedConversationIds: [] })
      let replies = 0
      for (const type of MESSAGE_TYPES) {
        const ctx = context(type, 'blocked', 'message')
        ctx.reply = async () => { replies++ }
        await handlers[type]!(ctx)
      }
      expect(calls).toEqual([])
      expect(replies).toBe(0)
    }
  })

  test('prefix filters text before queuing, removes prefix, and does not filter enabled media', async () => {
    const gate = deferred<{ text: string }>()
    const { handlers, calls } = setup({ commandPrefix: '!bot', enableImages: true,
      generate: async (input) => input === 'first' ? gate.promise : { text: 'ok' } })
    const p1 = handlers.text!(context('text', 'a', '!bot first'))
    await handlers.text!(context('text', 'a', 'ignore'))
    await handlers.text!(context('text', 'a', '!bot   '))
    const p2 = handlers.image!(context('image', 'a', 'caption'))
    await flush()
    expect(calls).toEqual(['generate:first'])
    gate.resolve({ text: 'ok' })
    await Promise.all([p1, p2])
    expect(calls).toEqual(['generate:first', 'image:caption', 'generate:image'])
    for (const prefix of ['', '   ']) expect(() => setup({ commandPrefix: prefix })).toThrow()
  })

  test('debounce filters each message by allowlist and prefix before joining', async () => {
    const { debounce, calls } = setup({ debounceMs: 1, commandPrefix: '!', allowedConversationIds: ['a'] })
    const a = context('text', 'a', '! first')
    const messages = [a.message, context('text', 'a', 'ignored').message,
      context('text', 'blocked', '! secret').message, context('text', 'a', '! second').message]
    await debounce({ session: a.session, event: a.event, reply: a.reply, messages })
    expect(calls).toEqual(['generate:first\nsecond'])
  })

  test('quoted message is JSON context, group sender is escaped and falls back to id', async () => {
    const { handlers, calls } = setup()
    const ctx = context('text', 'a', 'answer')
    ctx.message.isGroup = true
    ctx.message.sender = { id: 'id<1>', name: '  Ana & B  ' }
    ctx.message.replyTo = { id: 'quoted', senderId: 'other', type: 'image', text: 'hello\n"x"' }
    await handlers.text!(ctx)
    expect(calls).toEqual([`generate:<user>Ana &amp; B</user>: Mensagem citada (contexto): ${JSON.stringify(ctx.message.replyTo)}\nMensagem atual: answer`])
    ctx.message.sender.name = '  '
    ctx.message.messageId = 'second-message'
    delete ctx.message.replyTo
    await handlers.text!(ctx)
    expect(calls[1]).toBe('generate:<user>id&lt;1&gt;</user>: answer')
    expect(calls).toHaveLength(2)
  })

  for (const stage of ['download', 'transcribe', 'generate', 'reply'] as const) {
    test(`reports ${stage} errors without payload and ignores observer failures`, async () => {
      const error = new Error(stage)
      const reports: unknown[] = []
      const { handlers, calls } = setup({ enableAudio: true,
        downloadError: stage === 'download' ? error : undefined,
        transcribeAudio: async () => { if (stage === 'transcribe') throw error; return 'transcript' },
        generate: async () => { if (stage === 'generate') throw error; return { text: 'ok' } },
        onError: async (report) => { reports.push(report); throw new Error('observer failed') },
      })
      const ctx = context('audio', 'conversation', 'private payload')
      const replies: string[] = []
      ctx.reply = async (text) => { replies.push(text); if (stage === 'reply') throw error }
      const outcome = await handlers.audio!(ctx).then(() => undefined, (caught) => caught)
      expect(outcome).toBe(stage === 'reply' ? error : undefined)
      expect(reports).toEqual([{ error, stage, sessionId: 'session', conversationId: 'conversation', messageId: 'private payload', messageType: 'audio' }])
      expect(replies).toHaveLength(1)
      if (stage !== 'reply') expect(replies[0]).toMatch(/áudio/)
      await handlers.text!(context('text', 'conversation', 'next'))
      expect(calls).toContain('generate:next')
    })
  }
})

describe('execution protection', () => {
  test('rejects invalid debounce and audio configuration before registering any handlers', () => {
    const registrations: string[] = []
    const zappaz = {
      onEvent: () => { registrations.push('event') },
      onMessage: () => { registrations.push('message') },
      onTextDebounced: () => { registrations.push('debounce'); return () => {} },
    } as unknown as ZappazMastraOptions['zappaz']
    const mastra = { getAgentById: () => ({}) } as unknown as ZappazMastraOptions['mastra']
    const create = (options: Partial<ZappazMastraOptions>) =>
      new ZappazMastra({ zappaz, mastra, agentId: 'agent', ...options })
    for (const debounceMs of [0, -1, 1.5, NaN, Infinity, -Infinity, 2_147_483_648]) {
      expect(() => create({ debounceMs })).toThrow('debounceMs')
      expect(registrations).toEqual([])
    }
    for (const transcribeAudio of [undefined, null, 'invalid']) {
      expect(() => create({ enableAudio: true, transcribeAudio: transcribeAudio as ZappazMastraOptions['transcribeAudio'] })).toThrow('transcribeAudio')
      expect(registrations).toEqual([])
    }
    expect(() => create({ debounceMs: 1 })).not.toThrow()
    expect(registrations).toContain('debounce')
    registrations.length = 0
    expect(() => create({ debounceMs: 2_147_483_647, enableAudio: true, transcribeAudio: async () => 'ok' })).not.toThrow()
    expect(registrations).toContain('debounce')
  })

  test('validates numeric limits', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      expect(() => setup({ timeoutMs: value })).toThrow('timeoutMs')
    }
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => setup({ maxPendingMessages: value })).toThrow('maxPendingMessages')
      expect(() => setup({ deduplication: { ttlMs: value } })).toThrow('ttlMs')
      expect(() => setup({ deduplication: { maxEntries: value } })).toThrow('maxEntries')
    }
    expect(() => setup({ timeoutMs: 2_147_483_647, maxPendingMessages: 1, deduplication: { ttlMs: 1, maxEntries: 1 } })).not.toThrow()
  })

  test('deduplicates active and completed IDs, not content, and isolates session and conversation', async () => {
    const gate = deferred<{ text: string }>()
    const { handlers, calls } = setup({ generate: async (input) => input === 'first' ? gate.promise : { text: 'ok' } })
    const first = context('text', 'a', 'first')
    const p = handlers.text!(first)
    const duplicate = context('text', 'a', 'changed'); duplicate.message.messageId = first.message.messageId
    await handlers.text!(duplicate)
    gate.resolve({ text: 'ok' }); await p
    await handlers.text!(duplicate)
    const otherSession = context('text', 'a', 'changed'); otherSession.message.messageId = first.message.messageId; otherSession.session.id = 'other'
    const otherConversation = context('text', 'b', 'changed'); otherConversation.message.messageId = first.message.messageId
    const sameText = context('text', 'a', 'changed'); sameText.message.messageId = 'new-id'
    const missing = context('text', 'a', 'missing'); missing.message.messageId = ''
    await handlers.text!(otherSession); await handlers.text!(otherConversation); await handlers.text!(sameText)
    await handlers.text!(missing); await handlers.text!(missing)
    expect(calls).toEqual(['generate:first', 'generate:changed', 'generate:changed', 'generate:changed', 'generate:missing', 'generate:missing'])
  })

  for (const failure of ['generate', 'reply'] as const) {
    test(`retains message after ${failure} failure`, async () => {
      const { handlers, calls } = setup({ generate: async () => { if (failure === 'generate') throw Error('failed'); return { text: 'ok' } } })
      const ctx = context('text', 'a', 'once')
      if (failure === 'reply') ctx.reply = async () => { throw Error('failed') }
      await handlers.text!(ctx).catch(() => {})
      await handlers.text!(ctx)
      expect(calls).toEqual(['generate:once'])
    })
  }

  test('debounce removes duplicate IDs individually, including within a batch', async () => {
    const { debounce, calls } = setup({ debounceMs: 1 })
    const a = context('text', 'a', 'one')
    const batch = (messages: Context['message'][]) => debounce({ session: a.session, event: a.event, reply: a.reply, messages })
    await batch([a.message])
    const b = context('text', 'a', 'two')
    const repeated = { ...b.message, text: 'different content' }
    const c = context('text', 'a', 'three')
    await batch([a.message, b.message, repeated, c.message])
    expect(calls).toEqual(['generate:one', 'generate:two\nthree'])
  })

  test('global capacity counts running and queued tasks; rejected ID can retry', async () => {
    const gate = deferred<{ text: string }>()
    const reports: string[] = []; const replies: string[] = []
    const { handlers, calls } = setup({ maxPendingMessages: 2, queueFullMessage: 'busy', onError: (e) => { reports.push(e.stage) }, generate: async (input) => input === 'first' ? gate.promise : { text: 'ok' } })
    const first = handlers.text!(context('text', 'a', 'first'))
    const second = handlers.text!(context('text', 'a', 'second'))
    const overflow = context('image', 'b', 'third'); overflow.reply = async (text) => { replies.push(text) }
    try {
      await handlers.image!(overflow)
      expect(reports).toEqual(['queue']); expect(replies).toEqual(['busy'])
      expect(calls).toEqual(['generate:first'])
    } finally { gate.resolve({ text: 'ok' }); await Promise.all([first, second]) }
    await handlers.image!(overflow)
    expect(replies).toHaveLength(2)
    expect(replies[1]).not.toBe('busy')
  })

  test('timeout aborts generation, suppresses late reply, and keeps slot and conversation until underlying work settles', async () => {
    const gate = deferred<{ text: string }>(); const reports: string[] = []; const replies: string[] = []
    let signal: AbortSignal | undefined
    const { handlers, calls } = setup({ timeoutMs: 30, maxPendingMessages: 2, timeoutMessage: 'late', onError: (e) => { reports.push(e.stage) }, generate: async (input, options) => { if (input === 'first') { signal = options.abortSignal; return gate.promise }; return { text: 'ok' } } })
    const ctx = context('text', 'a', 'first'); ctx.reply = async (text) => { replies.push(text) }
    const p1 = handlers.text!(ctx)
    const p2 = handlers.text!(context('text', 'a', 'second'))
    try {
      await Bun.sleep(80)
      expect(signal?.aborted).toBe(true)
      expect(reports).toEqual(['timeout']); expect(replies).toEqual(['late'])
      expect(calls).toEqual(['generate:first'])
      const overflow = context('text', 'b', 'third'); const warnings: string[] = []; overflow.reply = async (text) => { warnings.push(text) }
      await handlers.text!(overflow)
      expect(warnings).toHaveLength(1)
    } finally { gate.resolve({ text: 'too late' }); await Promise.all([p1, p2]) }
    expect(replies).toEqual(['late'])
    expect(calls).toEqual(['generate:first', 'generate:second'])
    await handlers.text!(ctx)
    expect(calls).toHaveLength(2)
  })

  test('does not send a timeout notice after delivery has started', async () => {
    const gate = deferred(); const reports: string[] = []; const replies: string[] = []
    const { handlers } = setup({ timeoutMs: 30, onError: (e) => { reports.push(e.stage) } })
    const ctx = context('text', 'a', 'message'); ctx.reply = async (text) => { replies.push(text); await gate.promise }
    const p = handlers.text!(ctx)
    try { await Bun.sleep(80); expect(reports).toEqual(['timeout']); expect(replies).toEqual(['response']) }
    finally { gate.resolve(); await p }
  })
})

describe('cancellation propagation', () => {
  for (const stage of ['image download', 'audio download', 'transcription'] as const) {
    test(`passes an abort signal to ${stage} and does not generate after timeout`, async () => {
      let signal: AbortSignal | undefined
      const waitForAbort = (s?: AbortSignal) => new Promise<never>((_, reject) => {
        signal = s
        s?.addEventListener('abort', () => reject(s.reason), { once: true })
      })
      const { handlers, calls } = setup({ timeoutMs: 25, enableImages: true, enableAudio: true,
        downloadImage: stage === 'image download' ? waitForAbort : undefined,
        downloadAudio: stage === 'audio download' ? waitForAbort : undefined,
        transcribeAudio: async ({ signal: s }) => stage === 'transcription' ? waitForAbort(s) : 'text',
      })
      const type = stage === 'image download' ? 'image' : 'audio'
      const ctx = context(type, 'a', 'media'); const replies: string[] = []
      ctx.reply = async (text) => { replies.push(text) }
      await handlers[type]!(ctx)
      expect(signal?.aborted).toBe(true)
      expect(replies).toHaveLength(1)
      expect(calls.some((call) => call.startsWith('generate:'))).toBe(false)
    })
  }

  test('a queued task deadline starts at execution, not admission', async () => {
    const gate = deferred<{ text: string }>(); const reports: string[] = []
    const { handlers, calls } = setup({ timeoutMs: 40, onError: (e) => { reports.push(`${e.stage}:${e.messageId}`) }, generate: async (input) => input === 'first' ? gate.promise : { text: 'ok' } })
    const p1 = handlers.text!(context('text', 'a', 'first'))
    const p2 = handlers.text!(context('text', 'a', 'second'))
    try {
      await Bun.sleep(85)
      expect(reports).toEqual(['timeout:first'])
      expect(calls).toEqual(['generate:first'])
    } finally { gate.resolve({ text: 'late' }); await Promise.all([p1, p2]) }
    expect(calls).toEqual(['generate:first', 'generate:second'])
    expect(reports).toEqual(['timeout:first'])
  })

  test('one overflow notice is in flight globally', async () => {
    const generation = deferred<{ text: string }>(); const notice = deferred(); const replies: string[] = []
    const { handlers } = setup({ timeoutMs: 500, maxPendingMessages: 1, generate: async () => generation.promise })
    const p = handlers.text!(context('text', 'a', 'first'))
    const overflow = context('text', 'b', 'second'); overflow.reply = async (text) => { replies.push(text); await notice.promise }
    const p2 = handlers.text!(overflow)
    try {
      await flush()
      const another = context('text', 'c', 'third'); another.reply = async (text) => { replies.push(text) }
      await handlers.text!(another)
      expect(replies).toHaveLength(1)
    } finally { notice.resolve(); generation.resolve({ text: 'ok' }); await Promise.all([p, p2]) }
  })
})
