import { describe, expect, test } from 'bun:test'
import { ZappazMastra, type ZappazMastraOptions } from './index.js'

type Row = ReturnType<typeof row>
type Tool = { execute: (input: never, context: never) => Promise<unknown>; inputSchema: { safeParse: (input: unknown) => { success: boolean } } }
type GenerateOptions = { abortSignal?: AbortSignal; toolsets?: { zappaz: Record<string, Tool> } }
const invoke = (tool: Tool, input: unknown) => tool.execute(input as never, {} as never)
function row(messageId: string, conversationId = 'conversation', sessionId = 'session') {
  return { id: 'internal-secret', messageId, conversationId, sessionId, text: 'hello', type: 'text', sender: { jid: 'sender@s.whatsapp.net', name: 'Ana', secret: 'hidden' }, fromMe: false, createdAt: '2026-01-01T00:00:00Z', media: { secret: 'hidden' } }
}
function context(conversationId = 'conversation', sessionId = 'session', chatId = 'chat@s.whatsapp.net') {
  const replies: string[] = []
  return { replies, ctx: { session: { id: sessionId }, event: {}, message: { type: 'text', conversationId, chatId, messageId: `incoming-${conversationId}`, text: 'input', isGroup: chatId.endsWith('@g.us'), sender: { id: 'sender' } }, reply: async (text: string) => { replies.push(text) } } }
}
function setup(options: {
  tools?: ZappazMastraOptions['tools']; lastMessages?: number | false; noMemory?: boolean; timeoutMs?: number
  generate: (options: GenerateOptions, input: unknown) => Promise<void | string>
  expectedGenerateError?: Error
  list?: (query: { conversationId: string; limit: number; before?: string }, opts: { signal?: AbortSignal }) => Promise<{ data: Row[]; page: { hasMore: boolean; nextCursor?: string } }>
  get?: (id: string, query: { conversationId: string }, opts: { signal?: AbortSignal }) => Promise<{ data: Row }>
  send?: (body: { number: string; message: string; quoted: string }, opts: { signal?: AbortSignal }) => Promise<{ status: 'success' }>
}) {
  let handler!: (ctx: ReturnType<typeof context>['ctx']) => Promise<void>
  const errors: ZappazMastraOptions['onError'] extends ((arg: infer T) => unknown) | undefined ? T[] : never = []
  const calls = { list: [] as unknown[], get: [] as unknown[], send: [] as unknown[] }
  let assertion: unknown
  const existingTools = { existing: 'unchanged' }
  const agent = { tools: existingTools, getMemory: async () => options.noMemory ? undefined : { getMergedThreadConfig: () => ({ lastMessages: options.lastMessages }) }, generate: async (input: unknown, opts: GenerateOptions) => {
    try { return { text: (await options.generate(opts, input)) ?? 'automatic response' } }
    catch (error) { if (error !== options.expectedGenerateError) assertion = error; throw error }
  } }
  const sdk = { onEvent: () => {}, onMessage: (type: string, fn: typeof handler) => { if (type === 'text') handler = fn }, messages: {
    list: async (query: Parameters<NonNullable<typeof options.list>>[0], opts: { signal?: AbortSignal }) => { calls.list.push([query, opts]); return options.list ? options.list(query, opts) : { data: [], page: { hasMore: false } } },
    get: async (id: string, query: { conversationId: string }, opts: { signal?: AbortSignal }) => { calls.get.push([id, query, opts]); return options.get ? options.get(id, query, opts) : { data: row(id, query.conversationId) } },
    sendText: async (body: { number: string; message: string; quoted: string }, opts: { signal?: AbortSignal }) => { calls.send.push([body, opts]); return options.send ? options.send(body, opts) : { status: 'success' as const } },
  } }
  new ZappazMastra({ zappaz: sdk as unknown as ZappazMastraOptions['zappaz'], mastra: { getAgentById: () => agent } as unknown as ZappazMastraOptions['mastra'], agentId: 'agent', tools: options.tools, timeoutMs: options.timeoutMs, onError: (e) => { errors.push(e) } })
  return { calls, errors, agent, existingTools, run: async (c = context()) => { await handler(c.ctx); if (assertion) throw assertion; return c }, handler }
}

