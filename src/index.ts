import { Readable } from 'node:stream'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Agent } from '@mastra/core/agent'
import type { Mastra } from '@mastra/core/mastra'
import { MESSAGE_TYPES } from '@zappaz/zappaz-lite-sdk'
import type { DebouncedTextContext, MessageContext, MessageType, WebhookEnvelope, Zappaz } from '@zappaz/zappaz-lite-sdk'
import { abortable, ExecutionTimeoutError, MessageDeduplicator, positiveInteger, track, type Execution } from './execution.js'
import { createConversationTools, type ConversationToolsOptions } from './conversation-tools.js'
import { ConversationPausedError, handoffMessageSchema, HumanHandoff, type HumanHandoffOptions } from './human-handoff.js'
import { saveConversationMessages } from './conversation-memory.js'

export type { ConversationToolsOptions } from './conversation-tools.js'
export type { HumanHandoffOptions } from './human-handoff.js'

export interface ZappazMastraErrorContext {
  /** Erro original da etapa; pode ser qualquer valor lançado pelo SDK ou agente. */
  error: unknown
  /** Etapa que falhou. Cancelamentos por atendimento humano não são reportados como erro. */
  stage: 'download' | 'transcribe' | 'generate' | 'reply' | 'timeout' | 'queue' | 'history' | 'memory'
  /** ID da sessão Zappaz, também usado como resource da memória Mastra. */
  sessionId: string
  /** ID da conversa Zappaz, também usado como thread da memória Mastra. */
  conversationId: string | null
  /** ID WhatsApp da mensagem, não o UUID interno do registro. */
  messageId: string | null
  /** Tipo da mensagem que originou a execução. */
  messageType: MessageType
}

