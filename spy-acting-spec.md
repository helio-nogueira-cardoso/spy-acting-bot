# SPY ACTING — Especificação Técnica Completa para Implementação

## Índice
1. [Visão Geral do Projeto](#1-visão-geral-do-projeto)
2. [Stack Tecnológica](#2-stack-tecnológica)
3. [Arquitetura do Sistema](#3-arquitetura-do-sistema)
4. [Estrutura de Arquivos](#4-estrutura-de-arquivos)
5. [Modelos de Dados (Database Schema)](#5-modelos-de-dados)
6. [Máquina de Estados do Jogo](#6-máquina-de-estados)
7. [Fluxo Completo do Jogo](#7-fluxo-completo)
8. [API do Telegram — Comandos e Handlers](#8-api-do-telegram)
9. [Lógica de Grupos (Duplas/Trios)](#9-lógica-de-grupos)
10. [Sistema de Pareamento e Veredito](#10-sistema-de-pareamento)
11. [Sistema de Pontuação](#11-sistema-de-pontuação)
12. [Base de Dados de Locais (500 locais)](#12-base-de-dados-de-locais)
13. [Modo Manual (Configurador)](#13-modo-manual)
14. [Tratamento de Erros e Edge Cases](#14-edge-cases)
15. [Deploy e Configuração](#15-deploy)
16. [Testes](#16-testes)
17. [Diretrizes de Implementação](#17-diretrizes)

---

## 1. Visão Geral do Projeto

**Nome:** Spy Acting (Infiltração Dramática)
**Tipo:** Bot de Telegram para jogo de dedução social e improvisação presencial
**Jogadores:** 3 a 12 participantes por partida
**Rodadas:** 3 a 10 (configurável pelo criador da sala)

### Conceito
Um grupo de agentes recebe um local secreto e papéis temáticos. Cada agente sabe quem é seu parceiro (dupla ou trio). Um espião infiltrado recebe apenas uma dica vaga e precisa descobrir o local e se infiltrar em um grupo. Os agentes devem se encontrar através de atuação e improvisação presencial, enquanto identificam o espião.

### Fluxo Resumido
1. Criador abre sala → jogadores entram enviando selfie
2. Criador configura rodadas e modo (automático/manual)
3. Cada rodada: bot distribui local, papéis, dica e conexões via DM
4. Jogadores interagem presencialmente, atuando seus papéis
5. Via bot: solicitam pareamento, aceitam/recusam, confirmam veredito
6. Rodada fecha quando TODOS confirmaram veredito simultaneamente
7. Bot calcula pontuação, exibe placar, inicia próxima rodada
8. Após todas as rodadas: placar final e ranking

---

## 2. Stack Tecnológica

```
Runtime:        Node.js >= 18 (LTS)
Linguagem:      TypeScript
Framework Bot:  grammy (https://grammy.dev) — moderno, tipado, ativo
Banco de Dados: SQLite via better-sqlite3 (arquivo local, zero config)
ORM:            Drizzle ORM (leve, tipado, funciona bem com SQLite)
Armazenamento:  Fotos salvas no filesystem local (./data/photos/)
Deploy:         PM2 para process management | VPS ou Railway/Render
Testes:         Vitest
```

### Justificativa
- **grammy** ao invés de node-telegram-bot-api: melhor tipagem, middleware, session management nativo, suporte a conversations
- **SQLite** ao invés de PostgreSQL: jogo não precisa de concorrência pesada; simplicidade de setup; arquivo único para backup
- **Drizzle**: queries tipadas sem overhead de ORMs pesados

### Dependências npm
```json
{
  "dependencies": {
    "grammy": "^1.21.0",
    "@grammyjs/conversations": "^1.2.0",
    "@grammyjs/menu": "^1.2.0",
    "better-sqlite3": "^11.0.0",
    "drizzle-orm": "^0.30.0",
    "dotenv": "^16.4.0",
    "nanoid": "^5.0.0",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "drizzle-kit": "^0.21.0",
    "vitest": "^1.4.0",
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.7.0"
  }
}
```

---

## 3. Arquitetura do Sistema

```
┌─────────────────────────────────────────────────────┐
│                   Telegram API                       │
└──────────────────────┬──────────────────────────────┘
                       │ Webhooks / Long Polling
                       ▼
┌─────────────────────────────────────────────────────┐
│                  Grammy Bot Core                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Commands │  │Callbacks │  │  Conversations     │  │
│  │ Handler  │  │ Handler  │  │  (multi-step DMs)  │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       └──────────────┼────────────────┘              │
│                      ▼                               │
│  ┌──────────────────────────────────────────────┐    │
│  │            Game Engine (Core Logic)           │    │
│  │  ┌────────────┐ ┌──────────┐ ┌────────────┐  │    │
│  │  │ Lobby Mgr  │ │Round Mgr │ │ Score Mgr  │  │    │
│  │  └────────────┘ └──────────┘ └────────────┘  │    │
│  │  ┌────────────┐ ┌──────────┐ ┌────────────┐  │    │
│  │  │ Group Calc │ │Pairing   │ │ Verdict    │  │    │
│  │  │ (duo/trio) │ │ Engine   │ │ Engine     │  │    │
│  │  └────────────┘ └──────────┘ └────────────┘  │    │
│  └──────────────────────────────────────────────┘    │
│                      │                               │
│                      ▼                               │
│  ┌──────────────────────────────────────────────┐    │
│  │         Data Layer (Drizzle + SQLite)         │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Padrão de Comunicação
- **Grupo do Telegram**: usado APENAS para lobby (criação da sala, entrada de jogadores, anúncios de rodada, placar)
- **DM (mensagem privada)**: TODA informação secreta (local, papel, dica, parceiros) e TODA mecânica de jogo (pareamento, convites, veredito)
- O bot DEVE verificar se consegue enviar DM a cada jogador ANTES de iniciar a partida

---

## 4. Estrutura de Arquivos

```
spy-acting-bot/
├── src/
│   ├── index.ts                    # Entry point, bot setup
│   ├── bot.ts                      # Grammy bot instance e middleware
│   ├── config.ts                   # Env vars, constantes
│   │
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema (todas as tabelas)
│   │   ├── connection.ts           # SQLite connection
│   │   └── migrations/             # Drizzle migrations
│   │
│   ├── engine/
│   │   ├── lobby.ts                # Criar/entrar/sair de salas, transferência de criador
│   │   ├── round.ts                # Iniciar rodada, distribuir papéis
│   │   ├── groups.ts               # Cálculo de duplas/trios
│   │   ├── pairing.ts              # Solicitação, aceite, recusa, desfazer
│   │   ├── verdict.ts              # Veredito e fechamento de rodada
│   │   ├── scoring.ts              # Cálculo de pontos
│   │   └── cleanup.ts              # Limpeza de dados e timeout por inatividade
│   │
│   ├── handlers/
│   │   ├── commands.ts             # /start, /newgame, /join, /help, etc.
│   │   ├── callbacks.ts            # Inline buttons (aceitar, recusar, etc.)
│   │   ├── photos.ts               # Recepção de selfies
│   │   └── conversations.ts        # Fluxos multi-step (config manual, etc.)
│   │
│   ├── menus/
│   │   ├── lobby-menu.ts           # Menu de lobby no grupo
│   │   ├── player-menu.ts          # Menu de ações no DM
│   │   ├── pairing-menu.ts         # Lista de jogadores com foto+nick
│   │   └── verdict-menu.ts         # Menu de veredito
│   │
│   ├── data/
│   │   └── locations.json          # 500 locais com papéis e dicas
│   │
│   ├── utils/
│   │   ├── messages.ts             # Todos os textos/templates de mensagem
│   │   ├── validators.ts           # Validações de estado
│   │   ├── photo-store.ts          # Salvar/recuperar fotos
│   │   └── logger.ts               # Winston logger config
│   │
│   └── types/
│       └── index.ts                # Tipos TypeScript compartilhados
│
├── data/
│   ├── photos/                     # Selfies dos jogadores (runtime)
│   └── spy-acting.db               # SQLite database (runtime)
│
├── drizzle.config.ts
├── vitest.config.ts
├── package.json
├── tsconfig.json
├── Dockerfile
├── fly.toml
├── .env.example
├── .env
│
├── tests/
│   ├── setup.ts                    # Reset do DB entre testes (beforeEach)
│   ├── helpers/
│   │   ├── factories.ts            # Fábricas de dados de teste
│   │   ├── mock-api.ts             # Mock da API Telegram
│   │   └── game-simulator.ts       # Simulador de fluxos completos
│   ├── unit/
│   │   ├── groups.test.ts
│   │   ├── scoring.test.ts
│   │   └── messages.test.ts
│   ├── integration/
│   │   ├── lobby.test.ts
│   │   ├── validators.test.ts
│   │   ├── pairing.test.ts
│   │   ├── verdict.test.ts
│   │   ├── cleanup.test.ts
│   │   ├── photos.test.ts
│   │   ├── leave-routing.test.ts
│   │   ├── regression-gaps.test.ts
│   │   ├── manual-mode-exclusion.test.ts
│   │   ├── full-game-flows.test.ts
│   │   └── player-counts.test.ts
│   └── smoke/
│       └── smoke.test.ts
└── README.md
```

---

## 5. Modelos de Dados

### 5.1 Tabela `games`
```sql
CREATE TABLE games (
  id              TEXT PRIMARY KEY,        -- nanoid (ex: "game_xK9mP2")
  chat_id         INTEGER NOT NULL,        -- ID do grupo Telegram
  creator_id      INTEGER NOT NULL,        -- Telegram user ID do criador
  mode            TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'manual'
  total_rounds    INTEGER NOT NULL DEFAULT 5,
  current_round   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'lobby',  -- 'lobby' | 'playing' | 'round_active' | 'round_ended' | 'finished'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 5.2 Tabela `players`
```sql
CREATE TABLE players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         TEXT NOT NULL REFERENCES games(id),
  user_id         INTEGER NOT NULL,        -- Telegram user ID
  username        TEXT,                     -- @username do Telegram
  display_name    TEXT NOT NULL,            -- Nome exibido
  photo_file_id   TEXT,                     -- Telegram file_id da selfie
  photo_path      TEXT,                     -- Caminho local da foto
  total_score     INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,  -- 0 se saiu do jogo
  joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, user_id)
);
```

### 5.3 Tabela `rounds`
```sql
CREATE TABLE rounds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id         TEXT NOT NULL REFERENCES games(id),
  round_number    INTEGER NOT NULL,
  location_key    TEXT NOT NULL,            -- Chave do local no JSON
  location_name   TEXT NOT NULL,            -- Nome do local
  spy_hint        TEXT NOT NULL,            -- Dica do espião
  spy_player_id   INTEGER NOT NULL REFERENCES players(id),
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'closed'
  spy_guess       TEXT,                     -- Chute do espião para o local
  spy_guess_approved INTEGER,               -- NULL=pendente, 1=aprovado, 0=rejeitado (via comparação ou votação)
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  UNIQUE(game_id, round_number)
);
```

### 5.3b Tabela `spy_guess_votes` (Votação Fair Play)
```sql
CREATE TABLE spy_guess_votes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  voter_player_id INTEGER NOT NULL REFERENCES players(id),
  vote            INTEGER NOT NULL,         -- 1 = válido, 0 = inválido
  voted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(round_id, voter_player_id)
);
```

### 5.4 Tabela `round_roles`
```sql
CREATE TABLE round_roles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  player_id       INTEGER NOT NULL REFERENCES players(id),
  role            TEXT NOT NULL,            -- 'agent' | 'spy'
  character_name  TEXT NOT NULL,            -- Ex: "Aluno da Grifinória" ou "Intruso"
  assigned_group  INTEGER,                 -- Número do grupo (1,2,3...) — NULL para espião
  group_type      TEXT,                     -- 'duo' | 'trio' — NULL para espião
  UNIQUE(round_id, player_id)
);
```

### 5.5 Tabela `pairings`
```sql
CREATE TABLE pairings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  requester_id    INTEGER NOT NULL REFERENCES players(id),  -- Quem pediu
  target_id       INTEGER NOT NULL REFERENCES players(id),  -- Quem recebeu
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected' | 'dissolved'
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);
```

### 5.6 Tabela `player_round_state`
```sql
CREATE TABLE player_round_state (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  player_id       INTEGER NOT NULL REFERENCES players(id),
  pairing_status  TEXT NOT NULL DEFAULT 'unpaired',  -- 'unpaired' | 'pending_sent' | 'pending_received' | 'paired'
  paired_with     TEXT,                     -- JSON array de player_ids com quem está pareado
  verdict_active  INTEGER NOT NULL DEFAULT 0,  -- 1 se confirmou veredito
  round_score     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(round_id, player_id)
);
```

### 5.7 Tabela `manual_configs` (Modo Manual)
```sql
CREATE TABLE manual_configs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  configurator_id INTEGER NOT NULL,         -- Telegram user ID do configurador
  location_name   TEXT NOT NULL,
  spy_hint        TEXT NOT NULL,
  groups_characters_json TEXT NOT NULL       -- JSON: [["Char A","Char B"], ["Char C","Char D"], ["Char E","Char F","Char G"]]
                                            -- Cada sub-array = 1 grupo (dupla com 2, trio com 3)
                                            -- O bot distribui jogadores e personagens aleatoriamente
);
```

---

## 6. Máquina de Estados

### 6.1 Estados do Jogo (Game)

```
LOBBY ──────► PLAYING ──────► FINISHED
                │    ▲
                ▼    │
          ROUND_ACTIVE ──► ROUND_ENDED
```

| Estado | Descrição |
|--------|-----------|
| `lobby` | Sala aberta, jogadores entrando, enviando selfies |
| `playing` | Jogo iniciado, entre rodadas (exibindo placar, preparando próxima) |
| `round_active` | Rodada em andamento — pareamento e veredito habilitados |
| `round_ended` | Rodada encerrada — pontuação calculada e exibida |
| `finished` | Todas as rodadas completas — placar final exibido |

### 6.2 Estados do Jogador na Rodada

```
UNPAIRED ──► PENDING_SENT ──────► PAIRED ──► VERDICT
    ▲            │                   │
    │            ▼                   │
    │       PENDING_RECEIVED         │
    │            │                   │
    └────────────┘ (recusa/dissolve) │
    ◄────────────────────────────────┘ (desfazer)
```

| Estado | Descrição |
|--------|-----------|
| `unpaired` | Livre para enviar ou receber convite |
| `pending_sent` | Enviou convite, aguardando resposta |
| `pending_received` | Recebeu convite, precisa aceitar/recusar |
| `paired` | Em grupo formado (dupla ou trio) |
| `verdict` | Confirmou veredito final |

### 6.3 Regras de Transição de Estado

```typescript
// Transições válidas do estado do jogador
const VALID_TRANSITIONS: Record<string, string[]> = {
  'unpaired':          ['pending_sent', 'pending_received'],
  'pending_sent':      ['unpaired', 'paired'],
  'pending_received':  ['unpaired', 'paired'],
  'paired':            ['unpaired', 'verdict'],  // unpaired = desfez par
  'verdict':           []  // Estado final da rodada (irreversível)
};
```

### 6.4 Condição de Fechamento de Rodada

```
Rodada fecha quando TODAS as condições são verdadeiras:
  1. Não há pareamentos pendentes (nenhum jogador com status pending_sent/pending_received)
  2. Todos os jogadores PAREADOS têm verdict_active = true
  3. No máximo 1 jogador está UNPAIRED (o isolado)

Ao fechar, jogadores isolados recebem verdict_active = 1 automaticamente.
```

**NOTA:** Com número par de jogadores (N-1 agentes ímpar), ou quando o espião não pareia, sempre haverá 1 jogador isolado. O jogo **não** exige veredito do isolado — a rodada fecha quando todos os pareados confirmaram e sobra no máximo 1 sem par.

**IMPORTANTE:** O fechamento é verificado TODA VEZ que um jogador confirma veredito. Se as condições acima forem atendidas, a rodada encerra imediatamente.

---

## 7. Fluxo Completo do Jogo

### Fase 1: Criação do Lobby

```
1. Criador usa /newgame no GRUPO
2. Bot cria sala com status 'lobby'
3. Bot posta mensagem no grupo com botão [Entrar no Jogo]
4. Bot envia DM ao criador: "Sala criada! Aguardando jogadores."
```

### Fase 2: Entrada dos Jogadores

```
1. Jogador clica [Entrar no Jogo] no grupo
2. Bot tenta enviar DM ao jogador
   ├── Sucesso: "Bem-vindo! Envie uma selfie para sua identificação."
   └── Falha: Bot responde no grupo: "@user, inicie uma conversa comigo primeiro: t.me/SpyActingBot"
3. Jogador envia selfie no DM
4. Bot salva foto (file_id + download local)
5. Bot confirma: "Selfie recebida! ✅ Aguardando início do jogo."
6. Bot atualiza mensagem no grupo: "Jogadores: 4/12 — [lista de nomes]"
```

### Fase 3: Configuração e Início

```
1. Criador clica [⚙️ Configurar] no grupo
2. Bot envia DM ao criador com opções:
   a. Número de rodadas: [3] [5] [7] [10]
   b. Modo: [Automático] [Manual]
      ⚠️ Se criador é jogador e tenta ativar Manual → BLOQUEADO
         (no modo manual, configurador sabe local/personagens = vantagem desleal)
      ⚠️ Se modo é Manual e criador tenta entrar como jogador → BLOQUEADO
3. Criador confirma
4. Criador clica [🎬 Iniciar Jogo] no grupo
5. Bot valida:
   ├── Mínimo 3 jogadores? ✓
   ├── Todos enviaram selfie? ✓
   └── Bot consegue enviar DM a todos? ✓
6. Game status → 'playing'
```

### Fase 4: Início da Rodada

```
1. Bot seleciona local aleatório (sem repetir nas rodadas anteriores)
2. Bot seleciona espião aleatoriamente
3. Bot calcula grupos:
   - N jogadores ativos
   - 1 espião
   - (N-1) agentes → dividir em duplas (+ 1 trio se ímpar)
4. Bot atribui personagens aleatórios do local aos agentes
5. Bot envia DMs privadas:

   AGENTE:
   ┌──────────────────────────────────────────┐
   │ 🎭 RODADA 3/5                            │
   │                                          │
   │ 📍 Local: Hogwarts                       │
   │ 🎪 Seu Papel: Aluno da Grifinória        │
   │ 💡 Dica do Espião: "Legado"              │
   │                                          │
   │ 👥 Seu grupo (dupla):                    │
   │    Procure: "Aluno da Sonserina"         │
   │                                          │
   │ ⚠️ Cuidado! Há um espião entre vocês!    │
   └──────────────────────────────────────────┘

   ESPIÃO:
   ┌──────────────────────────────────────────┐
   │ 🎭 RODADA 3/5                            │
   │                                          │
   │ 🕵️ Você é o ESPIÃO!                      │
   │ 💡 Sua Dica: "Legado"                    │
   │ 🎪 Seu Disfarce: "Intruso"               │
   │                                          │
   │ 🎯 Missão:                               │
   │  • Descubra o local secreto              │
   │  • Infiltre-se em qualquer grupo         │
   │  • Não seja descoberto!                  │
   └──────────────────────────────────────────┘

6. Bot anuncia no grupo: "🎬 Rodada 3 iniciou! Verifiquem seus DMs."
7. Round status → 'active'
```

### Fase 5: Pareamento (Durante a Rodada)

```
1. Jogador abre DM do bot
2. Bot mostra menu principal da rodada:
   ┌──────────────────────────────────────────┐
   │ 🎭 Rodada 3 — Ações                     │
   │                                          │
   │ Status: 🔴 Sem par                       │
   │                                          │
   │ [🤝 Solicitar Par]                       │
   │ [📋 Ver Meu Papel]                       │
   │ [📊 Ver Situação]                        │
   └──────────────────────────────────────────┘

3. Ao clicar [Solicitar Par]:
   Bot mostra GRID de jogadores:
   ┌──────────────────────────────────────────┐
   │ Escolha um jogador:                      │
   │                                          │
   │ [📸 Alice]  [📸 Bob]  [📸 Carol]         │
   │ [📸 David]  [📸 Eve]  [📸 Frank]         │
   │                                          │
   │ (📸 = miniatura da selfie ao lado)       │
   └──────────────────────────────────────────┘
   
   NOTA: A foto deve ser enviada como thumbnail ao lado do nome.
   Implementação: Enviar cada opção como InlineKeyboardButton,
   e ANTES da lista de botões, enviar um álbum/collage de fotos
   com legendas numeradas, e os botões referenciam os números.
   
   ALTERNATIVA MAIS SIMPLES E RECOMENDADA:
   Para cada jogador disponível, enviar uma mensagem separada
   com a foto + botão inline [Solicitar par com {nome}].
   Isso garante que a foto esteja visível junto ao botão.

4. Jogador A seleciona Jogador B
5. Bot envia para B:
   ┌──────────────────────────────────────────┐
   │ 🤝 Convite de Par!                       │
   │                                          │
   │ [📸 foto do Alice]                       │
   │ Alice quer formar par com você!          │
   │                                          │
   │ [✅ Aceitar]  [❌ Recusar]               │
   └──────────────────────────────────────────┘

6a. Se B aceita:
    - Status de A e B → 'paired'
    - paired_with atualizado para ambos
    - Bot notifica ambos: "Par formado! ✅"
    - Se dupla (e grupo é dupla): grupo completo → botão [✅ Confirmar Veredito] aparece
    - Se trio: bot informa "Grupo incompleto. Falta 1 membro."
      O terceiro membro pode ser solicitado por A ou B

6b. Se B recusa:
    - Status de A → 'unpaired'
    - Bot notifica A: "Seu convite foi recusado."
```

### Fase 5b: Formação de Trio

```
Quando a rodada tem trio (número ímpar de agentes):

1. A e B já estão pareados (paired_with: [A,B] para ambos)
2. A ou B clica [🤝 Adicionar ao Grupo]
3. Bot mostra jogadores disponíveis (sem par)
4. Seleciona C
5. C recebe convite: "Alice e Bob querem você no grupo!"
6. C aceita → trio formado
   - paired_with de A, B, C → [A,B,C] (cada um vê os outros 2)
   - Grupo completo → botão de veredito disponível para todos
```

### Fase 5c: Desfazer Par

```
1. Jogador em status 'paired' clica [❌ Desfazer Par]
2. Bot confirma: "Tem certeza? [Sim, desfazer] [Cancelar]"
3. Se confirma:
   - TODOS os membros do grupo voltam para 'unpaired'
   - paired_with = NULL para todos
   - verdict_active = 0 para todos (caso alguém já tenha dado veredito)
   - Bot notifica todos os ex-membros: "O par/trio foi desfeito por {nome}!"
```

### Fase 6: Veredito

```
1. Jogador em grupo completo vê botão [✅ Confirmar Veredito]
2. ESPIÃO: Ao clicar, bot pede: "Digite o nome do local secreto:"
   - Espião digita o chute
   - Bot salva em rounds.spy_guess
   - Bot confirma: "Veredito registrado! ✅"
3. AGENTE: Ao clicar, bot confirma: "Veredito registrado! ✅"
4. Status → 'verdict', verdict_active = 1

VERIFICAÇÃO DE FECHAMENTO (executada a cada veredito):
  IF todos os jogadores ativos têm verdict_active = 1:
    → Comparar chute do espião automaticamente (normalização de string)
    → Se comparação falhou → iniciar votação fair play (Fase 6.1)
    → Aguardar resultado da votação (60s timeout)
    → Calcular pontuação com resultado final
    → Exibir resultados
```

### Fase 6.1: Verificação do Chute do Espião

O chute do espião passa por um processo de validação em duas etapas:

```
ETAPA 1 — Comparação automática:
  1. Normalizar o chute: lowercase → remover acentos (NFD) → remover caracteres especiais → trim
  2. Normalizar o nome real do local com o mesmo processo
  3. Comparar as strings normalizadas
  4. Se IGUAIS → espião acertou ✅ (pula Etapa 2)
  5. Se DIFERENTES → ir para Etapa 2

ETAPA 2 — Votação de Fair Play (apenas se Etapa 1 falhou):

  MODO AUTOMÁTICO:
    1. Bot envia enquete no GRUPO:
       ┌────────────────────────────────────────────────┐
       │ ⚖️ FAIR PLAY — Validação do Chute              │
       │                                                │
       │ O espião chutou: "{chute_do_espião}"           │
       │ O local correto era: "{local_real}"            │
       │                                                │
       │ O chute do espião é válido?                    │
       │                                                │
       │ [✅ Sim, aceitar]  [❌ Não, invalidar]         │
       │                                                │
       │ ⏳ Votação encerra em 60 segundos              │
       └────────────────────────────────────────────────┘
    2. APENAS agentes podem votar (espião é excluído)
    3. Cada jogador vota uma única vez (callback_query deduplicado)
    4. Resultado:
       - Se ≥ 50% dos votos são "Sim" → espião acertou ✅
       - Se < 50% dos votos são "Sim" → chute invalidado ❌
       - Abstenções NÃO contam (base = apenas quem votou)
       - Se NINGUÉM votar em 60s → chute invalidado ❌
    5. Bot exibe resultado da votação antes de prosseguir com pontuação

  MODO MANUAL:
    1. Bot envia DM ao configurador:
       "O espião chutou '{chute}'. O local era '{local}'.
        O chute é válido? [✅ Sim] [❌ Não]"
    2. Decisão do configurador é final e imediata
```

### Fase 7: Resultado da Rodada

```
Bot envia no GRUPO:
┌──────────────────────────────────────────────────────┐
│ 🎬 RODADA 3 — RESULTADO                             │
│                                                      │
│ 📍 Local: Hogwarts                                   │
│ 🕵️ Espião: Bob                                       │
│ 💡 Dica: "Legado"                                    │
│ 🎯 Chute do espião: "Hogwarts" ✅                    │
│    (aprovado automaticamente)                        │
│    — OU —                                            │
│ 🎯 Chute do espião: "Escola de Magia" ✅             │
│    (aprovado por votação: 4 sim / 2 não)             │
│    — OU —                                            │
│ 🎯 Chute do espião: "Castelo" ❌                     │
│    (rejeitado por votação: 1 sim / 5 não)            │
│                                                      │
│ 👥 GRUPOS CORRETOS:                                  │
│  Dupla 1: Aluno Grifinória + Aluno Sonserina         │
│  Dupla 2: Dumbledore + McGonagall                    │
│  Trio:    Hagrid + Snape + Dobby                     │
│                                                      │
│ 🤝 GRUPOS FORMADOS:                                  │
│  Alice (Grifinória) + Carol (Sonserina) ✅ Correto!  │
│  David (Dumbledore) + Eve (McGonagall) ✅ Correto!   │
│  Frank (Hagrid) + Grace (Snape) + Helen (Dobby) ✅   │
│  Bob (Espião 🕵️) ficou com: ninguém (isolado)       │
│                                                      │
│ 📊 PONTUAÇÃO DA RODADA:                              │
│  Alice: +1 (grupo correto) +1 (bônus) = 2           │
│  Carol: +1 +1 = 2                                   │
│  David: +1 +1 = 2                                   │
│  Eve:   +1 +1 = 2                                   │
│  Frank: +1 +1 = 2                                   │
│  Grace: +1 +1 = 2                                   │
│  Helen: +1 +1 = 2                                   │
│  Bob:   +1 (acertou local) = 1                       │
│                                                      │
│ 🏆 PLACAR ACUMULADO: [ranking atualizado]            │
└──────────────────────────────────────────────────────┘
```

### Fase 8: Próxima Rodada ou Fim

```
Se current_round < total_rounds:
  Bot: "Próxima rodada em 15 segundos..."
  → Volta para Fase 4

Se current_round = total_rounds:
  Bot exibe placar final com ranking
  Status → 'finished'
```

---

## 8. API do Telegram — Comandos e Handlers

### 8.1 Comandos (usados no grupo ou DM)

| Comando | Contexto | Descrição |
|---------|----------|-----------|
| `/start` | DM | Inicia conversa com bot, mostra boas-vindas |
| `/newgame` | Grupo | Cria nova sala de jogo |
| `/join` | Grupo | Entra na sala ativa (alternativa ao botão) |
| `/leave` | Grupo/DM | Sai da sala atual |
| `/status` | Grupo/DM | Mostra estado atual do jogo/rodada |
| `/help` | Qualquer | Mostra regras e comandos |
| `/cancel` | DM | Cancela operação em andamento |
| `/endgame` | Grupo | Criador força encerramento do jogo |

### 8.2 Callback Queries (Botões Inline)

| Callback Data Pattern | Ação |
|----------------------|-------|
| `join:{game_id}` | Entrar no jogo |
| `config:{game_id}` | Abrir configuração (criador) |
| `rounds:{game_id}:{n}` | Definir número de rodadas |
| `mode:{game_id}:{mode}` | Definir modo (auto/manual) |
| `start_game:{game_id}` | Iniciar jogo |
| `pair_req:{round_id}:{target_player_id}` | Solicitar par |
| `pair_accept:{pairing_id}` | Aceitar convite |
| `pair_reject:{pairing_id}` | Recusar convite |
| `pair_add:{round_id}` | Adicionar terceiro ao grupo |
| `pair_undo:{round_id}` | Desfazer par |
| `pair_undo_confirm:{round_id}` | Confirmar desfazer |
| `verdict:{round_id}` | Confirmar veredito |
| `vote_spy_yes:{round_id}` | Votação fair play: chute válido |
| `vote_spy_no:{round_id}` | Votação fair play: chute inválido |
| `manual_spy_yes:{round_id}` | Configurador: chute válido |
| `manual_spy_no:{round_id}` | Configurador: chute inválido |
| `view_role:{round_id}` | Ver papel novamente |
| `view_status:{round_id}` | Ver situação da rodada |

### 8.3 Handlers Especiais

| Tipo | Trigger | Ação |
|------|---------|------|
| `message:photo` | Selfie no DM | Salvar foto, associar ao jogador |
| `message:text` | Texto no DM durante veredito do espião | Capturar chute do local |

---

## 9. Lógica de Grupos (Duplas/Trios)

### 9.1 Algoritmo de Cálculo

```typescript
interface GroupAssignment {
  groups: number[][];       // Array de arrays de player_ids
  groupTypes: ('duo' | 'trio')[];
  spyPlayerId: number;
}

function calculateGroups(playerIds: number[], spyId: number): GroupAssignment {
  // 1. Remover espião da lista de agentes
  const agents = playerIds.filter(id => id !== spyId);
  const numAgents = agents.length;

  // 2. Embaralhar agentes
  const shuffled = shuffle(agents);

  // 3. Calcular estrutura
  const groups: number[][] = [];
  const groupTypes: ('duo' | 'trio')[] = [];

  if (numAgents % 2 === 0) {
    // Todos em duplas
    for (let i = 0; i < numAgents; i += 2) {
      groups.push([shuffled[i], shuffled[i + 1]]);
      groupTypes.push('duo');
    }
  } else {
    // Primeiro trio, depois duplas
    groups.push([shuffled[0], shuffled[1], shuffled[2]]);
    groupTypes.push('trio');
    for (let i = 3; i < numAgents; i += 2) {
      groups.push([shuffled[i], shuffled[i + 1]]);
      groupTypes.push('duo');
    }
  }

  return { groups, groupTypes, spyPlayerId: spyId };
}
```

### 9.2 Tabela de Referência

| Jogadores | Espião | Agentes | Duplas | Trios | Estrutura |
|-----------|--------|---------|--------|-------|-----------|
| 3 | 1 | 2 | 1 | 0 | 1 dupla |
| 4 | 1 | 3 | 0 | 1 | 1 trio |
| 5 | 1 | 4 | 2 | 0 | 2 duplas |
| 6 | 1 | 5 | 1 | 1 | 1 trio + 1 dupla |
| 7 | 1 | 6 | 3 | 0 | 3 duplas |
| 8 | 1 | 7 | 2 | 1 | 1 trio + 2 duplas |
| 9 | 1 | 8 | 4 | 0 | 4 duplas |
| 10 | 1 | 9 | 3 | 1 | 1 trio + 3 duplas |
| 11 | 1 | 10 | 5 | 0 | 5 duplas |
| 12 | 1 | 11 | 4 | 1 | 1 trio + 4 duplas |

### 9.3 Atribuição de Personagens

```typescript
function assignCharacters(
  groups: number[][],
  locationData: Location
): Map<number, string> {
  const assignments = new Map<number, string>();

  // Embaralhar todos os 12 personagens e pegar apenas os necessários
  const shuffled = shuffle([...locationData.characters]);
  let charIndex = 0;

  // Atribuir personagens sequencialmente por grupo
  // O pareamento é completamente aleatório — não há relação
  // pré-definida entre personagens no JSON
  for (const group of groups) {
    for (const playerId of group) {
      assignments.set(playerId, shuffled[charIndex++]);
    }
  }

  return assignments;
}
```

### 9.4 Informação de Parceiros

O agente NÃO recebe os nomes reais dos parceiros. Ele recebe apenas os NOMES DOS PERSONAGENS dos seus parceiros. Isso é fundamental para a mecânica de dedução.

```typescript
// Exemplo de mensagem para agente em DUPLA:
"👥 Seu grupo (dupla): Procure o 'Aluno da Sonserina'"

// Exemplo de mensagem para agente em TRIO:
"👥 Seu grupo (trio): Procure o 'Aluno da Sonserina' e o 'Professor de Poções'"
```

---

## 10. Sistema de Pareamento

### 10.1 Regras de Validação

```typescript
function canRequestPairing(
  requester: PlayerRoundState,
  target: PlayerRoundState,
  roundInfo: RoundInfo
): { allowed: boolean; reason?: string } {

  // 1. Requester deve estar 'unpaired'
  if (requester.pairing_status !== 'unpaired') {
    return { allowed: false, reason: "Você já está em um par ou com convite pendente." };
  }

  // 2. Target deve estar 'unpaired'
  if (target.pairing_status !== 'unpaired') {
    return { allowed: false, reason: "Este jogador já está em um par ou com convite pendente." };
  }

  // 3. Não pode convidar a si mesmo
  if (requester.player_id === target.player_id) {
    return { allowed: false, reason: "Você não pode se convidar." };
  }

  return { allowed: true };
}

function canAddToGroup(
  group: number[],    // player_ids já no grupo
  target: PlayerRoundState,
  roundInfo: RoundInfo
): { allowed: boolean; reason?: string } {

  // 1. Grupo deve estar incompleto (dupla tentando virar trio)
  const expectedSize = getExpectedGroupSize(group, roundInfo);
  if (group.length >= expectedSize) {
    return { allowed: false, reason: "Seu grupo já está completo." };
  }

  // 2. Target deve estar 'unpaired'
  if (target.pairing_status !== 'unpaired') {
    return { allowed: false, reason: "Este jogador não está disponível." };
  }

  return { allowed: true };
}
```

### 10.2 Lógica de Grupo Completo

```typescript
function isGroupComplete(
  playerIds: number[],
  roundId: number
): boolean {
  // Buscar todos os groups da rodada
  const roundRoles = getRoundRoles(roundId);
  const playerRole = roundRoles.find(r => playerIds.includes(r.player_id));

  if (!playerRole) return false;

  // Espião: grupo completo = qualquer tamanho ≥ 2 (ele se junta a alguém)
  // Nota: Espião pode se juntar a qualquer grupo, e o grupo é "completo"
  // quando tem o tamanho esperado.

  // Para simplificar: o grupo é completo quando atinge o tamanho esperado
  // baseado na existência de trios nesta rodada
  const roundGroups = getRoundGroups(roundId);
  const smallestGroupSize = roundGroups.some(g => g.type === 'trio') ? 2 : 2;

  // Na prática: o bot deve saber quantos membros o grupo DEVERIA ter
  // Isso depende se há trios na rodada:
  // - Se não há trios: todos os grupos são duplas → tamanho 2
  // - Se há trios: um grupo é trio (3), resto são duplas (2)

  // O ESPIÃO pode se juntar a qualquer grupo.
  // O grupo do espião terá tamanho +1 do que o esperado?
  // NÃO! O espião forma par/trio como qualquer outro jogador.
  // A diferença é que ele não tem grupo "correto".

  // Solução: verificar se o paired_with do jogador
  // forma um grupo de tamanho ≥ 2 (para dupla) ou ≥ 3 (para trio)
  // Como o espião não tem grupo atribuído, qualquer grupo que ele
  // entre é considerado "completo" quando atinge 2 (ou 3 se trio exists)

  // REGRA SIMPLIFICADA:
  // Grupo completo = número de membros == tamanhoEsperado
  // tamanhoEsperado = 2 para todos, EXCETO se a rodada tem trio
  // e este grupo é o trio (verificar por round_roles.group_type)

  // Para o ESPIÃO que não tem group_type:
  // O grupo é completo quando alcança 2 membros (ou 3 se ele está
  // substituindo alguém de um trio)

  return playerIds.length >= getExpectedSizeForGroup(playerIds, roundId);
}
```

### 10.3 Determinação do Tamanho Esperado do Grupo

```typescript
function getExpectedSizeForGroup(memberIds: number[], roundId: number): number {
  const roles = getRoundRoles(roundId);

  // Verificar se algum membro é agente com group_type definido
  for (const memberId of memberIds) {
    const role = roles.find(r => r.player_id === memberId);
    if (role && role.role === 'agent' && role.group_type) {
      return role.group_type === 'trio' ? 3 : 2;
    }
  }

  // Se nenhum agente no grupo tem group_type (ex: espião sozinho formando grupo)
  // O tamanho default é 2 (dupla)
  return 2;
}
```

**NOTA IMPORTANTE:** O espião pode se juntar a qualquer grupo. Quando o espião entra em uma dupla de agentes, aqueles agentes vão ter um membro extra. Mas da perspectiva do ESPIÃO, ele precisa formar um grupo de tamanho 2 (como uma dupla). Da perspectiva dos AGENTES, eles podem ter no máximo o tamanho do grupo correto. Se uma dupla de agentes já está completa (2 membros), o espião NÃO consegue entrar nela — ele precisa estar em um grupo desde o início. Ou seja:

**CORREÇÃO DO FLUXO:** Todos os jogadores (incluindo o espião) formam grupos da mesma maneira. O espião não "entra" em um grupo existente — ele forma par como qualquer outro. Isso significa que em uma rodada com 7 jogadores (3 duplas + 1 espião), os jogadores se organizam em 4 grupos de 2, e sobra 1 sozinho OU todos se organizam e o espião está dentro de algum grupo.

**SIMPLIFICAÇÃO FINAL:**
- Todos formam pares/trios normalmente
- O espião age como qualquer jogador
- A revelação acontece apenas no veredito
- A validação de "grupo correto" é feita na pontuação

---

## 11. Sistema de Pontuação

### 11.1 Regras de Pontuação

```typescript
interface RoundScoring {
  // Inputs
  correctGroups: number[][];        // Grupos corretos (definidos pelo bot)
  formedGroups: number[][];         // Grupos formados pelos jogadores
  spyPlayerId: number;              // ID do espião
  spyGuessApproved: boolean;        // Resultado FINAL (comparação automática OU votação/configurador)

  // Derived
  spyInfiltrated: boolean;         // Espião está em grupo com agentes?
  spyIsolated: boolean;            // Espião ficou sozinho?
}

function calculateRoundScores(scoring: RoundScoring): Map<number, number> {
  const scores = new Map<number, number>();
  const allPlayerIds = scoring.correctGroups.flat().concat(scoring.spyPlayerId);

  // Inicializar todos com 0
  allPlayerIds.forEach(id => scores.set(id, 0));

  // 1. Espião acertou o local? (já inclui resultado da votação fair play)
  if (scoring.spyGuessApproved) {
    scores.set(scoring.spyPlayerId, (scores.get(scoring.spyPlayerId) || 0) + 1);
  }

  // 2. Verificar infiltração do espião
  const spyGroup = scoring.formedGroups.find(g => g.includes(scoring.spyPlayerId));
  const spyWithAgents = spyGroup && spyGroup.some(id => id !== scoring.spyPlayerId);

  if (spyWithAgents) {
    // Espião infiltrado: +2 pontos
    scores.set(scoring.spyPlayerId, (scores.get(scoring.spyPlayerId) || 0) + 2);
  }

  // 3. Calcular pontos dos agentes
  const spyIsIsolated = !spyWithAgents;

  for (const agentId of scoring.correctGroups.flat()) {
    const formedGroup = scoring.formedGroups.find(g => g.includes(agentId));

    if (!formedGroup) {
      // Agente não formou grupo → 0 pontos
      scores.set(agentId, 0);
      continue;
    }

    // Verificar se o grupo formado é "correto"
    const isCorrectGroup = isGroupCorrect(formedGroup, scoring.correctGroups, scoring.spyPlayerId);

    if (isCorrectGroup) {
      // Agente em grupo correto: +1 ponto
      scores.set(agentId, (scores.get(agentId) || 0) + 1);

      // Bônus: espião isolado E NÃO acertou o local
      if (spyIsIsolated && !scoring.spyGuessApproved) {
        scores.set(agentId, (scores.get(agentId) || 0) + 1);
      }
    } else {
      // Agente em grupo incorreto: 0 pontos TOTAL (sobrescreve qualquer bônus)
      scores.set(agentId, 0);
    }
  }

  return scores;
}

// Verifica se grupo formado é correto (ignora presença do espião)
function isGroupCorrect(
  formedGroup: number[],
  correctGroups: number[][],
  spyId: number
): boolean {
  // Remover espião do grupo formado para comparação
  const agentsInFormed = formedGroup.filter(id => id !== spyId);

  // Verificar se os agentes do grupo formado pertencem ao MESMO grupo correto
  for (const correctGroup of correctGroups) {
    if (agentsInFormed.every(id => correctGroup.includes(id))) {
      // Verificar tamanho: os agentes formaram exatamente o grupo correto?
      // Agentes extras no grupo (do mesmo grupo correto) são OK se o grupo correto é maior
      // Mas se faltam agentes do grupo correto, está incompleto → incorreto

      // Todos os agentes do grupo correto precisam estar no grupo formado
      const correctAgentsInFormed = correctGroup.filter(id => agentsInFormed.includes(id));
      if (correctAgentsInFormed.length === correctGroup.length) {
        return true;
      }
    }
  }

  return false;
}

// Normalizar string para comparação automática do chute (Fase 6.1, Etapa 1)
// Se esta comparação falha, o fluxo de votação fair play é acionado
function normalizeString(s: string): string {
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Remove acentos
    .replace(/[^a-z0-9]/g, '')         // Remove caracteres especiais
    .trim();
}
```

### 11.2 Cenários de Pontuação

```
CENÁRIO 1: Espião infiltrado, acertou local
  Espião: +2 (infiltração) +1 (local) = 3
  Agentes corretos: +1 (grupo correto)
  Agentes incorretos (com espião): 0

CENÁRIO 2: Espião isolado, errou local
  Espião: 0
  Agentes corretos: +1 (grupo) +1 (bônus) = 2
  Agentes incorretos: 0 (sem bônus)

CENÁRIO 3: Espião isolado, acertou local
  Espião: +1 (local)
  Agentes corretos: +1 (grupo correto, sem bônus pois espião acertou local)
  Agentes incorretos: 0

CENÁRIO 4: Espião infiltrado, errou local
  Espião: +2 (infiltração)
  Agentes corretos sem espião: +1 (grupo correto, sem bônus pois espião não isolado)
  Agentes com espião no grupo: 0 (grupo incorreto)
```

---

## 12. Base de Dados de Locais

### 12.1 Estrutura do JSON

O JSON armazena APENAS o conteúdo temático. Não há pareamento pré-definido — toda formação de duplas/trios é feita pelo código em runtime, de forma completamente aleatória.

```typescript
interface Location {
  key: string;                    // ID único (ex: "hogwarts")
  name: string;                   // Nome do local (ex: "Hogwarts")
  category: 'real' | 'fantasy' | 'fiction';
  spy_hint: string;               // Dica vaga para o espião
  characters: string[];           // Exatamente 12 nomes de personagens
}
```

### 12.2 Formato do JSON

```json
{
  "locations": [
    {
      "key": "hogwarts",
      "name": "Hogwarts",
      "category": "fiction",
      "spy_hint": "Legado",
      "characters": [
        "Aluno da Grifinória",
        "Aluno da Sonserina",
        "Aluno da Corvinal",
        "Aluno da Lufa-Lufa",
        "Dumbledore",
        "McGonagall",
        "Snape",
        "Hagrid",
        "Dobby",
        "Hedwig",
        "Voldemort",
        "Bellatrix"
      ]
    },
    {
      "key": "hospital",
      "name": "Hospital",
      "category": "real",
      "spy_hint": "Pulso",
      "characters": [
        "Cirurgião",
        "Enfermeira-Chefe",
        "Paciente Internado",
        "Anestesista",
        "Recepcionista",
        "Paramédico",
        "Nutricionista",
        "Faxineiro",
        "Visitante Aflito",
        "Residente",
        "Farmacêutico",
        "Voluntário"
      ]
    }
  ]
}
```

### 12.3 Lógica de Distribuição de Personagens (Runtime)

O pareamento entre personagens é 100% aleatório e feito em runtime. O JSON não contém nenhuma informação sobre quem forma par com quem.

```typescript
function assignCharactersToGroups(
  agentIds: number[],
  location: Location,
  groupStructure: { groups: number[][]; groupTypes: ('duo' | 'trio')[] }
): Map<number, string> {

  // 1. Embaralhar os 12 personagens do local
  const shuffledChars = shuffle([...location.characters]);

  // 2. Pegar apenas os N personagens necessários (N = número de agentes)
  const selectedChars = shuffledChars.slice(0, agentIds.length);

  // 3. Distribuir sequencialmente: os primeiros personagens vão para
  //    o primeiro grupo, os seguintes para o segundo grupo, etc.
  //    Como tudo já está embaralhado, o resultado é completamente aleatório.
  const assignments = new Map<number, string>();
  let charIndex = 0;

  for (const group of groupStructure.groups) {
    for (const playerId of group) {
      assignments.set(playerId, selectedChars[charIndex++]);
    }
  }

  return assignments;
}
```

**Fluxo completo (seção 9.1 + 12.3 combinados):**
1. `calculateGroups()` define QUAIS jogadores ficam em qual grupo (aleatório)
2. `assignCharactersToGroups()` define QUAL personagem cada jogador recebe (aleatório)
3. O "par correto" de cada agente é simplesmente quem está no mesmo grupo
4. A informação enviada ao agente é: "Procure o '{personagem do parceiro}'"

### 12.4 Regras para Geração dos 500 Locais

O arquivo `src/data/locations.json` contém 500 locais gerados seguindo estas regras:

1. **Distribuição por categoria:**
   - 300 locais `real` (60%) — Lugares reais do mundo
   - 150 locais `fantasy` (30%) — Mundos de fantasia originais ou de cultura geral
   - 50 locais `fiction` (10%) — Franquias de filmes, séries, jogos, livros

2. **Diversidade de locais reais:** Incluir aeroportos, hospitais, escolas, restaurantes, prisões, estádios, museus, parques, praias, cassinos, navios, submarinos, estações espaciais, bases militares, monastérios, castelos históricos, mercados, circos, zoológicos, fazendas, minas, vulcões, florestas, etc.

3. **Diversidade de ficção:** Star Wars, Harry Potter, Senhor dos Anéis, Marvel, DC, Game of Thrones, Naruto, Dragon Ball, Matrix, Jurassic Park, Piratas do Caribe, Stranger Things, etc.

4. **Para cada local, exatamente 12 personagens** (array de strings) que:
   - São temáticos e reconhecíveis dentro do contexto do local
   - Representam papéis distintos entre si (evitar duplicatas como "Guarda 1" e "Guarda 2")
   - NÃO precisam ter pareamento pré-definido — o código fará isso aleatoriamente em runtime

5. **Dica do espião:** Uma única palavra ou expressão curta que:
   - Tem relação com o local mas é vaga o suficiente para não entregar
   - NÃO é sinônimo direto do local
   - NÃO é uma parte óbvia do nome do local
   - Pode ter múltiplas interpretações
   - Exemplos bons: Hospital → "Pulso", Praia → "Sal", Escola → "Sino", Navio → "Horizonte"
   - Exemplos ruins: Hospital → "Médico", Praia → "Areia", Escola → "Aula"

6. **Idioma:** Todos os nomes de locais, personagens e dicas devem estar em **português brasileiro**.

7. **Formato:** O JSON deve ser um array simples. Cada local tem `key`, `name`, `category`, `spy_hint` e `characters` (array de 12 strings). Sem objetos aninhados nos personagens — apenas strings.

---

## 13. Modo Manual (Configurador)

### 13.1 Fluxo do Configurador

O modo manual permite que um jogador NON-PLAYING (não participa do jogo) defina o conteúdo temático de cada rodada, enquanto o bot mantém o controle da aleatoriedade.

**O que o configurador controla:** Local, Dica e Personagens (agrupados por dupla/trio).
**O que o bot controla:** Seleção do espião, distribuição de personagens para jogadores, formação dos grupos.

```
1. Configurador definido na criação da sala
2. No início de cada rodada, bot envia DM ao configurador:
   "⚙️ Configure a Rodada {N}:"

3. Passo 1 — Local:
   "📍 Digite o nome do local:"
   → Configurador digita (texto livre)

4. Passo 2 — Dica:
   "💡 Digite a dica para o espião:"
   → Configurador digita (texto livre)

5. Passo 3 — Espião:
   O bot seleciona o espião ALEATORIAMENTE (igual ao modo automático).
   O configurador NÃO escolhe o espião.

6. Passo 4 — Personagens por Grupo:
   O bot informa a estrutura de grupos da rodada baseada no número de jogadores:
   Ex: "Esta rodada tem 7 jogadores → 3 duplas + 1 espião"
   Ex: "Esta rodada tem 8 jogadores → 2 duplas + 1 trio + 1 espião"

   Para cada grupo, o bot pede os personagens:
   ┌──────────────────────────────────────────────────┐
   │ 🎭 Grupo 1 (dupla)                               │
   │ Digite os 2 personagens separados por vírgula:   │
   │ Ex: "Aluno da Grifinória, Aluno da Sonserina"    │
   └──────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │ 🎭 Grupo 2 (dupla)                               │
   │ Digite os 2 personagens separados por vírgula:   │
   └──────────────────────────────────────────────────┘

   ┌──────────────────────────────────────────────────┐
   │ 🎭 Grupo 3 (trio) — se houver                    │
   │ Digite os 3 personagens separados por vírgula:   │
   └──────────────────────────────────────────────────┘

   O bot então distribui ALEATORIAMENTE qual jogador fica com qual
   personagem dentro de cada grupo. Ou seja, o configurador define
   "Aluno da Grifinória + Aluno da Sonserina" como dupla, mas não
   sabe qual jogador será qual.

7. Passo 5 — Confirmação:
   Bot mostra resumo:
   ┌──────────────────────────────────────────────────┐
   │ 📋 RESUMO DA RODADA {N}                          │
   │                                                  │
   │ 📍 Local: Hogwarts                               │
   │ 💡 Dica: "Legado"                                │
   │ 🕵️ Espião: (aleatório, já definido pelo bot)     │
   │                                                  │
   │ 🎭 Grupo 1 (dupla):                              │
   │    Aluno da Grifinória + Aluno da Sonserina      │
   │ 🎭 Grupo 2 (dupla):                              │
   │    Dumbledore + McGonagall                        │
   │ 🎭 Grupo 3 (trio):                               │
   │    Hagrid + Snape + Dobby                         │
   │                                                  │
   │ [✅ Confirmar] [🔄 Refazer]                      │
   └──────────────────────────────────────────────────┘

8. Bot distribui informações conforme definido
```

### 13.2 Validação do Chute no Modo Manual

No modo manual, quando a comparação automática do chute do espião falha (Etapa 1 da Fase 6.1), a decisão sobre a validade do chute cabe EXCLUSIVAMENTE ao configurador, sem votação dos jogadores.

### 13.3 Validações do Modo Manual

- **Exclusão mútua configurador/jogador:** No modo manual, o configurador define local, dica e personagens — portanto tem informação privilegiada. Se ele também fosse jogador, saberia a resposta (como espião) ou saberia todos os personagens (como agente). As seguintes regras são **impostas pelo bot**:
  - Se o criador é jogador e tenta ativar modo manual → **bloqueado** com aviso para sair do jogo ou manter modo automático
  - Se modo é manual e criador tenta entrar como jogador → **bloqueado** com aviso de conflito de imparcialidade
  - No modo automático não há restrição — o criador pode jogar normalmente (o bot decide tudo)
- O número de personagens por grupo deve ser exato (2 para dupla, 3 para trio)
- O total de personagens deve ser igual ao número de agentes (jogadores - 1 espião)
- Personagens devem ser não-vazios e sem duplicatas
- O configurador pode usar nomes de papéis livremente (sem restrição de conteúdo)
- Se o configurador não confirmar em 10 minutos, bot envia lembrete
- O configurador pode clicar [🔄 Refazer] para recomeçar do Passo 1

---

## 14. Tratamento de Erros e Edge Cases

### 14.1 Jogador Sai no Meio da Rodada

```
1. Marcar is_active = 0
2. Se estava em grupo: dissolver grupo, notificar membros
3. Se tinha veredito: recalcular se rodada deve fechar
4. Remover da lista de pareamento
5. Notificar grupo: "{nome} saiu do jogo."
6. Se era espião: rodada encerra — todos os agentes com grupo correto ganham +1, bônus +1
7. Se menos de 3 jogadores ativos: encerrar jogo
```

### 14.2 Transferência de Criador

```
Quando o criador da sala sai (/leave):
1. Se restam jogadores ativos → o PRIMEIRO jogador ativo vira o novo criador
   - Atualizar games.creator_id
   - Notificar no grupo: "{novo_criador} agora é o responsável pela sala"
   - Enviar DM ao novo criador: "Você agora é o responsável!"
2. Se NÃO restam jogadores → encerrar e limpar o jogo completamente
```

### 14.3 Limpeza de Dados e Timeout por Inatividade

```
LIMPEZA AO FINALIZAR:
Quando um jogo termina (fim natural, /endgame, ou timeout), TODOS os dados
são deletados do banco: games, players, rounds, round_roles, player_round_state,
pairings, spy_guess_votes, manual_configs, e fotos do disco.
→ Nenhum dado de partidas passadas permanece na memória do servidor.

TIMEOUT POR INATIVIDADE:
Timer periódico roda a cada 15 minutos e verifica jogos com updated_at > 2 horas.
Jogos inativos são notificados no grupo ("Jogo encerrado por inatividade")
e têm todos os dados limpos.

NOTA: Timestamps devem usar formato SQLite (YYYY-MM-DD HH:MM:SS), não ISO 8601
com 'T' e 'Z', para garantir comparações lexicográficas corretas.
```

### 14.4 Mensagens: Grupo vs DM

```
REGRA: Mensagens no grupo são SEMPRE em terceira pessoa com o nome do jogador.
Mensagens em segunda pessoa ("Você") vão EXCLUSIVAMENTE para DM.

Exemplos:
  /leave no grupo → DM: "Você saiu do jogo." | Grupo: "*Fulano* abandonou a missão."
  /leave no DM    → Reply: "Você saiu do jogo." | Grupo: "*Fulano* abandonou a missão."
  cantLeaveMidRound no grupo → "*Fulano*, não é possível sair durante uma rodada ativa."
  DM não recebível → Grupo: "*Fulano*, inicie uma conversa comigo primeiro: ..."
```

### 14.5 Bot Não Consegue Enviar DM

```
1. Na entrada: avisar no grupo COM O NOME do jogador: "*Fulano*, inicie uma conversa comigo"
2. No início da rodada: se falhar, avisar no grupo e excluir o jogador da rodada
3. NUNCA revelar informação secreta no grupo
```

### 14.6 Timeout de Convite

```
Convites pendentes expiram após 5 minutos:
1. Status de ambos → 'unpaired'
2. Notificar ambos: "Convite expirado."
```

### 14.7 Rodada Travada

```
Se após 30 minutos nenhuma atividade na rodada:
1. Bot envia lembrete no grupo: "A rodada ainda está ativa! Finalizem seus vereditos."
Se após 60 minutos:
2. Bot oferece ao criador: [Forçar encerramento da rodada]
   → Jogadores sem veredito recebem 0 pontos
```

### 14.8 Espião Não Digita Chute

```
Se espião clica veredito mas não digita em 3 minutos:
→ Considerar chute como vazio (NULL) → espião não acertou local
```

### 14.9 Todos os Jogadores Pareados em Veredito, 1 Isolado

```
A rodada fecha automaticamente quando todos os PAREADOS confirmaram veredito
e resta no máximo 1 jogador isolado (sem par).
O isolado recebe verdict_active = 1 automaticamente.
Bot notifica apenas pareados pendentes: "Faltam vereditos de: {nomes}"
```

### 14.10 Votação Fair Play — Ninguém Vota

```
Se nenhum agente votar dentro de 60 segundos:
→ Chute do espião é considerado INVÁLIDO (spy_guess_approved = 0)
→ Bot exibe: "Nenhum voto recebido. Chute invalidado por padrão."
→ Pontuação calculada normalmente
```

### 14.11 Sala Vazia (Todos Saem)

```
Se o último jogador sai (independente de ser criador ou não):
→ Jogo é encerrado e TODOS os dados são limpos (cleanupGameData)
→ Inclui cenário onde o criador nunca entrou como jogador: se todos os jogadores
  que entraram saem um por um, o último a sair dispara a limpeza.
```

---

## 15. Deploy e Configuração

### 15.1 Variáveis de Ambiente (.env)

```bash
# Telegram
BOT_TOKEN=seu_token_aqui
BOT_USERNAME=SpyActingBot

# Database
DATABASE_URL=./data/spy-acting.db   # Usar ':memory:' para testes

# Photos
PHOTO_STORAGE_PATH=./data/photos

# Game Settings
MIN_PLAYERS=3
MAX_PLAYERS=12
MIN_ROUNDS=3
MAX_ROUNDS=10
INVITE_TIMEOUT_MS=300000        # 5 minutos
ROUND_REMINDER_MS=1800000       # 30 minutos
SPY_GUESS_TIMEOUT_MS=180000     # 3 minutos
VOTE_TIMEOUT_MS=60000           # 60 segundos (votação fair play)

# Logging
LOG_LEVEL=info
```

### 15.2 Scripts npm

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "test": "vitest",
    "test:run": "vitest run",
    "lint": "tsc --noEmit"
  }
}
```

### 15.3 Deploy com PM2

```bash
# Instalar PM2
npm install -g pm2

# Iniciar
pm2 start dist/index.js --name spy-acting-bot

# Auto-restart
pm2 startup
pm2 save

# Monitorar
pm2 logs spy-acting-bot
pm2 monit
```

### 15.4 Deploy: Fly.io (em uso)

O bot está em produção no Fly.io com `Dockerfile` e `fly.toml` na raiz do projeto.
Região: `gru` (São Paulo). VM: 256MB shared CPU.

### 15.5 Esteira de Entrega (CI via Dockerfile)

O `Dockerfile` implementa uma esteira de entrega com gate de testes:

```
fly deploy
  └── Docker Build (multi-stage)
       ├── Stage 1: builder
       │   ├── npm ci (todas as deps incluindo devDeps)
       │   ├── COPY src/ + tests/ + vitest.config.ts
       │   ├── npx vitest run  ← GATE: 314 testes
       │   │   └── Se FALHAR → build para, deploy NÃO acontece
       │   └── npx tsc (compila TypeScript)
       │
       └── Stage 2: runner (imagem final, ~191MB)
            ├── npm ci --omit=dev (só deps de produção)
            ├── COPY dist/ do builder
            └── CMD node dist/index.js
```

Toda alteração passa pela mesma esteira: `fly deploy` roda os testes automaticamente.
Se qualquer teste falhar, o build aborta e o bot em produção permanece na versão anterior.

O timer de cleanup (seção 14.3) inicia automaticamente no boot do bot, sem necessidade de cron externo.

---

## 16. Testes

**Framework:** Vitest com DB in-memory (`:memory:` via `DATABASE_URL`).
**Total:** 282 testes em 15 arquivos. Tempo: ~3s.
**Execução:** `npm test` (watch) ou `npm run test:run` (CI).

Cada arquivo de teste roda em processo isolado (fork) com seu próprio DB in-memory.
`tests/setup.ts` limpa todas as tabelas entre testes via `beforeEach`.

### 16.1 Testes Unitários (77 testes)

| Arquivo | Cobertura |
|---------|-----------|
| `unit/groups.test.ts` (12) | `shuffle` preserva elementos; `calculateGroups` para 3-12 jogadores; spy excluído de todos os grupos; todos agentes agrupados |
| `unit/scoring.test.ts` (19) | `normalizeString` (acentos, case, especiais); `isSpyGuessCorrect` (match exato, case, acentos, errado); `calculateRoundScores` (spy infiltrado, isolado, acertou, errou; agentes corretos, errados, trio) |
| `unit/messages.test.ts` (46) | Todas as 35 mensagens estáticas são strings não-vazias; mensagens dinâmicas contêm parâmetros esperados; `needToStartDm` com/sem nome; `roundResult` formata todas as seções |

### 16.2 Testes de Integração (189 testes)

| Arquivo | Cobertura |
|---------|-----------|
| `integration/lobby.test.ts` (18) | createGame, duplicata, joinGame, sala cheia, leaveGame, transferência de criador, último jogador limpa, rejoin após leave, validateGameStart (min jogadores, sem selfie, válido, já iniciou), updateGameConfig, updatePlayerPhoto |
| `integration/validators.test.ts` (17) | getActiveGame (lobby/não-lobby); getGameById; getPlayersInGame (só ativos); **Bug #1 regression:** getPlayerInGame filtra isActive; getAnyActiveGameForChat (todos os status); **Bug #2 regression:** getPlayerActiveGame com jogo ativo, finished, múltiplos jogos, round_active |
| `integration/pairing.test.ts` (12) | canRequestPairing (válido, self, já pareado, pendente); createPairingRequest + acceptPairing (estados, grupo completo); rejectPairing; undoPairing; getAvailablePlayers; isGroupComplete (duo/trio) |
| `integration/verdict.test.ts` (9) | submitSpyGuess; registerVote (agente, spy bloqueado, duplicata); **Bug #3 regression:** checkRoundClose (fecha com isolado, não fecha com pendente, não fecha sem vereditos, auto-marca isolado) |
| `integration/cleanup.test.ts` (6) | cleanupGameData deleta tudo; não afeta outros jogos; cleanupStaleGames remove antigos; mantém recentes; ignora finished; notifica grupo |
| `integration/photos.test.ts` (8) | **Bug #2 fluxo completo:** selfie salva com sucesso; jogo antigo finished + novo ativo → selfie vai para o novo; múltiplos finished → rejeita; jogador inativo → rejeita; jogo não-lobby → rejeita; foto em grupo → ignora; usuário sem jogo → rejeita; sobrescreve foto anterior |
| `integration/leave-routing.test.ts` (6) | **Obs B regression:** "Você saiu" vai como DM no grupo; grupo recebe 3ª pessoa com nome; DM recebe "Você saiu" como reply; cantLeaveMidRound no grupo usa nome; cantLeaveMidRound no DM usa "Você"; transferência notifica em 3ª pessoa no grupo + DM ao novo criador |
| `integration/regression-gaps.test.ts` (9) | **Bug #1 consistência:** após leave TODAS queries excluem; após rejoin TODAS queries incluem. **Bug #3 min players:** 3 e 5 jogadores. **Obs #1:** spy pareia com agente-trio (grupo esperado=3, incompleto com 2, completo com 3, spy aparece como disponível). **Obs A:** criador nunca entrou + todos saem → limpa |
| `integration/manual-mode-exclusion.test.ts` (7) | Criador-jogador tenta manual → bloqueado; criador não-jogador → permitido; criador tenta join em manual (callback + /join) → bloqueado; jogador normal em manual → permitido; criador em auto → permitido; trocar de manual para auto → permitido |
| `integration/player-counts.test.ts` (28) | **Paramétrico 3-12:** calculateGroups (duplas/trios corretos); rodada fecha com spy isolado; lobby criador-jogador vs criador-configurador (valida início, transferência, cleanup) |
| `integration/full-game-flows.test.ts` (69) | **End-to-end parametrizado:** lobby 3-12 × 4 ordens (join-then-selfie, sequential, reverse-selfie, interleaved); rodada 3-12 × 2 ordens (pareamento seq/reverse); jogo completo 3 rodadas (N=3,5,7,12); substituição no lobby; 13º jogador recusado; ações fora de fase; spy pareia antes/depois dos agentes |

### 16.3 Smoke Tests (8 testes)

| Arquivo | Cobertura |
|---------|-----------|
| `smoke/smoke.test.ts` (8) | Config carrega com env vars; schema exporta todas as tabelas; conexão DB funciona (in-memory); types/VALID_TRANSITIONS; logger tem métodos padrão; messages tem chaves esperadas; engine modules importam; locations.json válido |

### 16.4 Infra de Teste

- **DB in-memory:** `connection.ts` aceita `DATABASE_URL=:memory:` (set via `vitest.config.ts`)
- **Isolamento:** Cada arquivo roda em fork separado com seu próprio DB
- **Reset:** `tests/setup.ts` limpa todas as 8 tabelas entre testes
- **Factories:** `createTestGame`, `createTestPlayer`, `createTestRound`, `createFullRoundScenario`
- **Simulador:** `game-simulator.ts` com `simulateLobby`, `simulateRound`, 4 geradores de ordem
- **Mock API:** `createMockApi()` com `sendMessage`, `sendPhoto` mockados

---

## 17. Diretrizes de Implementação

### 17.1 Ordem de Implementação

```
FASE 1: Fundação — Projeto, banco de dados, bot básico
FASE 2: Lobby — Criação de sala, entrada, selfies, configuração
FASE 3: Motor do Jogo — Locais, grupos, papéis, DMs
FASE 4: Mecânica de Pareamento — Lista, solicitação, aceite/recusa, trio, desfazer
FASE 5: Veredito e Pontuação — Veredito, chute, votação, fechamento, pontuação
FASE 6: Loop do Jogo — Transição entre rodadas, placar, resultado final
FASE 7: Modo Manual — Fluxo do configurador, decisão de chute
FASE 8: Polish — Timeouts, edge cases, testes, documentação
```

### 17.2 Padrões de Código

- async/await em todo lugar (sem callbacks)
- TypeScript strict mode
- Logger (Winston) para toda operação importante
- Strings de mensagem centralizadas em `utils/messages.ts`
- Constantes para magic numbers
- try/catch em cada handler
- Validação de estados antes de transições

### 17.3 Mensagens (Idioma)

- Todas em **português brasileiro**
- Tom divertido e temático (espião, teatro, drama)
- Nunca revelar informações secretas em mensagens de grupo
- Feedback visual com emojis

### 17.4 Considerações de Performance

- SQLite WAL mode para melhor concorrência
- Fotos de jogos finalizados são limpas automaticamente (cleanup timer)
- Timestamps em formato SQLite (`YYYY-MM-DD HH:MM:SS`)

---

## Apêndice A: Exemplo de Mensagens

### Boas-vindas (DM)
```
🎭 Bem-vindo ao SPY ACTING!

Eu sou o bot que vai gerenciar o jogo de dedução e atuação mais dramático do Telegram!

🎯 Como funciona:
• Um grupo de agentes recebe um local secreto e papéis para atuar
• Um espião tenta se infiltrar e descobrir o local
• Encontre seus parceiros pela atuação!

Para criar uma partida, use /newgame em um grupo.
Para ver os comandos, use /help.
```

### Lobby (Grupo)
```
🎬 SPY ACTING — Nova Partida!

Criado por: @criador
Jogadores: 5/12

👥 Na sala:
1. 📸 Alice
2. 📸 Bob
3. 📸 Carol
4. 📸 David
5. 📸 Eve

[🎮 Entrar] [⚙️ Configurar] [🎬 Iniciar]
```

---

## Apêndice B: Checklist de Validação

### Funcionalidades core
- [x] Bot responde a /start no DM
- [x] Bot cria sala com /newgame no grupo
- [x] Jogadores entram e enviam selfie
- [x] Fotos aparecem nos menus de seleção
- [x] DM com informações da rodada chega corretamente
- [x] Espião recebe apenas dica (sem local, sem grupo)
- [x] Agente recebe local, papel, dica e nome do parceiro
- [x] Pareamento funciona (solicitar, aceitar, recusar)
- [x] Trio funciona (adicionar terceiro)
- [x] Desfazer par funciona e notifica todos
- [x] Veredito só aparece para grupo completo
- [x] Espião é solicitado a digitar chute
- [x] Chute com comparação automática funciona (normalização)
- [x] Votação fair play ativa quando comparação automática falha
- [x] Votação expira em 60s e invalida chute por padrão
- [x] Rodada fecha quando todos os pareados confirmam veredito (isolado auto-marcado)
- [x] Pontuação calculada corretamente em todos os cenários
- [x] Placar acumulado funciona
- [x] Múltiplas rodadas funcionam
- [x] Resultado final exibido corretamente
- [x] Nenhuma informação secreta vaza no grupo

### Modo manual
- [x] Configurador define local, dica e personagens por grupo
- [x] Espião é escolhido aleatoriamente (não pelo configurador)
- [x] Distribuição de jogadores para personagens é aleatória
- [x] Configurador decide validade do chute (sem votação)
- [x] Exclusão mútua: criador-jogador NÃO pode ativar modo manual
- [x] Exclusão mútua: criador em modo manual NÃO pode entrar como jogador

### Gestão de partida e recursos
- [x] Transferência de criador quando criador sai do jogo
- [x] Limpeza completa de dados ao finalizar jogo (DB + fotos)
- [x] Timeout por inatividade (2h) com limpeza automática
- [x] Sala vazia (todos saem) → jogo limpo mesmo se criador nunca foi jogador
- [x] Jogador que saiu pode reentrar (/leave + /join funciona corretamente)
- [x] 13º jogador é recusado (sala cheia)

### Mensagens e UX
- [x] Mensagens no grupo SEMPRE em 3ª pessoa com nome do jogador
- [x] "Você" vai exclusivamente para DM
- [x] DM falha → grupo avisa COM NOME do jogador ("Fulano, inicie conversa...")
- [x] Jogador saindo durante rodada → aviso com nome no grupo

### Testes (282 testes, 15 arquivos)
- [x] Unitários: groups, scoring, messages
- [x] Integração: lobby, validators, pairing, verdict, cleanup, photos, handlers
- [x] Regressão: todos os bugs (#1, #2, #3) e observações (Obs #1-#4, A, B)
- [x] Paramétricos: 3-12 jogadores × 4 ordens de lobby × 2 ordens de rodada
- [x] End-to-end: jogos completos multi-rodada, substituição, spy antes/depois
- [x] Smoke: config, schema, DB, types, logger, locations