describe('generation-scoped conversation tools', () => {
  for (const [flags, expected] of [[undefined, []], [{}, []], [{ getConversationMessages: true }, ['getConversationMessages']], [{ replyMessage: true }, ['replyMessage']], [{ getConversationMessages: true, replyMessage: true }, ['getConversationMessages', 'replyMessage']]] as const) {
    test(`injects independently: ${JSON.stringify(flags)}`, async () => {
      const s = setup({ tools: flags, generate: async (o) => { expect(Object.keys(o.toolsets?.zappaz ?? {})).toEqual([...expected]); if (!expected.length) expect(o.toolsets).toBeUndefined() } })
      await s.run(); expect(s.agent.tools).toBe(s.existingTools); expect(s.agent.tools).toEqual({ existing: 'unchanged' })
    })
  }
  for (const lastMessages of [false, undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1] as const) {
    test(`does not list for lastMessages ${lastMessages}`, async () => {
      const s = setup({ tools: { getConversationMessages: true }, lastMessages, generate: async (o) => { expect(await invoke(o.toolsets!.zappaz.getConversationMessages!, {})).toEqual({ messages: [], hasMore: false }) } })
      await s.run(); expect(s.calls.list).toEqual([])
    })
  }
  test('absent memory does not list', async () => {
    const s = setup({ tools: { getConversationMessages: true }, noMemory: true, generate: async (o) => { expect(await invoke(o.toolsets!.zappaz.getConversationMessages!, {})).toEqual({ messages: [], hasMore: false }) } })
    await s.run(); expect(s.calls.list).toEqual([])
  })
  test('returns only allowed fields, uses lastMessages 20, strict input and signals', async () => {
    const s = setup({ tools: { getConversationMessages: true, replyMessage: true }, lastMessages: 20, list: async () => ({ data: [row('wa-id')], page: { hasMore: false } }), generate: async (o) => {
      const tools = o.toolsets!.zappaz
      expect(tools.getConversationMessages!.inputSchema.safeParse({ conversationId: 'other' }).success).toBe(false)
      expect(tools.replyMessage!.inputSchema.safeParse({ messageId: 'wa-id', text: 'hi', chatId: 'other' }).success).toBe(false)
      expect(await invoke(tools.getConversationMessages!, {})).toEqual({ messages: [{ messageId: 'wa-id', text: 'hello', type: 'text', sender: { jid: 'sender@s.whatsapp.net', name: 'Ana' }, fromMe: false, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false })
      expect(await invoke(tools.replyMessage!, { messageId: 'wa-id', text: 'response' })).toEqual({ status: 'success' })
    } })
    const c = context('conversation', 'session', 'group@g.us'); await s.run(c)
    expect(s.calls.list).toEqual([[{ conversationId: 'conversation', limit: 20 }, { signal: expect.any(AbortSignal) }]])
    expect(s.calls.get).toEqual([]); expect(s.calls.send).toEqual([[{ number: 'group@g.us', message: 'response', quoted: 'wa-id' }, { signal: expect.any(AbortSignal) }]]); expect(c.replies).toEqual(['automatic response'])
  })
  test('paginates above 100 with a cursor', async () => {
    const s = setup({ tools: { getConversationMessages: true }, lastMessages: 120, list: async (q) => q.before ? { data: Array.from({ length: 20 }, (_, i) => row(`b${i}`)), page: { hasMore: true } } : { data: Array.from({ length: 100 }, (_, i) => row(`a${i}`)), page: { hasMore: true, nextCursor: 'cursor' } }, generate: async (o) => { const result = await invoke(o.toolsets!.zappaz.getConversationMessages!, {}) as { messages: unknown[]; hasMore: boolean }; expect(result.messages).toHaveLength(120); expect(result.hasMore).toBe(true) } })
    await s.run(); expect(s.calls.list.map((c) => (c as unknown[])[0])).toEqual([{ conversationId: 'conversation', limit: 100 }, { conversationId: 'conversation', limit: 20, before: 'cursor' }])
  })
  for (const bad of [row('id', 'other'), row('id', 'conversation', 'other')]) {
    test(`rejects cross-context history ${bad.conversationId}/${bad.sessionId}`, async () => {
      const s = setup({ tools: { getConversationMessages: true }, lastMessages: 20, list: async () => ({ data: [bad], page: { hasMore: false } }), generate: async (o) => { await expect(invoke(o.toolsets!.zappaz.getConversationMessages!, {})).rejects.toThrow() } })
      await s.run(); expect(s.errors.map((e) => e.stage)).toEqual(['history'])
    })
  }
  for (const bad of [row('wrong'), row('id', 'other'), row('id', 'conversation', 'other')]) {
    test(`validates unknown ID lookup ${bad.messageId}/${bad.conversationId}/${bad.sessionId}`, async () => {
      const s = setup({ tools: { replyMessage: true }, get: async () => ({ data: bad }), generate: async (o) => { await expect(invoke(o.toolsets!.zappaz.replyMessage!, { messageId: 'id', text: 'hi' })).rejects.toThrow() } })
      await s.run(); expect(s.calls.get).toEqual([['id', { conversationId: 'conversation' }, { signal: expect.any(AbortSignal) }]]); expect(s.calls.send).toEqual([]); expect(s.errors.map((e) => e.stage)).toEqual(['history'])
    })
  }
  for (const fail of [false, true]) for (const finalText of ['', ' \n\t ', '  complemento  ']) {
    test(`one quoted attempt and final ${JSON.stringify(finalText)}, send failure=${fail}`, async () => {
      const s = setup({ tools: { replyMessage: true }, send: async () => { if (fail) throw Error('ambiguous'); return { status: 'success' } }, generate: async (o) => {
        const tool = o.toolsets!.zappaz.replyMessage!; const input = { messageId: 'id', text: 'hi' }
        if (fail) await expect(invoke(tool, input)).rejects.toThrow('ambiguous'); else await invoke(tool, input)
        await expect(invoke(tool, input)).rejects.toThrow()
        return finalText
      } })
      const c = await s.run(); expect(s.calls.send).toHaveLength(1); expect(c.replies).toEqual(finalText.trim() ? [finalText] : []); if (fail) expect(s.errors.map((e) => e.stage)).toContain('reply')
    })
  }
  for (const finalText of ['', ' \n\t ']) {
    test(`empty final without tool sends nothing: ${JSON.stringify(finalText)}`, async () => {
      const s = setup({ generate: async () => finalText })
      const c = await s.run()
      expect(c.replies).toEqual([])
      expect(s.calls.send).toEqual([])
      expect(s.errors).toEqual([])
    })
  }
  for (const fail of [false, true]) {
    test(`generation failure after quoted attempt does not send fallback, send failure=${fail}`, async () => {
      const error = new Error('generation failed')
      const s = setup({ tools: { replyMessage: true }, expectedGenerateError: error,
        send: async () => { if (fail) throw Error('ambiguous'); return { status: 'success' } },
        generate: async (o) => {
          await invoke(o.toolsets!.zappaz.replyMessage!, { messageId: 'id', text: 'hi' }).catch(() => {})
          throw error
        },
      })
      const c = await s.run()
      expect(s.calls.send).toHaveLength(1)
      expect(c.replies).toEqual([])
      expect(s.errors.map((e) => e.stage)).toEqual(fail ? ['reply', 'generate'] : ['generate'])
    })
  }
  test('tool reference becomes unusable after generation', async () => {
    let saved!: Tool
    const s = setup({ tools: { replyMessage: true }, generate: async (o) => { saved = o.toolsets!.zappaz.replyMessage! } })
    await s.run(); await expect(invoke(saved, { messageId: 'id', text: 'hi' })).rejects.toThrow(); expect(s.calls.get).toEqual([]); expect(s.calls.send).toEqual([])
  })
  test('concurrent conversations keep known ids and destinations isolated', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve }); let ready = 0
    const s = setup({ tools: { getConversationMessages: true, replyMessage: true }, lastMessages: 20, list: async (q) => ({ data: [row(`id-${q.conversationId}`, q.conversationId, `session-${q.conversationId}`)], page: { hasMore: false } }), get: async (id, q) => ({ data: row(id, q.conversationId, `session-${q.conversationId}`) }), generate: async (o, input) => {
      const tools = o.toolsets!.zappaz; await invoke(tools.getConversationMessages!, {}); if (++ready === 2) release(); await gate
      const id = String(input).includes('input-a') ? 'id-b' : 'id-a'; await invoke(tools.replyMessage!, { messageId: id, text: 'hi' })
    } })
    const a = context('a', 'session-a', 'a@g.us'); a.ctx.message.text = 'input-a'
    const b = context('b', 'session-b', 'b@g.us'); b.ctx.message.text = 'input-b'
    await Promise.all([s.run(a), s.run(b)]); expect(s.calls.get).toHaveLength(2)
    expect(s.calls.send.map((c) => (c as unknown[])[0])).toEqual(expect.arrayContaining([{ number: 'a@g.us', message: 'hi', quoted: 'id-b' }, { number: 'b@g.us', message: 'hi', quoted: 'id-a' }]))
    expect(a.replies).toEqual(['automatic response']); expect(b.replies).toEqual(['automatic response'])
  })
  test('timeout aborts lookup and prevents a late send', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let seenSignal: AbortSignal | undefined
    const s = setup({ tools: { replyMessage: true }, timeoutMs: 25, get: async (id, q, opts) => {
      seenSignal = opts.signal; await gate; return { data: row(id, q.conversationId) }
    }, generate: async (o) => { await invoke(o.toolsets!.zappaz.replyMessage!, { messageId: 'id', text: 'hi' }).catch(() => {}) } })
    const c = context(); const pending = s.handler(c.ctx)
    try { await Bun.sleep(70); expect(seenSignal?.aborted).toBe(true); expect(c.replies).toHaveLength(1) }
    finally { release(); await pending }
    expect(s.calls.send).toEqual([]); expect(s.errors.map((e) => e.stage)).toContain('timeout')
  })

})
