import { describe, expect, test } from 'bun:test'
import { Zappaz } from '@zappaz/zappaz-lite-sdk'
import { ZappazMastra, type ZappazMastraOptions } from './index.js'

describe('real SDK webhook dispatch', () => {
  test('routes validated webhooks through one SDK and integration with a dynamic ID', async () => {
    const sent: unknown[] = [], selected: string[] = [], generated: string[] = []
    const zappaz = new Zappaz({
      baseUrl: 'https://example.invalid', apiKey: 'test-key', sessionId: 'session',
      webhookSecret: 'secret',
      fetch: (async (_input: unknown, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)))
        return Response.json({ status: 'success' })
      }) as typeof fetch,
    })
    new ZappazMastra({
      zappaz,
      mastra: { getAgentById: (id: string) => ({
        async getMemory() { return undefined },
        async generate() { generated.push(id); return { text: id } },
      }) } as unknown as ZappazMastraOptions['mastra'],
      agentId: async ({ conversationId }) => {
        selected.push(conversationId)
        return conversationId === 'owner' ? 'supervisor' : 'secretary'
      },
    })
    const dispatch = (conversationId: string | null, secret = 'secret', sessionId = 'session') =>
      zappaz.handleWebhook(new Request('https://example.invalid/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zappaz-webhook-secret': secret },
        body: JSON.stringify({
          event: 'inbound-message.upsert', session: { id: sessionId, status: 'connected', jid: null },
          payload: { message: {
            id: `internal-${conversationId}`, messageId: `message-${conversationId}`,
            conversationId, chatId: 'chat@s.whatsapp.net', remoteJid: null, lid: null,
            timestamp: null, fromMe: false, isGroup: false, sender: { id: 'sender' },
            type: 'text', text: 'hello',
          } },
        }),
      }))
    expect((await dispatch('owner', 'wrong')).status).toBe(401)
    expect((await dispatch('owner', 'secret', 'wrong-session')).status).toBe(403)
    expect((await dispatch(null)).status).toBe(204)
    expect(selected).toEqual([])
    expect((await dispatch('owner')).status).toBe(204)
    expect((await dispatch('clinic')).status).toBe(204)
    expect(selected).toEqual(['owner', 'clinic'])
    expect(generated).toEqual(['supervisor', 'secretary'])
    expect(sent).toEqual([
      { number: 'chat@s.whatsapp.net', message: 'supervisor' },
      { number: 'chat@s.whatsapp.net', message: 'secretary' },
    ])
  })

  test('records a human outbound and paused inbound, then generates after resume', async () => {
    const sent: Array<{ url: string; method: string | undefined; body: unknown }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return Response.json({ status: 'success' })
    }) as typeof fetch
    const zappaz = new Zappaz({
      baseUrl: 'https://example.invalid', apiKey: 'test-key', sessionId: 'session',
      webhookSecret: 'secret', fetch: fetcher,
    })
    const saved: Array<{ role: string; threadId: string; resourceId: string; content: { parts: Array<{ text: string }> } }> = []
    const threads = new Map<string, { resourceId: string }>()
    const memory = {
      async getThreadById({ threadId }: { threadId: string }) { return threads.get(threadId) },
      async createThread({ threadId, resourceId }: { threadId: string; resourceId: string }) { threads.set(threadId, { resourceId }) },
      async saveMessages({ messages }: { messages: typeof saved }) { saved.push(...messages) },
    }
    const generated: unknown[] = []
    const agent = {
      async getMemory() { return memory },
      async generate(input: unknown, options: { memory?: unknown }) {
        generated.push({ input, memory: options.memory })
        return { text: 'automatic answer' }
      },
    }
    const integration = new ZappazMastra({
      zappaz, mastra: { getAgentById: () => agent } as unknown as ZappazMastraOptions['mastra'],
      agentId: 'agent', humanHandoff: { enabled: true },
    })
    const dispatch = (event: string, id: string, text: string, fromMe: boolean, secret = 'secret') =>
      integration.handleWebhook(new Request('https://example.invalid/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-zappaz-webhook-secret': secret },
        body: JSON.stringify({
          event, session: { id: 'session', status: 'connected', jid: null },
          payload: { message: {
            id: `internal-${id}`, messageId: id, conversationId: 'conversation', chatId: 'chat@s.whatsapp.net',
            remoteJid: null, lid: null, timestamp: '2026-01-01T00:00:00Z',
            fromMe, isGroup: false, sender: { id: 'sender' }, type: 'text', text,
          } },
        }),
      }))

    expect((await dispatch('outbound-message.upsert', 'bad', 'ignored', true, 'wrong')).status).toBe(401)
    expect(integration.isConversationPaused('conversation')).toBe(false)
    expect((await dispatch('outbound-message.upsert', 'human', 'human reply', true)).status).toBe(204)
    expect(integration.isConversationPaused('conversation')).toBe(true)
    expect((await dispatch('inbound-message.upsert', 'customer', 'customer question', false)).status).toBe(204)
    expect(saved.map((m) => [m.role, m.content.parts[0]?.text, m.threadId, m.resourceId])).toEqual([
      ['assistant', 'human reply', 'conversation', 'session'],
      ['user', 'customer question', 'conversation', 'session'],
    ])
    expect(generated).toEqual([])
    expect(sent).toEqual([])
    integration.resumeConversation('conversation')
    expect(integration.isConversationPaused('conversation')).toBe(false)
    expect((await dispatch('inbound-message.upsert', 'next', 'next question', false)).status).toBe(204)
    expect(generated).toEqual([{ input: 'next question', memory: { resource: 'session', thread: 'conversation' } }])
    expect(sent).toEqual([{
      url: 'https://example.invalid/api/v1/session/session/message/text',
      method: 'POST', body: { number: 'chat@s.whatsapp.net', message: 'automatic answer' },
    }])
    expect(saved).toHaveLength(2)
  })

  test('releases receipts for texts the SDK cannot debounce and after cancellation', async () => {
    const zappaz = new Zappaz({
      baseUrl: 'https://example.invalid', apiKey: 'test-key', sessionId: 'session',
      webhookSecret: 'secret',
      fetch: (async () => { throw new Error('unexpected network request') }) as unknown as typeof fetch,
    })
    const generated: unknown[] = []
    const agent = {
      async getMemory() { return undefined },
      async generate(input: unknown) { generated.push(input); return { text: '' } },
    }
    const integration = new ZappazMastra({
      zappaz, mastra: { getAgentById: () => agent } as unknown as ZappazMastraOptions['mastra'],
      agentId: 'agent', debounceMs: 60_000,
    })
    // The leak is otherwise unobservable: expired empty conversation states remain strongly held.
    const states = (integration as unknown as { handoff: { conversations: Map<string, unknown> } }).handoff.conversations
    const dispatch = (id: string, text: string, isGroup = false, senderId: string | null = 'sender') =>
      integration.handleWebhook(new Request('https://example.invalid/webhook', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-zappaz-webhook-secret': 'secret' },
        body: JSON.stringify({
          event: 'inbound-message.upsert', session: { id: 'session', status: 'connected', jid: null },
          payload: { message: {
            id, messageId: id, conversationId: id, chatId: 'chat', remoteJid: null, lid: null,
            timestamp: null, fromMe: false, isGroup, sender: { id: senderId }, type: 'text', text,
          } },
        }),
      }))
    try {
      expect((await dispatch('blank', ' \n ')).status).toBe(204)
      expect(states.has('blank')).toBe(false)
      // The real SDK rejects a group text without a sender after the event handler runs.
      expect((await dispatch('missing-sender', 'hello', true, null)).status).toBe(500)
      expect(states.has('missing-sender')).toBe(false)
      expect((await dispatch('buffered', 'hello')).status).toBe(204)
      expect(states.has('buffered')).toBe(true)
      integration.cancelDebounce!()
      expect(states.has('buffered')).toBe(false)
      expect((await dispatch('after-cancel', 'hello')).status).toBe(204)
      expect(states.has('after-cancel')).toBe(false)
      expect(generated).toEqual([])
    } finally {
      integration.cancelDebounce?.()
    }
  })
})
