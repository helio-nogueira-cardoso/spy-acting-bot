# Spy Acting Bot

Bot de Telegram para jogo de dedução social com improvisação presencial.

Um grupo de agentes recebe um local secreto e papéis temáticos. Cada agente sabe quem é seu parceiro (dupla ou trio) pelo nome do personagem. Um espião infiltrado recebe apenas uma dica vaga e precisa descobrir o local e se infiltrar em um grupo. Os agentes devem se encontrar através de atuação presencial, enquanto identificam o espião.

**Bot:** [@SpyActingBot](https://t.me/SpyActingBot)

## Como jogar

1. Adicione o bot a um grupo do Telegram
2. Use `/newgame` para criar uma sala
3. Jogadores entram clicando no botao ou com `/join`
4. Cada jogador envia uma selfie no DM do bot
5. O criador configura rodadas (3-10) e modo (automatico/manual) e inicia
6. A cada rodada: bot distribui local, papeis e dica via DM
7. Jogadores interagem presencialmente, atuando seus papeis
8. Via bot: solicitam pareamento, aceitam/recusam, confirmam veredito
9. Rodada fecha quando todos os pareados confirmaram
10. Apos todas as rodadas: placar final e ranking

## Stack

- **Runtime:** Node.js 20
- **Linguagem:** TypeScript
- **Bot Framework:** [grammY](https://grammy.dev)
- **Banco de Dados:** SQLite via better-sqlite3
- **ORM:** Drizzle ORM
- **Testes:** Vitest (314 testes)
- **Deploy:** Fly.io (Sao Paulo / gru)

## Setup local

```bash
# Instalar dependencias
npm install

# Configurar variaveis de ambiente
cp .env.example .env
# Editar .env com seu BOT_TOKEN

# Rodar em desenvolvimento
npm run dev

# Rodar testes
npm test        # watch mode
npm run test:run # single run
```

## Comandos do bot

| Comando | Contexto | Descricao |
|---------|----------|-----------|
| `/start` | DM | Iniciar conversa com o bot |
| `/newgame` | Grupo | Criar nova sala de jogo |
| `/join` | Grupo | Entrar na sala ativa |
| `/leave` | Grupo/DM | Sair da sala atual |
| `/status` | Grupo/DM | Ver estado do jogo |
| `/help` | Qualquer | Regras e comandos |
| `/endgame` | Grupo | Encerrar jogo (criador) |

## Testes

314 testes cobrindo:

- **Unitarios:** Grupos, pontuacao, mensagens
- **Integracao:** Lobby, validadores, pareamento, veredito, cleanup, fotos, handlers
- **Regressao:** Bugs corrigidos e observacoes implementadas
- **Parametricos:** 3-12 jogadores x multiplas ordens de acoes
- **End-to-end:** Jogos completos multi-rodada
- **Edge cases:** Limites, estados invalidos, idempotencia
- **Smoke:** Config, schema, DB, types

```bash
npm run test:run

# 16 arquivos, 314 testes, ~3s
```

## Deploy

O deploy no Fly.io inclui uma esteira de entrega integrada ao Dockerfile:

```bash
fly deploy
```

Os testes rodam automaticamente durante o build. Se qualquer teste falhar, o deploy e abortado e o bot em producao permanece na versao anterior.

## Estrutura

```
src/
  bot.ts              # Instancia grammY + middleware
  index.ts            # Entry point
  config.ts           # Variaveis de ambiente
  db/
    schema.ts         # Tabelas Drizzle
    connection.ts     # SQLite connection
  engine/
    lobby.ts          # Criar/entrar/sair + transferencia de criador
    round.ts          # Iniciar rodada, distribuir papeis
    groups.ts         # Calculo de duplas/trios
    pairing.ts        # Solicitacao, aceite, recusa, desfazer
    verdict.ts        # Veredito e fechamento de rodada
    scoring.ts        # Calculo de pontos
    cleanup.ts        # Limpeza de dados e timeout por inatividade
  handlers/
    commands.ts       # /start, /newgame, /join, /leave, etc.
    callbacks.ts      # Botoes inline
    photos.ts         # Recepcao de selfies
    conversations.ts  # Fluxos multi-step (config manual, chute do espiao)
  utils/
    messages.ts       # Todas as mensagens (PT-BR)
    validators.ts     # Queries e validacoes de estado
    photo-store.ts    # Paths de fotos
    logger.ts         # Winston logger
  data/
    locations.json    # Locais com papeis e dicas
tests/
  setup.ts            # Reset do DB entre testes
  helpers/            # Factories, mock API, simulador de jogo
  unit/               # Grupos, pontuacao, mensagens
  integration/        # Lobby, validators, pairing, verdict, cleanup, etc.
  smoke/              # Config, schema, DB
```

## Licenca

MIT
