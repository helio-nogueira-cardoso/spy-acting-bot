// Todos os textos do bot em Português Brasileiro
// Tom: divertido, temático (espião + teatro)

export const messages = {
  // ─── /start (DM) ──────────────────────────────────────────────
  welcome: `
🕵️‍♂️ *Bem-vindo ao SPY ACTING!* 🎭

_Infiltração Dramática — O jogo de dedução social com improvisação presencial!_

Aqui, agentes secretos recebem missões, papéis e parceiros. Mas cuidado... há um espião entre vocês! 👀

*Como jogar:*
1️⃣ Alguém cria uma sala num grupo com /newgame
2️⃣ Jogadores entram e enviam uma selfie 📸
3️⃣ Cada rodada: você recebe um local secreto, um papel e seu parceiro
4️⃣ Encontre seu par através de atuação presencial 🎬
5️⃣ Cuidado com o espião tentando se infiltrar!

Use /help para ver todos os comandos.
_Adicione-me a um grupo para começar!_ 🚀
`.trim(),

  // ─── /help ────────────────────────────────────────────────────
  help: `
🎭 *SPY ACTING — Comandos* 🕵️

*No grupo:*
/newgame — Criar nova sala de jogo
/join — Entrar na sala ativa
/leave — Sair da sala
/status — Ver estado do jogo
/endgame — Encerrar jogo (só criador)

*No privado (DM):*
/start — Iniciar conversa com o bot
/help — Ver esta mensagem
/status — Ver estado do seu jogo
/leave — Sair da sala atual
/cancel — Cancelar operação em andamento

*Como funciona:*
🎬 Cada rodada, agentes recebem um local secreto e papéis temáticos
🤝 Encontre seu parceiro através de improvisação presencial
🕵️ Um espião tenta descobrir o local e se infiltrar
✅ Quando todos confirmarem seus pares, a rodada encerra
🏆 Pontuação baseada em acertos — vence quem pontuar mais!

_Dica: interaja presencialmente, atue seu papel e desconfie de todos!_ 🎭
`.trim(),

  // ─── Lobby ────────────────────────────────────────────────────
  gameCreated: (gameId: string) => `
🎬 *Nova sala de SPY ACTING criada!* 🕵️

Clique no botão abaixo para entrar na missão.
Cada agente deve enviar uma selfie no meu DM para identificação.

_Mínimo 3 jogadores. Máximo 12._
`.trim(),

  lobbyStatus: (playerNames: string[], maxPlayers: number) => `
🎭 *Agentes na sala:* ${playerNames.length}/${maxPlayers}

${playerNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}

_Aguardando mais agentes ou início do jogo..._
`.trim(),

  joinedGame: (name: string) => `✅ *${name}* entrou na missão! Envie uma selfie no meu DM.`,

  dmWelcomePlayer: `
🕵️ *Bem-vindo à missão, agente!*

📸 Envie uma *selfie* para sua identificação.
Isso ajudará os outros agentes a te reconhecer durante a operação.

_Apenas uma foto. Pode ser selfie, avatar ou qualquer imagem._
`.trim(),

  selfieReceived: '📸 Selfie recebida! ✅\n\n_Aguardando o início do jogo. Fique de olho no grupo!_',

  selfieAlreadySent: '📸 Você já enviou sua selfie! Aguarde o início do jogo.',

  noGameForSelfie: '🤔 Você não está em nenhum jogo ativo. Entre em um jogo primeiro!',

  needToStartDm: (botUsername: string, playerName?: string) =>
    playerName
      ? `⚠️ *${playerName}*, inicie uma conversa comigo primeiro: t.me/${botUsername}`
      : `⚠️ Inicie uma conversa comigo primeiro! Clique: t.me/${botUsername}`,

  alreadyInGame: '⚠️ Você já está neste jogo!',

  gameFull: '🚫 Sala cheia! Máximo de 12 jogadores.',

  // ─── Configuração ─────────────────────────────────────────────
  configMenu: (totalRounds: number, mode: string) => `
⚙️ *Configuração da Missão*

🔄 Rodadas: *${totalRounds}*
🎮 Modo: *${mode === 'auto' ? '🤖 Automático' : '✍️ Manual'}*

_Escolha o que configurar:_
`.trim(),

  configRoundsPrompt: '🔄 Quantas rodadas?\n\n_Escolha entre 3 e 10:_',

  configRoundsSet: (n: number) => `✅ Rodadas definidas: *${n}*`,

  configModePrompt: `
🎮 *Modo do jogo:*

🤖 *Automático* — O bot escolhe locais, papéis e dicas automaticamente
✍️ *Manual* — Um configurador define o tema de cada rodada

_Escolha:_
`.trim(),

  configModeSet: (mode: string) =>
    `✅ Modo definido: *${mode === 'auto' ? '🤖 Automático' : '✍️ Manual'}*`,

  onlyCreatorCanConfig: '🔒 Apenas o criador da sala pode configurar o jogo.',

  onlyCreatorCanStart: '🔒 Apenas o criador da sala pode iniciar o jogo.',

  // ─── Início do jogo ──────────────────────────────────────────
  gameStarting: '🎬 *A MISSÃO VAI COMEÇAR!*\n\n_Verificando agentes... Fiquem atentos aos DMs!_',

  gameStartErrors: (errors: string[]) =>
    `❌ *Não foi possível iniciar:*\n\n${errors.map(e => `• ${e}`).join('\n')}`,

  gameStarted: (totalRounds: number) => `
🕵️ *MISSÃO INICIADA!* 🎭

📋 Total de rodadas: *${totalRounds}*
🎬 Preparando a primeira rodada...

_Fiquem atentos aos seus DMs!_
`.trim(),

  // ─── Leave ────────────────────────────────────────────────────
  playerLeft: (name: string) => `👋 *${name}* abandonou a missão.`,
  youLeft: '👋 Você saiu do jogo.',
  cantLeaveMidRound: '⚠️ Você está no meio de uma rodada! Confirme seu veredito primeiro ou use /endgame no grupo.',

  // ─── End game ─────────────────────────────────────────────────
  gameEnded: '🏁 *Jogo encerrado pelo criador.*\n\n_Até a próxima missão!_ 🕵️',
  onlyCreatorCanEnd: '🔒 Apenas o criador da sala pode encerrar o jogo.',

  // ─── Status ───────────────────────────────────────────────────
  statusLobby: (playerCount: number, maxPlayers: number) =>
    `📊 *Status:* Lobby aberto\n👥 Jogadores: ${playerCount}/${maxPlayers}`,

  statusPlaying: (currentRound: number, totalRounds: number) =>
    `📊 *Status:* Jogo em andamento\n🎬 Rodada: ${currentRound}/${totalRounds}`,

  // ─── Round ────────────────────────────────────────────────────
  roundStartGroup: (roundNumber: number, totalRounds: number) => `
🎬 *RODADA ${roundNumber}/${totalRounds} INICIOU!*

📩 Verifiquem seus DMs para receber suas missões secretas!

_Hora de atuar... e desconfiar!_ 🕵️🎭
`.trim(),

  agentDm: (roundNumber: number, totalRounds: number, location: string, character: string, spyHint: string, partnerInfo: string) => `
🎭 *RODADA ${roundNumber}/${totalRounds}*

📍 *Local:* ${location}
🎪 *Seu Papel:* ${character}
💡 *Dica do Espião:* "${spyHint}"

👥 *${partnerInfo}*

⚠️ _Cuidado! Há um espião entre vocês!_
_Encontre seu parceiro através da atuação presencial._
`.trim(),

  spyDm: (roundNumber: number, totalRounds: number, spyHint: string, disguise: string) => `
🎭 *RODADA ${roundNumber}/${totalRounds}*

🕵️ *Você é o ESPIÃO!*
💡 *Sua Dica:* "${spyHint}"
🎪 *Seu Disfarce:* "${disguise}"

🎯 *Missão:*
• Descubra o local secreto
• Infiltre-se em qualquer grupo
• Não seja descoberto!

_Use a dica e a atuação dos outros para descobrir o local!_
`.trim(),

  // ─── Pareamento ───────────────────────────────────────────────
  roundMenu: (roundNumber: number, pairingStatus: string) => {
    const statusEmoji: Record<string, string> = {
      unpaired: '🔴 Sem par',
      pending_sent: '⏳ Convite enviado',
      pending_received: '📩 Convite recebido',
      paired: '✅ Em grupo',
    };
    return `
🎭 *Rodada ${roundNumber} — Ações*

Status: ${statusEmoji[pairingStatus] || pairingStatus}
`.trim();
  },

  choosePairTarget: '🤝 *Escolha um agente para formar par:*\n\n_Selecione alguém que você acredita ser seu parceiro._',

  pairRequestSent: (targetName: string) =>
    `📨 Convite enviado para *${targetName}*! Aguardando resposta...`,

  pairRequestReceived: (requesterName: string) =>
    `🤝 *Convite de Par!*\n\n*${requesterName}* quer formar par com você!`,

  pairAccepted: (partnerName: string) =>
    `✅ *Par formado com ${partnerName}!*`,

  pairRejected: '❌ Convite recusado.',

  pairRejectedNotification: (name: string) =>
    `❌ *${name}* recusou seu convite.`,

  pairUndoConfirm: '⚠️ *Tem certeza que quer desfazer o par?*\n\n_Todos os membros do grupo voltarão ao status "sem par"._',

  pairUndone: (name: string) =>
    `💔 O par/trio foi desfeito por *${name}*!`,

  groupIncomplete: (missing: number) =>
    `👥 Grupo incompleto. Falta *${missing}* membro(s).`,

  groupComplete: '👥 *Grupo completo!* ✅\n\n_Quando estiver satisfeito, confirme seu veredito._',

  alreadyPaired: '⚠️ Você já está em um grupo!',
  targetNotAvailable: '⚠️ Este jogador não está disponível.',
  cantPairSelf: '⚠️ Você não pode formar par consigo mesmo!',
  noPendingRequest: '⚠️ Nenhum convite pendente.',

  addToGroupPrompt: '🤝 *Adicionar ao grupo:*\n\n_Escolha um agente disponível para completar seu trio._',

  trioFormed: (names: string[]) =>
    `✅ *Trio formado!*\n👥 ${names.join(', ')}`,

  // ─── Veredito ─────────────────────────────────────────────────
  verdictButton: '✅ *Confirmar Veredito*\n\n_Ao confirmar, você declara que encontrou seu grupo final._',

  spyGuessPrompt: `
🕵️ *Hora do chute!*

Você é o espião. Digite o nome do local que você acha que é o correto:

_Dica: tente lembrar das conversas e atuações dos agentes._
`.trim(),

  verdictConfirmed: '✅ *Veredito registrado!*\n\n_Aguardando os outros agentes..._',

  verdictWaiting: (confirmed: number, total: number) =>
    `⏳ Vereditos: ${confirmed}/${total}`,

  missingVerdicts: (names: string[]) =>
    `⏳ Faltam vereditos de: *${names.join(', ')}*`,

  // ─── Votação Fair Play ────────────────────────────────────────
  fairPlayVote: (spyGuess: string, correctLocation: string) => `
⚖️ *FAIR PLAY — Validação do Chute*

🕵️ O espião chutou: *"${spyGuess}"*
📍 O local correto era: *"${correctLocation}"*

O chute do espião é válido?

_⏳ Votação encerra em 60 segundos_
`.trim(),

  fairPlayResult: (approved: boolean, yesVotes: number, noVotes: number) =>
    approved
      ? `✅ Chute aprovado! (${yesVotes} sim / ${noVotes} não)`
      : `❌ Chute invalidado! (${yesVotes} sim / ${noVotes} não)`,

  fairPlayNoVotes: '❌ Nenhum voto recebido. Chute invalidado por padrão.',

  // ─── Resultado da Rodada ──────────────────────────────────────
  roundResult: (data: {
    roundNumber: number;
    totalRounds: number;
    location: string;
    spyName: string;
    spyHint: string;
    spyGuess: string | null;
    spyGuessResult: string;
    correctGroups: string;
    formedGroups: string;
    scores: string;
    leaderboard: string;
  }) => `
🎬 *RODADA ${data.roundNumber}/${data.totalRounds} — RESULTADO*

📍 Local: *${data.location}*
🕵️ Espião: *${data.spyName}*
💡 Dica: "${data.spyHint}"
🎯 Chute do espião: ${data.spyGuess ? `"${data.spyGuess}" ${data.spyGuessResult}` : '_Não chutou_ ❌'}

👥 *GRUPOS CORRETOS:*
${data.correctGroups}

🤝 *GRUPOS FORMADOS:*
${data.formedGroups}

📊 *PONTUAÇÃO DA RODADA:*
${data.scores}

🏆 *PLACAR ACUMULADO:*
${data.leaderboard}
`.trim(),

  // ─── Próxima rodada / Fim ─────────────────────────────────────
  nextRound: (seconds: number) =>
    `⏳ *Próxima rodada em ${seconds} segundos...*`,

  finalResult: (leaderboard: string) => `
🏆 *RESULTADO FINAL — SPY ACTING* 🎭

${leaderboard}

_Obrigado por jogar! Até a próxima missão!_ 🕵️
`.trim(),

  // ─── Modo Manual ──────────────────────────────────────────────
  manualConfigStart: (roundNumber: number) =>
    `⚙️ *Configure a Rodada ${roundNumber}:*`,

  manualLocationPrompt: '📍 *Digite o nome do local:*',

  manualHintPrompt: '💡 *Digite a dica para o espião:*',

  manualGroupStructure: (structure: string) =>
    `🎭 *Estrutura da rodada:*\n\n${structure}`,

  manualCharactersPrompt: (groupNumber: number, groupType: string, size: number) =>
    `🎭 *Grupo ${groupNumber} (${groupType})*\nDigite os ${size} personagens separados por vírgula:`,

  manualConfirmation: (summary: string) =>
    `📋 *RESUMO DA RODADA*\n\n${summary}`,

  manualSpyGuessDecision: (guess: string, location: string) =>
    `🕵️ O espião chutou: *"${guess}"*\nO local era: *"${location}"*\n\nO chute é válido?`,

  // ─── Erros genéricos ──────────────────────────────────────────
  errorGeneric: '❌ Ops! Algo deu errado. Tente novamente.',
  errorDmOnly: '🔒 Este comando funciona apenas no privado (DM).',
  errorGroupOnly: '👥 Este comando funciona apenas em grupos.',
  errorNoActiveGame: '🚫 Não há jogo ativo neste grupo. Use /newgame para criar um!',
  errorNotInGame: '🚫 Você não está em nenhum jogo no momento.',
} as const;
