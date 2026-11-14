# @zappaz/zappaz-mastra

Integração em memória entre o SDK Zappaz e um agente registrado no Mastra.
`handleWebhook` delega a requisição original ao SDK, preservando autenticação e
validação. Nenhum servidor Mastra é necessário.

**Beta:** API sujeita a ajustes antes da versão estável. Biblioteca ESM, com tipos
TypeScript e documentação das opções no autocomplete. Desenvolvida e testada com Bun.

## Instalação

```sh
bun add @zappaz/zappaz-mastra@beta @mastra/core @zappaz/zappaz-lite-sdk
```

`@mastra/core` e `@zappaz/zappaz-lite-sdk` são peer dependencies: usamos as instâncias
que sua aplicação já configura. A única dependência direta é `zod`.
Sem Redis, FFmpeg, conversão de áudio ou banco obrigatório para a integração.
Threads e mensagens continuam no storage do Mastra.

## Início rápido

Com um agente já registrado na sua instância `mastra`:

```ts
import { Zappaz } from '@zappaz/zappaz-lite-sdk'
import { ZappazMastra } from '@zappaz/zappaz-mastra'
import { mastra } from './mastra'

const zappaz = new Zappaz({
  baseUrl: process.env.ZAPPAZ_BASE_URL!,
  apiKey: process.env.ZAPPAZ_API_KEY!,
  sessionId: process.env.ZAPPAZ_SESSION_ID!,
  webhookSecret: process.env.ZAPPAZ_WEBHOOK_SECRET!,
})

const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'my-agent',
})

Bun.serve({
  port: 3000,
  fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname === '/webhooks/zappaz') {
      return integration.handleWebhook(request)
    }
    return new Response('Not found', { status: 404 })
  },
})
```

Configure a URL do webhook na Zappaz para receber `inbound-message.upsert`.
Para pausa automática, habilite também `outbound-message.upsert`.
Crie **uma integração por instância do SDK**, fora do handler HTTP.
Configure o segredo conforme o contrato de autenticação do SDK.

O método aceita uma `Request` Web padrão e retorna `Promise<Response>`, portanto
também funciona em rotas de outros servidores:

```ts
// Hono, se sua aplicação já o utiliza (não é dependência deste pacote):
app.post('/webhooks/zappaz', (c) => integration.handleWebhook(c.req.raw))
```

## Configuração

Todas as propriedades e tipos exportados têm descrições para consulta no editor.

| Opção | Padrão | Comportamento |
| --- | --- | --- |
| `zappaz` | obrigatório | Instância configurada do SDK Zappaz Lite |
| `mastra` | obrigatório | Instância com o agente registrado |
| `agentId` | obrigatório | ID do agente ou função síncrona/assíncrona que retorna o ID por conversa |
| `debounceMs` | desabilitado | Agrupa textos após uma janela de silêncio; inteiro positivo em ms |
| `timeoutMs` | `120000` | Prazo por execução, sem contar espera na fila |
| `maxPendingMessages` | `1000` | Total de execuções e tarefas aguardando por instância |
| `deduplication.ttlMs` | `300000` | Retenção de IDs após concluir uma tentativa |
| `deduplication.maxEntries` | `10000` | Capacidade total de IDs ativos e concluídos |
| `commandPrefix` | sem filtro | Aceita apenas textos com o prefixo, removendo-o antes da geração |
| `enableImages` | `false` | Envia imagem ao agente; exige modelo com suporte a imagens |
| `enableAudio` | `false` | Transcreve MP3 e envia texto ao agente; exige `transcribeAudio` |
| `transcribeAudio` | ausente | Função de transcrição fornecida pela aplicação |
| `allowedConversationIds` | todas | Lista de conversas permitidas; `[]` bloqueia todas |
| `errorMessages` | avisos em português | Substituições por tipo da mensagem |
| `timeoutMessage` | aviso em português | Texto para timeout quando nenhum envio começou |
| `queueFullMessage` | aviso em português | Texto para fila/capacidade de deduplicação cheia |
| `tools` | ambas desabilitadas | Tools de histórico e resposta citada |
| `humanHandoff` | automático desabilitado, 30 min | Pausa para atendimento humano |
| `onError` | ausente | Observador de erros, com etapa e identificadores da mensagem |