const defaultErrorMessages: Record<MessageType, string> = {
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

export interface TranscribeAudioInput {
  /** Stream do áudio fornecido pela Zappaz (MP3), sem conversão. Consuma durante o callback. */
  audio: Readable
  /** MIME retornado pelo download, com fallback para os metadados da mensagem. */
  mimeType?: string
  /** Nome de arquivo, quando informado pela Zappaz. */
  fileName?: string
  /** Respeite este sinal para cancelar a transcrição em timeout ou atendimento humano. */
  signal?: AbortSignal
}

/** Retenção local de IDs WhatsApp. Não persiste após reiniciar o processo. */
export interface DeduplicationOptions {
  /** Tempo de retenção após concluir a tentativa, em milissegundos. @default 300000 */
  ttlMs?: number
  /** Máximo de IDs ativos e concluídos. Entradas concluídas podem ser removidas antes do TTL. @default 10000 */
  maxEntries?: number
}

/** Identificadores do webhook validado pelo SDK, usados para selecionar o agente. */
export interface AgentResolverContext {
  conversationId: string
  sessionId: string
}

export type AgentIdResolver = (context: AgentResolverContext) => string | Promise<string>

/** Configuração da integração. Crie apenas uma integração por instância do SDK Zappaz. */
export interface ZappazMastraOptions {
  /** Instância autenticada do SDK. A integração registra handlers nela. */
  zappaz: Zappaz
  /** Instância Mastra com o agente já registrado; não exige servidor Mastra. */
  mastra: Mastra
  /** ID registrado no Mastra ou função que seleciona o ID por execução/conversa.
   * A função também é usada na gravação de histórico durante atendimento humano.
   */
  agentId: string | AgentIdResolver
  /** Janela de silêncio em milissegundos para agrupar textos por conversa/remetente.
   * Omitir desativa o debounce. Inteiro entre 1 e 2147483647.
   */
  debounceMs?: number
  /** Prazo da execução em milissegundos, sem contar a espera na fila. @default 120000 */
  timeoutMs?: number
  /** Limite de tarefas em execução e aguardando por instância. Um lote conta como uma tarefa. @default 1000 */
  maxPendingMessages?: number
  /** Deduplicação local por sessão, conversa e ID WhatsApp. Padrões: 5 minutos, 10000 IDs. */
  deduplication?: DeduplicationOptions
  /** Aviso enviado ao expirar a execução, se nenhum envio tiver começado. */
  timeoutMessage?: string
  /** Aviso enviado quando a fila ou a capacidade de deduplicação estiver cheia. */
  queueFullMessage?: string
  /** Filtra somente textos pelo prefixo e o remove antes da geração. Omitir aceita qualquer texto. */
  commandPrefix?: string
  /** Encaminha imagens ao agente. Requer modelo com suporte a imagens. @default false */
  enableImages?: boolean
  /** Habilita áudio MP3 via transcribeAudio, obrigatório quando ativado. @default false */
  enableAudio?: boolean
  /** Restringe processamento e histórico a estas conversas. Omitir permite todas; [] bloqueia todas. */
  allowedConversationIds?: readonly string[]
  /** Transcreve áudio em texto não vazio. Obrigatório com enableAudio; respeite input.signal.
   * Nenhum provedor de transcrição é instalado ou configurado pelo pacote.
   */
  transcribeAudio?: (input: TranscribeAudioInput) => Promise<string>
  /** Substitui avisos por tipo de mensagem. Tipos não informados usam os padrões em português. */
  errorMessages?: Partial<Record<MessageType, string>>
  /** Tools opcionais injetadas somente nas execuções Zappaz. Ambas desabilitadas por padrão. */
  tools?: ConversationToolsOptions
  /** Pausa automática por envio direto no WhatsApp. Padrão: desabilitada, duração de 30 minutos. */
  humanHandoff?: HumanHandoffOptions
  /** Observador de erros. Exceções do callback são isoladas; espera limitada a 10s ou timeoutMs.
   * Não implemente reenvio automático aqui: a entrega anterior pode ter ocorrido.
   */
  onError?: (context: ZappazMastraErrorContext) => void | Promise<void>
}

/** Conecta um agente existente aos webhooks Zappaz, com execução serial por conversa. */
export class ZappazMastra {
  private readonly agent?: Agent
  private readonly mastra: Mastra
  private readonly agentId: ZappazMastraOptions['agentId']
  private readonly zappaz: Zappaz
  private readonly allowedConversationIds?: ReadonlySet<string>
  private readonly transcribeAudio?: ZappazMastraOptions['transcribeAudio']
  private readonly errorMessages: Partial<Record<MessageType, string>>
  private readonly commandPrefix?: string
  private readonly onError?: ZappazMastraOptions['onError']
  private readonly conversationQueues = new Map<string, Promise<void>>()
  private readonly execution = new AsyncLocalStorage<Execution>()
  private readonly timeoutMs: number
  private readonly maxPendingMessages: number
  private readonly deduplicator: MessageDeduplicator
  private readonly timeoutMessage: string
  private readonly queueFullMessage: string
  private pendingMessages = 0
  private overflowNoticePending = false
  private readonly toolOptions: ConversationToolsOptions
  private readonly handoff: HumanHandoff
  private readonly activeControllers = new Map<string, AbortController>()
  private debounceActive: boolean | undefined
  /** Descarta lotes e desativa definitivamente o debounce registrado. Não encerra execuções ativas.
   * Disponível somente quando debounceMs foi configurado.
   */
  readonly cancelDebounce?: () => void

  /** Registra os handlers no SDK. Crie apenas uma vez por instância Zappaz. */
  constructor({
    zappaz,
    mastra,
    agentId,
    debounceMs,
    timeoutMs = 120_000,
    maxPendingMessages = 1000,
    deduplication,
    timeoutMessage = 'O processamento demorou mais que o esperado. Por favor, tente novamente mais tarde.',
    queueFullMessage = 'Estou com muitos atendimentos no momento. Por favor, tente novamente mais tarde.',
    commandPrefix,
    enableImages = false,
    enableAudio = false,
    allowedConversationIds,
    transcribeAudio,
    errorMessages,
    onError,
    tools,
    humanHandoff,
  }: ZappazMastraOptions) {
    if (debounceMs !== undefined) positiveInteger('debounceMs', debounceMs, 2_147_483_647)
    if (enableAudio && typeof transcribeAudio !== 'function') {
      throw new Error('transcribeAudio is required when enableAudio is true')
    }
    if (commandPrefix !== undefined && !commandPrefix.trim()) {
      throw new Error('commandPrefix must not be empty or whitespace')
    }
    this.timeoutMs = positiveInteger('timeoutMs', timeoutMs, 2_147_483_647)
    this.maxPendingMessages = positiveInteger('maxPendingMessages', maxPendingMessages)
    this.toolOptions = { ...tools }
    this.handoff = new HumanHandoff(humanHandoff)
    this.deduplicator = new MessageDeduplicator(
      positiveInteger('deduplication.ttlMs', deduplication?.ttlMs ?? 300_000),
      positiveInteger('deduplication.maxEntries', deduplication?.maxEntries ?? 10_000),
    )
    this.timeoutMessage = timeoutMessage
    this.queueFullMessage = queueFullMessage
    if (typeof agentId !== 'string' && typeof agentId !== 'function') {
      throw new Error('agentId must be a string or a function')
    }
    if (typeof agentId === 'string' && !agentId.trim()) {
      throw new Error('agentId must be a non-empty string')
    }
    this.mastra = mastra
    this.agentId = agentId
    this.agent = typeof agentId === 'string' ? mastra.getAgentById(agentId) : undefined
    this.zappaz = zappaz
    this.transcribeAudio = transcribeAudio
    this.errorMessages = { ...errorMessages }
    this.commandPrefix = commandPrefix
    this.onError = onError
    this.allowedConversationIds = allowedConversationIds === undefined
      ? undefined
      : new Set(allowedConversationIds)

    zappaz.onEvent((event) => this.handleEvent(event))

    for (const type of MESSAGE_TYPES) {
      if (type === 'text') continue

      zappaz.onMessage(type, (ctx) => this.enqueue(ctx, async () => {
        if (ctx.message.type === 'image' && enableImages) {
          await this.handleResponse(ctx, () => this.handleImage({
            ...ctx, message: { ...ctx.message, type: 'image' },
          }))
        } else if (ctx.message.type === 'audio' && enableAudio) {
          await this.handleResponse(ctx, () => this.handleAudio({
            ...ctx, message: { ...ctx.message, type: 'audio' },
          }))
        } else {
          await this.reply(ctx, this.getErrorMessage(ctx.message.type))
        }
      }))
    }

    if (debounceMs !== undefined) {
      this.debounceActive = true
      const cancel = zappaz.onTextDebounced(
        { delayMs: debounceMs },
        (ctx) => this.handleDebounce(ctx),
      )
      this.cancelDebounce = () => {
        cancel()
        this.debounceActive = false
        this.handoff.releaseBuffered()
      }
    } else {
      zappaz.onMessage('text', (ctx) => {
        const receipt = ctx.message.chatId && ctx.message.conversationId && this.isConversationAllowed(ctx.message.conversationId)
          ? this.handoff.capture(ctx.message.conversationId, ctx.message)
          : undefined
        if (!this.getText(ctx.message) && (!receipt || this.handoff.canRespond(receipt))) {
          if (receipt) this.handoff.release(ctx.message.conversationId!, receipt)
          return
        }
        return this.enqueue(ctx, () => this.handleText(ctx))
      })
    }
  }

  /** Delega a Request original ao SDK, preservando validação e autenticação do webhook. */
  handleWebhook(request: Request): Promise<Response> {
    return this.zappaz.handleWebhook(request)
  }

  /** Pausa ou renova a pausa por humanHandoff.pauseMinutes e cancela a execução atual.
   * Funciona mesmo quando a pausa automática está desabilitada.
   */
  pauseConversation(conversationId: string): void {
    this.handoff.pause(conversationId)
    this.activeControllers.get(conversationId)?.abort(new ConversationPausedError())
  }

  /** Retoma o atendimento de novas mensagens. Não reexecuta mensagens antigas ou pausadas. */
  resumeConversation(conversationId: string): void {
    this.handoff.resume(conversationId)
  }

  /** Consulta a pausa considerando sua expiração; não cria timers. */
  isConversationPaused(conversationId: string): boolean {
    return this.handoff.isPaused(conversationId)
  }

  private async handleEvent(event: WebhookEnvelope): Promise<void> {
    const outbound = event.event === 'outbound-message.upsert'
    if ((!outbound && event.event !== 'inbound-message.upsert') ||
      (outbound && !this.handoff.enabled)) return
    if (typeof event.payload !== 'object' || event.payload === null ||
      !('message' in event.payload) ||
      typeof event.payload.message !== 'object' || event.payload.message === null) return

    const result = handoffMessageSchema.safeParse(event.payload.message)
    if (!result.success) return
    const message = result.data
    const conversationId = message.conversationId
    if (!conversationId || !message.chatId || !this.isConversationAllowed(conversationId) ||
      (outbound ? !message.fromMe : message.fromMe)) return

    const receipt = this.handoff.capture(conversationId, event.payload.message)
    if (!outbound && this.handoff.canRespond(receipt)) {
      // The SDK never dispatches these texts to its debounce callback.
      if (message.type === 'text' && this.debounceActive !== undefined &&
        (!this.debounceActive || !message.text?.trim() || (message.isGroup && !message.sender.id))) {
        this.handoff.release(conversationId, receipt)
      }
      return
    }

    const key = this.messageKey(event.session.id, message)
    if (outbound) {
      // Replayed outbound webhooks must not extend the pause a second time.
      if (key && this.deduplicator.has(key)) {
        this.handoff.release(conversationId, receipt)
        return
      }
      this.pauseConversation(conversationId)
    }

    const ctx: MessageContext = {
      message,
      session: event.session,
      event: 'inbound-message.upsert',
      reply: (text) => this.zappaz.messages.sendText({ number: message.chatId!, message: text }),
    }
    try {
      await this.enqueue(ctx, async () => {}, undefined, [message], outbound ? 'assistant' : 'user')
    } finally {
      // The SDK dispatches the original object to onMessage/debounce after onEvent.
      this.handoff.release(conversationId, receipt)
    }
  }

  private async handleDebounce(ctx: DebouncedTextContext): Promise<void> {
    try {
      await this.processDebounce(ctx)
    } finally {
      for (const message of ctx.messages) {
        if (!message.conversationId || !this.isConversationAllowed(message.conversationId)) continue
        this.handoff.release(
          message.conversationId,
          this.handoff.capture(message.conversationId, message),
        )
      }
    }
  }

  private async processDebounce(ctx: DebouncedTextContext): Promise<void> {
    const paused: MessageContext['message'][] = []
    const eligible = ctx.messages.filter((message) => {
      if (!message.conversationId || !this.isConversationAllowed(message.conversationId)) return false
      const receipt = this.handoff.capture(message.conversationId, message)
      if (!this.handoff.canRespond(receipt)) {
        paused.push(message)
        return false
      }
      if (!this.isConversationAllowed(message.conversationId) || !this.getText(message)) {
        this.handoff.release(message.conversationId, receipt)
        return false
      }
      return true
    })
    for (const message of paused) {
      await this.enqueue({ ...ctx, message }, async () => {})
    }
    const batchKeys = new Set<string>()
    const messages = eligible.filter((message) =>
      this.isConversationAllowed(message.conversationId) && !!this.getText(message) &&
      this.acceptBatchMessage(ctx.session.id, message, batchKeys),
    )
    const message = messages.at(-1)
    if (!message) {
      for (const item of eligible) {
        this.handoff.release(item.conversationId!, this.handoff.capture(item.conversationId!, item))
      }
      return
    }
    for (const item of eligible) {
      if (!messages.includes(item)) {
        this.handoff.release(item.conversationId!, this.handoff.capture(item.conversationId!, item))
      }
    }

    const text = messages
      .map((message) => {
        const text = this.getText(message)
        return text ? this.formatUserMessage(message, text) : ''
      })
      .filter(Boolean)
      .join('\n')

    if (!text) return

    const messageContext: MessageContext<'text'> = {
      session: ctx.session,
      event: ctx.event,
      reply: ctx.reply,
      message,
    }

    await this.enqueue(messageContext, () => this.respond(messageContext, text), [...batchKeys], messages)
  }

  private async enqueue(
    ctx: MessageContext,
    process: () => Promise<void>,
    batchKeys?: string[],
    messages: MessageContext['message'][] = [ctx.message],
    recordRole?: 'user' | 'assistant',
  ): Promise<void> {
    const { chatId, conversationId } = ctx.message
    if (!chatId || !conversationId || !this.isConversationAllowed(conversationId)) return
    const receipts = messages.map((message) => this.handoff.capture(conversationId, message))
    for (const receipt of receipts) receipt.queued = true
    let recordFailed = false
    const recording = () => recordRole !== undefined ||
      receipts.some((receipt) => !this.handoff.canRespond(receipt))

    try {
      const key = this.messageKey(ctx.session.id, ctx.message)
      const keys = batchKeys ?? (key ? [key] : [])
      if (keys.some((key) => this.deduplicator.has(key))) return

      if (this.pendingMessages >= this.maxPendingMessages || !this.deduplicator.reserve(keys)) {
        if (recording()) {
          const error = new Error('Pending message limit reached while recording paused conversation')
          await this.notifyError(ctx, 'queue', error)
          throw error
        }
        await this.handleOverflow(ctx, () => receipts.every((receipt) => this.handoff.canRespond(receipt)))
        return
      }
      this.pendingMessages++

      const previous = this.conversationQueues.get(conversationId) ?? Promise.resolve()
      const current = previous.then(() => {
        if (!recording()) return this.execute(ctx, process)
        return this.execute(
          ctx,
          () => this.saveConversationMessages(ctx, messages, recordRole ?? 'user'),
          true,
        ).catch((error) => {
          recordFailed = true
          throw error
        })
      })
      // Keep the queue usable after failures, while reporting the original error to the SDK.
      const tail = current.then(() => undefined, () => undefined)
      this.conversationQueues.set(conversationId, tail)

      try {
        await current
      } finally {
        this.pendingMessages--
        // Retain agent attempts after failures; failed memory writes may be retried.
        if (recordFailed) this.deduplicator.release(keys)
        else this.deduplicator.complete(keys)
        if (this.conversationQueues.get(conversationId) === tail) {
          this.conversationQueues.delete(conversationId)
        }
      }
    } finally {
      for (const receipt of receipts) this.handoff.release(conversationId, receipt)
    }
  }

  private async saveConversationMessages(
    ctx: MessageContext,
    messages: MessageContext['message'][],
    role: 'user' | 'assistant',
  ): Promise<void> {
    await this.runStage(ctx, 'memory', async (signal) => {
      const agent = await this.resolveAgent(ctx, signal)
      await saveConversationMessages({
        agent,
        ctx,
        messages,
        role,
        signal,
        formatUserMessage: (message, text) => this.formatUserMessage(message, text),
      })
    })
  }

  private async resolveAgent(ctx: MessageContext, signal?: AbortSignal): Promise<Agent> {
    if (this.agent) return this.agent
    const conversationId = ctx.message.conversationId
    if (!conversationId) throw new Error('Message has no conversation ID')
    const agentId = typeof this.agentId === 'function'
      ? await this.agentId({ conversationId, sessionId: ctx.session.id })
      : this.agentId
    signal?.throwIfAborted()
    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw new Error('agentId resolver must return a non-empty string')
    }
    return this.mastra.getAgentById(agentId)
  }

  private messageKey(sessionId: string, message: MessageContext['message']): string | undefined {
    if (!message.messageId || !message.conversationId) return
    return JSON.stringify([sessionId, message.conversationId, message.messageId])
  }

  private acceptBatchMessage(
    sessionId: string,
    message: MessageContext['message'],
    keys: Set<string>,
  ): boolean {
    const key = this.messageKey(sessionId, message)
    if (!key) return true
    if (keys.has(key) || this.deduplicator.has(key)) return false
    keys.add(key)
    return true
  }

  private async handleOverflow(ctx: MessageContext, canRespond: () => boolean): Promise<void> {
    // At most one out-of-queue notice may be in flight globally.
    if (this.overflowNoticePending) return
    this.overflowNoticePending = true
    let delivery: Promise<unknown> | undefined
    try {
      await this.notifyError(ctx, 'queue', new Error('Pending message limit reached'))
      if (!canRespond()) return
      delivery = Promise.resolve().then(() => {
        if (!canRespond()) return
        return ctx.reply(this.queueFullMessage)
      })
      await abortable(
        delivery,
        AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      )
    } catch (error) {
      await this.notifyError(ctx, 'reply', error)
      throw error
    } finally {
      if (delivery) {
        // Even if the notice times out, do not accumulate more unabortable deliveries.
        void delivery.then(
          () => { this.overflowNoticePending = false },
          () => { this.overflowNoticePending = false },
        )
      } else {
        this.overflowNoticePending = false
      }
    }
  }

  private async execute(
    ctx: MessageContext,
    process: () => Promise<void>,
    silent = false,
  ): Promise<void> {
    const controller = new AbortController()
    const conversationId = ctx.message.conversationId!
    if (!silent) this.activeControllers.set(conversationId, controller)
    const state: Execution = {
      signal: controller.signal,
      pending: new Set(),
      deliveryStarted: false,
    }
    const timer = setTimeout(() => {
      controller.abort(new ExecutionTimeoutError(this.timeoutMs))
    }, this.timeoutMs)

    try {
      await this.execution.run(state, async () => {
        try {
          await abortable(Promise.resolve().then(process), state.signal)
        } catch (error) {
          if (!state.signal.aborted) throw error
          if (state.signal.reason instanceof ConversationPausedError) return
          await this.notifyError(ctx, 'timeout', state.signal.reason)
          if (silent) throw state.signal.reason
          if (!this.handoff.canRespond(this.handoff.capture(conversationId, ctx.message))) return
          // An already-started delivery may have succeeded remotely; do not send twice.
          if (!state.deliveryStarted) {
            state.deliveryStarted = true
            const notice = track(state, ctx.reply(this.timeoutMessage))
            try {
              await abortable(notice, AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)))
            } catch (error) {
              await this.notifyError(ctx, 'reply', error)
              throw error
            }
          }
        }
      })
    } finally {
      clearTimeout(timer)
      // Cancellation cannot forcibly stop user code. Keep its slot and conversation locked
      // until outstanding work settles, even if it ignores the AbortSignal.
      await Promise.allSettled([...state.pending])
      if (this.activeControllers.get(conversationId) === controller) {
        this.activeControllers.delete(conversationId)
      }
    }
  }

  private async handleText(ctx: MessageContext<'text'>): Promise<void> {
    const text = this.getText(ctx.message)

    if (!text || !this.isConversationAllowed(ctx.message.conversationId)) return

    await this.respond(ctx, this.formatUserMessage(ctx.message, text))
  }

  private async handleResponse(
    ctx: MessageContext,
    process: () => Promise<string>,
  ): Promise<void> {
    if (!ctx.message.chatId ||
      !this.isConversationAllowed(ctx.message.conversationId)) return

    let text: string
    try {
      text = await process()
      if (!text.trim()) return
    } catch {
      this.execution.getStore()?.signal.throwIfAborted()
      if (this.execution.getStore()?.toolReplyAttempted) return
      text = this.getErrorMessage(ctx.message.type)
    }

    // Keep delivery errors outside the processing catch to avoid a second send.
    await this.reply(ctx, text)
  }

  private async handleImage(ctx: MessageContext<'image'>): Promise<string> {
    const { messageId } = ctx.message

    const { data, mimeType } = await this.runStage(ctx, 'download', async (signal) => {
      if (!messageId) throw new Error('Image message has no WhatsApp message ID')
      const result = await this.zappaz.messages.getMediaBase64(messageId, { signal })
      const mimeType = result.data.mimeType ?? ctx.message.media?.mimeType
      if (!result.data.media || !mimeType?.startsWith('image/')) {
        throw new Error('Zappaz returned an empty image or an invalid image MIME type')
      }
      return { data: result.data, mimeType }
    })

    const caption = this.formatUserMessage(
      ctx.message,
      ctx.message.text?.trim() || (ctx.message.isGroup ? 'Imagem' : ''),
    )

    return this.generateResponse(ctx, [{
      role: 'user',
      content: [
        {
          type: 'image',
          image: data.media,
          mimeType,
        },
        ...(caption ? [{ type: 'text' as const, text: caption }] : []),
      ],
    }])
  }

  private async handleAudio(ctx: MessageContext<'audio'>): Promise<string> {
    const { messageId, media } = ctx.message
    const transcribeAudio = await this.runStage(ctx, 'transcribe', async () => {
      if (!this.transcribeAudio) throw new Error('Audio transcription is not configured')
      return this.transcribeAudio
    })

    const file = await this.runStage(ctx, 'download', async (signal) => {
      if (!messageId) throw new Error('Audio message has no WhatsApp message ID')
      const result = await this.zappaz.messages.getMediaBinary(messageId, { signal })
      if (!result.data.byteLength) throw new Error('Zappaz returned an empty audio file')
      return result
    })

    const audio = Readable.from([Buffer.from(file.data)])

    try {
      const text = await this.runStage(ctx, 'transcribe', async (signal) => {
        const transcription = await transcribeAudio({
          audio,
          mimeType: file.headers.get('content-type') ?? media?.mimeType,
          fileName: media?.fileName,
          signal,
        })
        if (typeof transcription !== 'string' || !transcription.trim()) {
          throw new Error('transcribeAudio must return a non-empty text transcription')
        }
        return transcription.trim()
      })

      return await this.generateResponse(
        ctx,
        this.formatUserMessage(ctx.message, `Áudio: ${text}`),
      )
    } finally {
      audio.destroy()
    }
  }

  private formatUserMessage(
    message: MessageContext['message'],
    text: string,
  ): string {
    if (message.replyTo) {
      const { id, senderId, type, text: quotedText } = message.replyTo
      text = `Mensagem citada (contexto): ${JSON.stringify({
        id, senderId, type, text: quotedText,
      })}\nMensagem atual: ${text}`
    }

    if (!message.isGroup) return text

    const sender = (message.sender.name?.trim() || message.sender.id || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')

    return `<user>${sender}</user>: ${text}`
  }

  private isConversationAllowed(conversationId: string | null): boolean {
    return !!conversationId && (
      this.allowedConversationIds === undefined ||
      this.allowedConversationIds.has(conversationId)
    )
  }

  private async respond(
    ctx: MessageContext,
    input: Parameters<Agent['generate']>[0],
  ): Promise<void> {
    const { chatId, conversationId } = ctx.message
    if (!chatId || !conversationId) return
    if (!this.isConversationAllowed(conversationId)) return

    await this.handleResponse(ctx, () => this.generateResponse(ctx, input))
  }

  private async generateResponse(
    ctx: MessageContext,
    input: Parameters<Agent['generate']>[0],
  ): Promise<string> {
    const conversationId = ctx.message.conversationId
    if (!conversationId) throw new Error('Message has no conversation ID')

    return this.runStage(ctx, 'generate', async (signal) => {
      const agent = await this.resolveAgent(ctx, signal)
      const memory = await agent.getMemory()
      signal?.throwIfAborted()
      const enabled = this.toolOptions.getConversationMessages || this.toolOptions.replyMessage
      const state = this.execution.getStore()
      const lastMessages = enabled
        ? memory?.getMergedThreadConfig().lastMessages
        : undefined
      const historyLimit =
        typeof lastMessages === 'number' && Number.isSafeInteger(lastMessages) && lastMessages > 0
          ? lastMessages
          : 0
      const conversationTools = enabled ? createConversationTools({
        zappaz: this.zappaz,
        ctx,
        options: this.toolOptions,
        historyLimit,
        assertActive: () => {
          if (!state) throw new Error('Conversation tools require an active Zappaz execution')
          state.signal.throwIfAborted()
        },
        markReplyAttempted: () => {
          if (!state) throw new Error('Conversation tools require an active Zappaz execution')
          state.signal.throwIfAborted()
          state.toolReplyAttempted = true
          state.deliveryStarted = true
        },
        runStage: (stage, process) => this.runStage(ctx, stage, process),
      }) : undefined

      try {
        const result = await agent.generate(input, {
          abortSignal: signal,
          ...(conversationTools && { toolsets: { zappaz: conversationTools.tools } }),
          ...(memory && {
            memory: {
              resource: ctx.session.id,
              thread: conversationId,
            },
          }),
        })

        return result.text
      } finally {
        conversationTools?.close()
      }
    })
  }

  private getText(message: MessageContext['message']): string | undefined {
    const text = message.text?.trim()
    if (!text) return
    if (this.commandPrefix === undefined) return text
    if (!text.startsWith(this.commandPrefix)) return
    return text.slice(this.commandPrefix.length).trim() || undefined
  }

  private getErrorMessage(type: MessageType): string {
    return this.errorMessages[type] ?? defaultErrorMessages[type]
  }

  private async reply(ctx: MessageContext, text: string): Promise<void> {
    const state = this.execution.getStore()
    state?.signal.throwIfAborted()
    if (state) state.deliveryStarted = true
    await this.runStage(ctx, 'reply', () => ctx.reply(text))
  }

  private async runStage<T>(
    ctx: MessageContext,
    stage: ZappazMastraErrorContext['stage'],
    process: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const state = this.execution.getStore()
    try {
      state?.signal.throwIfAborted()
      const promise = Promise.resolve().then(() => {
        state?.signal.throwIfAborted()
        return process(state?.signal)
      })
      return state
        ? await abortable(track(state, promise), state.signal)
        : await promise
    } catch (error) {
      if (state?.signal.aborted) throw state.signal.reason
      await this.notifyError(ctx, stage, error)
      throw error
    }
  }

  private async notifyError(
    ctx: MessageContext,
    stage: ZappazMastraErrorContext['stage'],
    error: unknown,
  ): Promise<void> {
    if (!this.onError) return
    try {
      await abortable(Promise.resolve().then(() => this.onError?.({
          error,
          stage,
          sessionId: ctx.session.id,
          conversationId: ctx.message.conversationId,
          messageId: ctx.message.messageId,
          messageType: ctx.message.type,
      })), AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)))
    } catch {
      // An error observer must not prevent fallback delivery or retain the queue indefinitely.
    }
  }
}
