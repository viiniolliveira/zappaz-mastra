import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@mastra/core/agent'
import type { MessageContext } from '@zappaz/zappaz-lite-sdk'

interface SaveConversationMessagesInput {
  agent: Agent
  ctx: MessageContext
  messages: MessageContext['message'][]
  role: 'user' | 'assistant'
  signal?: AbortSignal
  formatUserMessage: (message: MessageContext['message'], text: string) => string
}

/** Writes external messages without executing the agent. The caller owns queue serialization. */
export async function saveConversationMessages({
  agent, ctx, messages, role, signal, formatUserMessage,
}: SaveConversationMessagesInput): Promise<void> {
  const memory = await agent.getMemory()
  if (!memory) return
  signal?.throwIfAborted()
  const threadId = ctx.message.conversationId!
  const thread = await memory.getThreadById({ threadId })
  signal?.throwIfAborted()
  if (thread && thread.resourceId !== ctx.session.id) {
    throw new Error('Conversation thread belongs to a different resource')
  }
  if (!thread) await memory.createThread({ threadId, resourceId: ctx.session.id })
  signal?.throwIfAborted()
  await memory.saveMessages({
    messages: messages.map((message) => {
      const date = message.timestamp ? new Date(message.timestamp) : new Date()
      const text = message.text?.trim() || `[${message.type}]`
      return {
        id: `zappaz-${createHash('sha256').update(JSON.stringify([
          ctx.session.id, threadId, message.messageId ?? message.id ?? randomUUID(), role,
        ])).digest('hex')}`,
        threadId,
        resourceId: ctx.session.id,
        role,
        createdAt: Number.isNaN(date.getTime()) ? new Date() : date,
        content: {
          format: 2 as const,
          parts: [{
            type: 'text' as const,
            text: role === 'user' ? formatUserMessage(message, text) : text,
          }],
        },
      }
    }),
  })
}