`timeoutMs` e `debounceMs` aceitam inteiros de 1 a 2147483647. Limites de capacidade
e TTL aceitam inteiros positivos seguros. Configurações inválidas são rejeitadas
antes do registro dos handlers. `enableAudio: true` sem transcrição também é rejeitado.
O filtro por prefixo vale somente para texto; durante a pausa o conteúdo recebido
continua sendo registrado no histórico, mesmo sem prefixo.

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'browser-agent',
  timeoutMs: 120_000,
  maxPendingMessages: 1000,
  deduplication: {
    ttlMs: 300_000,
    maxEntries: 10_000,
  },
  timeoutMessage: 'O processamento demorou demais. Tente novamente mais tarde.',
  queueFullMessage: 'Estou ocupado. Tente novamente mais tarde.',
})

```

Os valores numéricos do exemplo são os padrões. Não há Redis nem banco obrigatório
para filas ou deduplicação. O storage da memória do agente é configurado no Mastra.

## Seleção dinâmica do agente

Uma única integração pode encaminhar conversas para agentes diferentes:

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: ({ conversationId, sessionId }) =>
    conversationId === process.env.ZAPPAZ_OWNER_CONVERSATION_ID
      ? 'zappaz-bot'
      : 'secretario',
})

// Tanto o handler da integração quanto o do próprio SDK podem ser usados:
app.post('/webhooks/zappaz', (c) => zappaz.handleWebhook(c.req.raw))
```

O callback recebe `AgentResolverContext` (`conversationId` e `sessionId`) e pode
retornar `string` ou `Promise<string>`. Os tipos `AgentResolverContext` e
`AgentIdResolver` são exportados pelo pacote. IDs fixos continuam aceitos.

A seleção acontece dentro da fila e do prazo da execução, após autenticação,
validação, filtros e deduplicação. O agente selecionado é usado para a geração,
memória e tools de conversa daquela execução, sem alterar o agente de outras
conversas concorrentes. Também é selecionado para gravar histórico durante pausas
de atendimento humano. Um lote de debounce seleciona o agente uma vez.

Retornos vazios, IDs não registrados ou exceções do callback seguem o tratamento
de erro da etapa `generate` ou `memory`, sem fallback para outro agente.
Mantenha o roteamento estável se quiser continuar usando a memória do mesmo agente
ao longo da conversa. O callback não é um sinal de que uma resposta será enviada:
ele também pode ser chamado apenas para registrar histórico.

Crie a integração uma única vez, fora da rota. Não registre uma nova integração
por mensagem na mesma instância do SDK.

## Imagens e áudio MP3

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'my-agent',
  enableImages: true,
  enableAudio: true,
  transcribeAudio: async ({ audio, mimeType, fileName, signal }) => {
    // Seu serviço recebe diretamente o stream MP3 da Zappaz.
    // Substitua pelo cliente de transcrição que sua aplicação utiliza.
    return meuTranscritor.transcrever({ audio, mimeType, fileName, signal })
  },
})
```

**A Zappaz já fornece áudio em MP3. Não há conversão nem uso de FFmpeg.**
`audio` é um `Readable` do Node; o callback deve consumir o stream antes de retornar
uma transcrição não vazia e respeitar `signal`. O pacote não instala um provedor
de transcrição. O stream é fechado após o processamento.

Imagens habilitadas são baixadas pelo SDK e encaminhadas ao modelo com sua legenda.
Tipos não habilitados ou não suportados recebem um aviso configurável.
Em grupos, mensagens do usuário incluem a identificação do remetente; mensagens
citadas incluem o contexto disponível em `replyTo`.

## Erros e observabilidade

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'my-agent',
  errorMessages: {
    audio: 'Não consegui transcrever. Pode enviar em texto?',
  },
  onError: ({ stage, conversationId, messageId, error }) => {
    console.error({ stage, conversationId, messageId, error })
  },
})
```

