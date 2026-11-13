import { z } from 'zod'
import { MESSAGE_TYPES } from '@zappaz/zappaz-lite-sdk'

export interface HumanHandoffOptions {
  /** Pausa automaticamente ao receber outbound-message.upsert (envio direto pelo WhatsApp).
   * Envios pela API não acionam a pausa. Métodos manuais funcionam independentemente desta opção.
   * @default false
   */
  enabled?: boolean
  /** Duração em minutos, positiva e finita; aceita frações.
   * Cada novo envio direto pelo WhatsApp renova o prazo. Estado local, perdido ao reiniciar.
   * @default 30
   */
  pauseMinutes?: number
}

export class ConversationPausedError extends Error {
  constructor() {
    super('Conversation paused for human attendance')
    this.name = 'ConversationPausedError'
  }
}

interface ConversationState {
  revision: number
  pausedUntil: number
  receipts: Set<MessageReceipt>
}

export interface MessageReceipt {
  state: ConversationState
  revision: number
  receivedWhilePaused: boolean
  queued?: boolean
}

/** A date-based pause, with receipt versions to invalidate queues and SDK debounce batches. */
export class HumanHandoff {
  private readonly conversations = new Map<string, ConversationState>()
  private readonly receipts = new WeakMap<object, MessageReceipt>()
  readonly pauseMs: number
  readonly enabled: boolean

  constructor(options?: HumanHandoffOptions) {
    const minutes = options?.pauseMinutes ?? 30
    if (!Number.isFinite(minutes) || minutes <= 0 ||
      minutes * 60_000 > Number.MAX_SAFE_INTEGER - Date.now()) {
      throw new Error('humanHandoff.pauseMinutes must be a positive, finite duration')
    }
    this.pauseMs = minutes * 60_000
    this.enabled = options?.enabled ?? false
  }

  pause(conversationId: string): void {
    if (!conversationId.trim()) throw new Error('conversationId must not be empty')
    this.prune()
    const state = this.get(conversationId)
    state.revision++
    state.pausedUntil = Date.now() + this.pauseMs
  }

  resume(conversationId: string): void {
    const state = this.conversations.get(conversationId)
    if (state) state.pausedUntil = 0
    this.prune()
  }

  isPaused(conversationId: string): boolean {
    this.prune()
    return (this.conversations.get(conversationId)?.pausedUntil ?? 0) > Date.now()
  }

  capture(conversationId: string, message: object): MessageReceipt {
    const existing = this.receipts.get(message)
    if (existing) return existing
    this.prune()
    const state = this.get(conversationId)
    const receipt: MessageReceipt = {
      state,
      revision: state.revision,
      receivedWhilePaused: state.pausedUntil > Date.now(),
    }
    state.receipts.add(receipt)
    this.receipts.set(message, receipt)
    return receipt
  }

  canRespond(receipt: MessageReceipt): boolean {
    return !receipt.receivedWhilePaused &&
      receipt.revision === receipt.state.revision &&
      receipt.state.pausedUntil <= Date.now()
  }

  release(conversationId: string, receipt: MessageReceipt): void {
    receipt.state.receipts.delete(receipt)
    if (!receipt.state.receipts.size && receipt.state.pausedUntil <= Date.now() &&
      this.conversations.get(conversationId) === receipt.state) {
      this.conversations.delete(conversationId)
    }
  }

  releaseBuffered(): void {
    for (const state of this.conversations.values()) {
      for (const receipt of state.receipts) {
        if (!receipt.queued) state.receipts.delete(receipt)
      }
    }
    this.prune()
  }

  private get(id: string): ConversationState {
    let state = this.conversations.get(id)
    if (!state) {
      state = { revision: 0, pausedUntil: 0, receipts: new Set() }
      this.conversations.set(id, state)
    }
    return state
  }

  private prune(): void {
    for (const [id, state] of this.conversations) {
      if (!state.receipts.size && state.pausedUntil <= Date.now()) {
        this.conversations.delete(id)
      }
    }
  }
}

// onEvent payloads are unknown, even when the SDK has authenticated the webhook.
export const handoffMessageSchema = z.object({
  id: z.string().nullable(),
  messageId: z.string().nullable(),
  conversationId: z.string().nullable(),
  chatId: z.string().nullable(),
  remoteJid: z.string().nullable(),
  lid: z.string().nullable(),
  fromMe: z.boolean(),
  isGroup: z.boolean(),
  sender: z.object({ id: z.string().nullable(), name: z.string().optional() }),
  timestamp: z.string().nullable(),
  type: z.enum(MESSAGE_TYPES),
  text: z.string().optional(),
  replyTo: z.object({
    id: z.string(),
    senderId: z.string().optional(),
    type: z.enum(MESSAGE_TYPES).optional(),
    text: z.string().optional(),
  }).optional(),
})