Etapas: `download`, `transcribe`, `generate`, `reply`, `timeout`, `queue`, `history`
e `memory`. Exceções do observador são isoladas; a espera por ele é limitada a
10 segundos ou `timeoutMs`, o que for menor. Erros de autenticação/validação do
webhook são responsabilidade do SDK e podem ser observados por `onWebhookError`.

## Pausa para atendimento humano

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'browser-agent',
  humanHandoff: {
    enabled: true,      // Automação desabilitada por padrão.
    pauseMinutes: 30,  // Duração padrão, em minutos.
  },
})

integration.pauseConversation(conversationId)
integration.isConversationPaused(conversationId)
integration.resumeConversation(conversationId)
```

- A automação reage somente a `outbound-message.upsert` com `fromMe: true`;
  eventos de envio pela API não acionam a pausa. O payload é validado e o filtro
  `allowedConversationIds` continua valendo.
- Cada novo envio direto pelo WhatsApp renova a data de expiração. Reenvios de
  eventos já deduplicados não renovam o prazo.
- Os métodos manuais funcionam mesmo com `humanHandoff.enabled: false`.
- Não há timer por conversa: a data é verificada nas mensagens e consultas de
  estado, e entradas expiradas são removidas oportunisticamente.
- Pausar solicita cancelamento da execução atual, sem enviar aviso de erro ou
  timeout. Envios iniciados e efeitos externos já realizados não podem ser desfeitos.
- Tarefas pendentes e lotes antigos do debounce não voltam a responder após a
  retomada. Seu conteúdo é somente registrado na memória.
- Durante a pausa, mensagens recebidas são gravadas como `user`, e mensagens
  enviadas pelo WhatsApp como `assistant`, na thread `conversationId` e resource
  `session.id`. Nenhum rótulo de atendimento humano é acrescentado.
- As gravações usam a mesma fila por conversa e aguardam o encerramento real de
  execuções canceladas. A thread é criada quando necessário. Erros de persistência
  são reportados via `onError` com `stage: 'memory'` e permitem retry do webhook.
- O agente não executa durante a pausa. Não há download/transcrição de mídia;
  salvamos o texto/legenda disponível ou o tipo da mídia quando não há texto.
- Sem memória configurada no agente, a pausa funciona, mas não há histórico para
  persistir. A recuperação posterior respeita o `lastMessages` do Mastra.
- Após a expiração, somente novas mensagens voltam ao fluxo do agente, sem replay
  das mensagens pausadas. Reiniciar a aplicação perde as pausas em memória.
- Habilite o evento `outbound-message.upsert` no webhook da Zappaz para usar a
  automação. Respostas humanas enviadas pela API exigem pausa manual.

## Tools de histórico e resposta citada

As tools são criadas internamente e injetadas apenas nas execuções desta integração,
sem alterar as ferramentas existentes nem exigir registro manual no agente/Mastra.
As duas ficam desativadas por padrão:

```ts
const integration = new ZappazMastra({
  zappaz,
  mastra,
  agentId: 'browser-agent',
  tools: {
    getConversationMessages: true,
    replyMessage: true,
  },
})
```

- `getConversationMessages` consulta somente a conversa e sessão atuais. Retorna
  `messageId` WhatsApp, texto, tipo, remetente, `fromMe` e data de criação.
- O limite é exclusivamente o `lastMessages` efetivo da memória do agente. Não há
  opção de limite no input da tool ou na configuração da integração. Valores
  maiores que 100 são consultados em páginas. Sem memória, sem limite numérico
  positivo ou com `lastMessages: false`, a tool retorna um histórico vazio.
- A listagem é solicitada por `conversationId` também para grupos. O suporte
  efetivo a esses históricos ainda depende da API Zappaz e precisa ser validado
  numa sessão real.
- `replyMessage({ messageId, text })` cita uma mensagem da conversa atual. IDs não
  obtidos na consulta da execução são verificados por uma busca restrita à conversa.
- O destino nunca é escolhido pelo modelo. O UUID interno da mensagem não substitui
  o `messageId` WhatsApp.
- Cada execução permite uma tentativa de resposta citada. O loop do agente continua:
  texto final não vazio é enviado como complemento. Texto final vazio ou contendo
  apenas espaços nunca é enviado, com ou sem uso da tool. Não há retry automático
  do envio pela tool.
- Se a geração falhar após a tentativa de resposta citada, não enviamos um fallback
  adicional; um texto final explícito retornado normalmente pelo agente pode ser enviado.
- Sem chamar a tool de resposta, o agente responde normalmente, sem citação.
- As tools respeitam o prazo e cancelamento da execução. `onError` recebe
  `stage: 'history'` para falhas na consulta e `'reply'` para falhas no envio.

## Fila e timeout

- Uma tarefa por vez para cada `conversationId`; conversas diferentes são paralelas.
- O limite é global por instância e inclui tarefas em execução e aguardando.
- Um lote do debounce conta como uma tarefa. O limite não controla o buffer interno
  do debounce no SDK, nem define um limite de bytes para mensagens ou mídias.
- O timeout começa na execução, não durante a espera. Download, transcrição,
  geração e entrega participam do prazo.
- Downloads e geração recebem um sinal de cancelamento. `transcribeAudio` também
  recebe `signal`; implementações personalizadas devem respeitá-lo.
- Após timeout não há resposta tardia nem nova tentativa automática. Se o envio
  de uma resposta já começou, não enviamos outro aviso: a entrega pode ter ocorrido.
- Código que ignora o cancelamento não pode ser encerrado à força. Sua vaga e
  conversa permanecem ocupadas até ele terminar, evitando execuções sobrepostas.
- Quando a fila está cheia, novas entradas são rejeitadas sem reservar suas chaves.
  Há no máximo um aviso de sobrecarga em andamento fora da fila.
- `onError` informa `stage: 'timeout'` ou `'queue'`, além das etapas de processamento.

## Deduplicação

- Chave: sessão + conversa + `messageId` WhatsApp, nunca hash do conteúdo.
- Duplicatas em execução, aguardando ou concluídas são ignoradas.
- Cada mensagem do lote de debounce é deduplicada antes de compor a entrada.
- IDs ausentes não recebem uma chave inventada e não têm proteção de deduplicação.
- Entradas concluídas expiram após o TTL e as mais antigas podem ser removidas
  antes dele ao atingir o limite. Entradas em andamento não são removidas.
- Tentativas com falha ou timeout também são retidas: uma ferramenta pode ter
  realizado efeitos externos antes da falha. Não há garantia de exactly-once.
- Reiniciar a aplicação perde fila e deduplicação; várias instâncias não as compartilham.

## Limites operacionais da beta

- A integração mantém estado somente no processo. Múltiplas réplicas não coordenam
  pausas, filas, debounce nem deduplicação entre si.
- Sem debounce, o webhook pode aguardar a execução. Com debounce, o SDK confirma o
  recebimento antes de processar o lote: não é uma fila durável e falhas posteriores
  são reportadas pelos callbacks, sem retry garantido pelo webhook.
- Cancelar a geração não garante que o Mastra já tenha salvo a entrada em execução.
  A integração não a reinsere automaticamente para evitar duplicação.
- `cancelDebounce?.()` descarta lotes e desativa o debounce dessa integração;
  não cancela execuções ativas nem remove os demais handlers.
- Não há teste com conta WhatsApp real automatizado. A suíte usa também o SDK real
  com transporte HTTP e agente controlados, sem chamadas a provedores externos.

## Desenvolvimento

```sh
bun install
bun run typecheck
bun test src
bun run build
bun pm pack --dry-run
```

Organização: `index.ts` coordena os handlers e execuções; `execution.ts` contém
deduplicação e cancelamento; `human-handoff.ts` mantém as pausas e revisões;
`conversation-memory.ts` persiste mensagens externas; `conversation-tools.ts`
cria tools limitadas à execução atual.

O build publica JavaScript ESM e declarações `.d.ts`, sem testes ou código da aplicação.
Tipos públicos: `ZappazMastraOptions`, `DeduplicationOptions`, `HumanHandoffOptions`,
`ConversationToolsOptions`, `TranscribeAudioInput` e `ZappazMastraErrorContext`.

## Licença

MIT.
