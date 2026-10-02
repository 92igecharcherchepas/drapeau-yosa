import 'dotenv/config';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { LeaderboardManager } from './leaderboards.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const questionBank = JSON.parse(await readFile(path.join(root, 'data', 'questions.json'), 'utf8'));
const scorePath = path.join(root, 'data', 'scores.json');
const botSettingsPath = path.join(root, 'data', 'bot-settings.json');
const BOT_OWNER_ID = '226447179877842944';
let ownerOnlyMode = await loadBotSettings();
const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
const activeGames = new Map();
const V2 = MessageFlags.IsComponentsV2;
const ANSWER_TIME_MS = 20_000;
const TIMEOUT_CLEANUP_DELAY_MS = 5_000;
const NEXT_QUESTION_DELAY_MS = 1_800;
const AUTOMATIC_QUIZ_INTERVAL_MS = 60 * 60_000;
const SCORE_TIME_ZONE = 'Europe/Paris';
const scoreDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN et DISCORD_CLIENT_ID doivent être définis dans .env.');
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('set')
    .setDescription('Configurer les classements du serveur')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
      group
        .setName('score')
        .setDescription('Configurer le salon des classements')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('quiz')
            .setDescription('Choisir le salon du classement quiz')
            .addChannelOption((option) =>
              option
                .setName('salon')
                .setDescription('Salon du Top 10 quiz')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('message')
            .setDescription('Choisir le salon du classement messages')
            .addChannelOption((option) =>
              option
                .setName('salon')
                .setDescription('Salon du Top 10 messages')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName('vocal')
            .setDescription('Choisir le salon du classement vocal')
            .addChannelOption((option) =>
              option
                .setName('salon')
                .setDescription('Salon du Top 10 vocal')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName('quiz')
        .setDescription('Configurer le quiz automatique')
        .addSubcommand((subcommand) =>
          subcommand
            .setName('automatique')
            .setDescription('Choisir le salon du quiz automatique horaire')
            .addChannelOption((option) =>
              option
                .setName('salon')
                .setDescription('Salon de discussion où poser les questions')
                .setRequired(true)
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
            ),
        ),
    ),
  new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Lancer un quiz et consulter les scores')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('demarrer')
        .setDescription('Lancer une partie dans ce salon')
        .addStringOption((option) =>
          option
            .setName('theme')
            .setDescription('Choisir le thème du quiz')
            .setRequired(true)
            .addChoices(
              { name: 'Drapeaux', value: 'drapeaux' },
              { name: 'Culture générale', value: 'culture' },
              { name: 'Mixte', value: 'mixte' },
            ),
        )
        .addIntegerOption((option) =>
          option
            .setName('questions')
            .setDescription('Nombre de questions (1 à 20)')
            .setMinValue(1)
            .setMaxValue(20),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('arreter').setDescription('Arrêter la partie en cours dans ce salon'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('scores').setDescription('Afficher le Top 10 des points de la semaine'),
    ),
].map((command) => command.toJSON());

async function publishSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);
  await rest.put(route, { body: slashCommands });
  console.log(`Commandes slash synchronisées ${DISCORD_GUILD_ID ? 'sur le serveur' : 'globalement'}.`);
}

function normalize(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parisDateParts(date = new Date()) {
  return Object.fromEntries(
    scoreDateFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

function scoreDayKey(date = new Date()) {
  const { year, month, day } = parisDateParts(date);
  return `${year}-${month}-${day}`;
}

function scoreDaysForPeriod(days, date = new Date()) {
  const { year, month, day } = parisDateParts(date);
  return Array.from({ length: days }, (_, offset) =>
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) - offset)).toISOString().slice(0, 10));
}

function currentWeekScoreDays(date = new Date()) {
  const { year, month, day } = parisDateParts(date);
  const todayUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const weekday = new Date(todayUtc).getUTCDay();
  const mondayUtc = todayUtc - ((weekday + 6) % 7) * 86_400_000;
  const count = Math.floor((todayUtc - mondayUtc) / 86_400_000) + 1;
  return Array.from({ length: count }, (_, offset) =>
    new Date(mondayUtc + offset * 86_400_000).toISOString().slice(0, 10));
}

function rankingForScoreDays(scores, guildId, limit, days) {
  return Object.values(scores)
    .filter((score) => score.guildId === guildId)
    .map((score) => {
      const rankingPoints = days.reduce((total, date) => {
        const daily = score.history?.[date];
        return total + (daily?.points ?? (score.dailyDate === date ? score.dailyPoints ?? 0 : 0));
      }, 0);
      const rankingCorrect = days.reduce((total, date) => {
        const daily = score.history?.[date];
        return total + (daily?.correct ?? (score.dailyDate === date ? score.dailyCorrect ?? 0 : 0));
      }, 0);
      return { ...score, rankingPoints, rankingCorrect };
    })
    .filter((score) => score.rankingPoints > 0)
    .sort((left, right) => right.rankingPoints - left.rankingPoints)
    .slice(0, limit);
}

function weeklyRanking(scores, guildId, limit) {
  return rankingForScoreDays(scores, guildId, limit, currentWeekScoreDays()).map((score) => ({
    ...score,
    weeklyPoints: score.rankingPoints,
    weeklyCorrect: score.rankingCorrect,
  }));
}

function periodRanking(scores, guildId, limit, days) {
  return rankingForScoreDays(scores, guildId, limit, scoreDaysForPeriod(days));
}

function quizRankingLines(ranking) {
  return ranking.map((score, index) => {
    const rank = String(index + 1).padStart(2, '0');
    return `\`${rank}.\` <@${score.userId}> · **${score.weeklyPoints.toLocaleString('fr-FR')} pts** (${score.weeklyCorrect} bonnes rép.)`;
  }).join('\n');
}

function panel(title, body, { image, ephemeral = false, footer } = {}) {
  const components = [
    { type: 10, content: `## ${title}` },
    { type: 14, divider: true, spacing: 1 },
    { type: 10, content: body },
  ];

  if (image) {
    components.push(
      { type: 14, divider: true, spacing: 1 },
      { type: 12, items: [{ media: { url: image } }] },
    );
  }

  if (footer) {
    components.push(
      { type: 14, divider: true, spacing: 1 },
      { type: 10, content: footer },
    );
  }

  return {
    flags: V2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    allowedMentions: { parse: [] },
    components: [{ type: 17, accent_color: 0x808080, components }],
  };
}

async function loadScores() {
  try {
    return JSON.parse(await readFile(scorePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function loadBotSettings() {
  try {
    const settings = JSON.parse(await readFile(path.join(root, 'data', 'bot-settings.json'), 'utf8'));
    return settings.ownerOnlyMode === true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function saveBotSettings() {
  await mkdir(path.dirname(botSettingsPath), { recursive: true });
  const temporaryPath = `${botSettingsPath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ ownerOnlyMode }, null, 2), 'utf8');
  await rename(temporaryPath, botSettingsPath);
}

async function saveScores(scores) {
  await mkdir(path.dirname(scorePath), { recursive: true });
  const temporaryPath = `${scorePath}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(scores, null, 2), 'utf8');
  await rename(temporaryPath, scorePath);
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function pointsFor(elapsedMs) {
  return elapsedMs <= 4_000 ? 15 : elapsedMs <= 7_000 ? 10 : 5;
}

function gameKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function categoryLabel(category) {
  return category === 'drapeaux' ? 'DRAPEAUX' : 'CULTURE GÉNÉRALE';
}

async function sendQuestion(game) {
  if (game.stopped) return;
  if (game.index >= game.questions.length) {
    await finishGame(game);
    return;
  }

  const question = game.questions[game.index];
  const body = [
    `### ${question.prompt}`,
    question.image ? '' : '',
    `\n${Math.round(ANSWER_TIME_MS / 1000)}s pour répondre`,
  ].filter(Boolean).join('\n');

  game.current = { question, startedAt: Date.now(), answered: false, timeout: undefined };
  try {
    game.current.questionMessage = await game.channel.send(panel(
      `QUIZ · ${categoryLabel(question.category)} — ${game.index + 1}/${game.questions.length}`,
      body,
      { image: question.image },
    ));
  } catch (error) {
    console.error('Impossible d’envoyer la question :', error);
    await stopGame(game);
    return;
  }

  game.current.timeout = setTimeout(async () => {
    if (game.stopped || game.current?.answered) return;
    game.current.answered = true;
    const questionMessage = game.current.questionMessage;
    const answerMessage = await game.channel.send(panel(
      'Temps écoulé',
      `La bonne réponse était **${question.answer}**.`,
    ));
    setTimeout(() => {
      void Promise.allSettled([
        questionMessage?.delete(),
        answerMessage.delete(),
      ]);
    }, TIMEOUT_CLEANUP_DELAY_MS).unref?.();
    game.current = null;
    game.index += 1;
    setTimeout(() => sendQuestion(game), NEXT_QUESTION_DELAY_MS);
  }, ANSWER_TIME_MS);
}

async function recordAnswer(game, message) {
  const current = game.current;
  if (!current || current.answered || message.author.bot) return;
  const acceptedAnswers = [current.question.answer, ...current.question.accept];
  const response = normalize(message.content);
  if (!acceptedAnswers.some((answer) => normalize(answer) === response)) return;

  current.answered = true;
  clearTimeout(current.timeout);
  const elapsedMs = Date.now() - current.startedAt;
  const points = pointsFor(elapsedMs);
  const scores = await loadScores();
  const key = `${game.guildId}:${message.author.id}`;
  const score = scores[key] ?? { guildId: game.guildId, userId: message.author.id, username: message.author.username, points: 0, correct: 0 };
  score.username = message.author.username;
  score.points += points;
  score.correct += 1;
  const today = scoreDayKey();
  score.history ??= {};
  const retainedScoreDays = new Set(scoreDaysForPeriod(28));
  for (const date of Object.keys(score.history)) {
    if (!retainedScoreDays.has(date)) delete score.history[date];
  }
  if (!score.history[today] && score.dailyDate === today) {
    score.history[today] = { points: score.dailyPoints ?? 0, correct: score.dailyCorrect ?? 0 };
  }
  score.history[today] ??= { points: 0, correct: 0 };
  score.history[today].points += points;
  score.history[today].correct += 1;
  if (score.dailyDate !== today) {
    score.dailyDate = today;
    score.dailyPoints = 0;
    score.dailyCorrect = 0;
  }
  score.dailyPoints += points;
  score.dailyCorrect += 1;
  scores[key] = score;
  await saveScores(scores);
  leaderboardManager.scheduleRefresh(game.guildId);

  try {
    await current.questionMessage?.delete();
  } catch (error) {
    console.error('Impossible de supprimer la question :', error);
  }

  await game.channel.send(panel(
    'Bonne réponse !',
    `✅ **${message.author.username}** prend les points. (${(elapsedMs / 1000).toFixed(2)}s) *(+${points} pts)*`,
  ));

  game.current = null;
  game.index += 1;
  setTimeout(() => sendQuestion(game), NEXT_QUESTION_DELAY_MS);
}

async function finishGame(game) {
  if (game.stopped) return;
  game.stopped = true;
  activeGames.delete(game.key);
  const scores = await loadScores();
  const ranking = weeklyRanking(scores, game.guildId, 5);
  const lines = ranking.length
    ? quizRankingLines(ranking)
    : 'Aucun point marqué cette semaine.';
  const updatedTimestamp = Math.floor(Date.now() / 1000);
  await game.channel.send(panel(
    '🏆 Classement Quiz',
    `Points gagnés sur les 7 derniers jours.\n\n${lines}`,
    { footer: `Dernière mise à jour : <t:${updatedTimestamp}:f>` },
  ));
}

async function stopGame(game) {
  if (game.current?.timeout) clearTimeout(game.current.timeout);
  game.stopped = true;
  activeGames.delete(game.key);
}

async function showLeaderboard(interaction) {
  const scores = await loadScores();
  const ranking = weeklyRanking(scores, interaction.guildId, 10);
  const body = ranking.length
    ? quizRankingLines(ranking)
    : 'Aucun point marqué cette semaine. Lance une partie avec `/quiz demarrer` !';
  const updatedTimestamp = Math.floor(Date.now() / 1000);
  await interaction.reply(panel(
    '🏆 Classement Quiz',
    `Classement des points gagnés cette semaine.\n\n${body}`,
    { footer: `Dernière mise à jour : <t:${updatedTimestamp}:f>` },
  ));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const leaderboardManager = new LeaderboardManager(root, client, async (guildId, { days = 7, limit = 10, currentWeek = false } = {}) => {
  const scores = await loadScores();
  return currentWeek
    ? weeklyRanking(scores, guildId, limit)
    : periodRanking(scores, guildId, limit, days);
});
await leaderboardManager.load();

async function launchAutomaticFlagQuiz(guildId, config) {
  if (!config) return;
  const key = gameKey(guildId, config);
  if (activeGames.has(key)) return;
  const channel = await client.channels.fetch(config);
  if (!channel?.isTextBased()) return;
  const question = { ...shuffled(questionBank.drapeaux)[0], category: 'drapeaux' };
  const game = {
    key,
    guildId,
    channel,
    questions: [question],
    index: 0,
    current: null,
    stopped: false,
  };
  activeGames.set(key, game);
  await sendQuestion(game);
}

function startAutomaticQuizSchedule() {
  const timer = setInterval(() => {
    for (const [guildId, config] of Object.entries(leaderboardManager.boards)) {
      void launchAutomaticFlagQuiz(guildId, config.automaticQuizChannelId).catch((error) => {
        console.error(`Impossible de lancer le quiz automatique pour ${guildId} :`, error);
      });
    }
  }, AUTOMATIC_QUIZ_INTERVAL_MS);
  timer.unref?.();
}

client.once(Events.ClientReady, async () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
  client.user.setActivity('.gg/yosa', {
    type: ActivityType.Streaming,
    url: 'https://www.twitch.tv/yosa',
  });
  await leaderboardManager.initializeVoiceSessions();
  await leaderboardManager.refreshAll();
  leaderboardManager.scheduleDailyRefresh();
  leaderboardManager.startVoiceRefresh();
  startAutomaticQuizSchedule();
});

client.on('messageCreate', (message) => {
  if (!message.guild || message.author.bot) return;

  if (message.content.trim().toLocaleLowerCase('fr') === '.dev') {
    if (message.author.id !== BOT_OWNER_ID) {
      void message.reply('Cette commande est réservée au propriétaire du bot.').catch(console.error);
      return;
    }
    void (async () => {
      ownerOnlyMode = !ownerOnlyMode;
      await saveBotSettings();
      await message.reply(ownerOnlyMode
        ? 'Mode développeur activé : seul le propriétaire peut utiliser le bot.'
        : 'Mode développeur désactivé : le bot est de nouveau accessible à tous.');
    })().catch((error) => console.error('Impossible de modifier le mode développeur :', error));
    return;
  }

  if (ownerOnlyMode && message.author.id !== BOT_OWNER_ID) return;

  const leaderboardCommand = message.content.trim().match(/^\.leaderboard(?:\s+<@&(\d+)>)?$/i);
  if (leaderboardCommand) {
    const roleId = leaderboardCommand[1];
    if (!roleId) {
      void leaderboardManager.leaderboardPayload(message.guildId).then((payload) => message.channel.send(payload)).catch(console.error);
      return;
    }
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      void message.reply('Il faut la permission « Gérer le serveur » pour configurer le rôle du podium.').catch(console.error);
      return;
    }
    void (async () => {
      const role = await message.guild.roles.fetch(roleId).catch(() => null);
      if (!role) {
        await message.reply('Ce rôle est introuvable sur le serveur.');
        return;
      }
      await leaderboardManager.configurePodiumRole(message.guildId, role);
      await message.reply(`Le rôle **${role.name}** est configuré pour les membres du Top 3 Quiz, Messages ou Vocal.`);
    })().catch((error) => {
      console.error('Impossible de configurer le rôle du podium :', error);
      void message.reply('Configuration impossible. Vérifie les permissions et la position du rôle du bot.').catch(console.error);
    });
    return;
  }

  if (message.content.trim().toLocaleLowerCase('fr') === '.help') {
    const body = [
      '### Quiz',
      '`/quiz demarrer` lance une partie dans le salon (drapeaux, culture ou mixte).',
      '`/quiz arreter` arrête la partie du salon.',
      '`/quiz scores` affiche le classement Quiz de la semaine en cours.',
      'Les réponses se donnent par message. Les questions durent 20 secondes.',
      '',
      '### Configuration · permission Gérer le serveur',
      '`/set score quiz salon` configure le panneau du classement Quiz.',
      '`/set score message salon` configure le panneau du classement Messages.',
      '`/set score vocal salon` configure le panneau du classement Vocal.',
      '`/set quiz automatique salon` choisit où publier un quiz de drapeau chaque heure.',
      '`.leaderboard` affiche les Top 10 Quiz, Messages et Vocal avec un menu 7/14/28 jours.',
      '`.leaderboard @rôle` configure le rôle commun des Top 3 (rôle sans permissions; Gérer les rôles requis pour le bot).',
      '',
      '### Gestion du bot',
      '`.help` affiche cette aide.',
      '`.dev` active ou désactive le mode réservé au propriétaire du bot (commande réservée au propriétaire).',
      '`.config` fait quitter le bot du serveur (permission Gérer le serveur).',
    ].join('\n');
    void message.channel.send(panel('Aide du bot', body)).catch(console.error);
    return;
  }

  if (message.guildId && !message.author.bot) {
    void leaderboardManager.recordMessage(message).catch(console.error);
  }
  if (message.content.trim().toLocaleLowerCase('fr') === '.config') {
    if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      void message.reply('Il faut la permission « Gérer le serveur » pour utiliser cette commande.').catch(console.error);
      return;
    }
    void (async () => {
      await message.channel.send('Le bot quitte le serveur.');
      await message.guild.leave();
    })().catch((error) => console.error('Impossible de quitter le serveur :', error));
    return;
  }
  const game = activeGames.get(gameKey(message.guildId, message.channelId));
  if (game) void recordAnswer(game, message).catch(console.error);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  void leaderboardManager.handleVoiceStateUpdate(oldState, newState).catch(console.error);
});

client.on('interactionCreate', async (interaction) => {
  if (ownerOnlyMode && interaction.user.id !== BOT_OWNER_ID) {
    if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu()) return;
    await interaction.reply({
      content: 'Le bot est actuellement réservé à son propriétaire.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('leaderboard-period:')) {
    const [guildId] = interaction.customId.slice('leaderboard-period:'.length).split(':');
    const days = Number(interaction.values[0]);
    if (interaction.guildId !== guildId || ![7, 14, 28].includes(days)) {
      await interaction.reply({ content: 'Cette sélection de classement n’est pas valide.', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await interaction.update(await leaderboardManager.leaderboardPayload(guildId, days));
    } catch (error) {
      console.error('Impossible d’afficher cette période du classement :', error);
      await interaction.reply({ content: 'Impossible de charger cette période du classement.', flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'set') {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Cette commande fonctionne uniquement dans un serveur.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (interaction.options.getSubcommandGroup() === 'quiz') {
        const channel = interaction.options.getChannel('salon', true);
        await leaderboardManager.configureAutomaticQuiz(interaction.guildId, channel);
        await interaction.editReply({ content: `Le quiz automatique sera publié dans <#${channel.id}>.` });
        return;
      }
      const selectedType = interaction.options.getSubcommand();
      const type = selectedType === 'message' ? 'messages' : selectedType;
      const channel = interaction.options.getChannel('salon', true);
      await leaderboardManager.configure(interaction.guildId, type, channel);
      const labels = { quiz: 'Quiz', messages: 'Messages', vocal: 'Vocal' };
      await interaction.editReply({ content: `Le classement ${labels[type]} est configuré dans <#${channel.id}>.` });
    } catch (error) {
      console.error('Erreur lors de la configuration des classements :', error);
      const response = 'Impossible de configurer les panneaux. Vérifie que le bot peut voir et écrire dans ce salon.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: response });
      else await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (interaction.commandName !== 'quiz') return;
  if (!interaction.guildId || !interaction.channel) {
    await interaction.reply({ content: 'Cette commande fonctionne uniquement dans un serveur.', flags: MessageFlags.Ephemeral });
    return;
  }

  try {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'demarrer') {
      const key = gameKey(interaction.guildId, interaction.channelId);
      if (activeGames.has(key)) {
        await interaction.reply({ content: 'Un quiz est déjà en cours dans ce salon.', flags: MessageFlags.Ephemeral });
        return;
      }

      const theme = interaction.options.getString('theme', true);
      const count = interaction.options.getInteger('questions') ?? 5;
      const source = theme === 'mixte'
        ? [...questionBank.drapeaux.map((question) => ({ ...question, category: 'drapeaux' })), ...questionBank.culture.map((question) => ({ ...question, category: 'culture' }))]
        : questionBank[theme].map((question) => ({ ...question, category: theme }));
      const questions = shuffled(source).slice(0, Math.min(count, source.length));
      const game = {
        key,
        guildId: interaction.guildId,
        channel: interaction.channel,
        questions,
        index: 0,
        current: null,
        stopped: false,
      };
      activeGames.set(key, game);
      await interaction.reply({ content: `Quiz lancé : **${questions.length} questions**. Répondez directement dans ce salon !`, flags: MessageFlags.Ephemeral });
      await sendQuestion(game);
      return;
    }

    if (subcommand === 'arreter') {
      const game = activeGames.get(gameKey(interaction.guildId, interaction.channelId));
      if (!game) {
        await interaction.reply({ content: 'Aucun quiz n’est en cours dans ce salon.', flags: MessageFlags.Ephemeral });
        return;
      }
      await stopGame(game);
      await interaction.reply(panel('Quiz arrêté', 'La partie a été arrêtée par user.', { ephemeral: true }));
      await interaction.channel.send(panel('Partie terminée', 'Le quiz a été arrêté.'));
      return;
    }

    if (subcommand === 'scores') await showLeaderboard(interaction);
  } catch (error) {
    console.error('Erreur pendant une commande /quiz :', error);
    const response = { content: 'Une erreur est survenue. Vérifie les permissions du bot et réessaie.', flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response);
    else await interaction.reply(response);
  }
});

client.on('error', (error) => console.error('Erreur Discord :', error));
process.on('unhandledRejection', (error) => console.error('Promesse rejetée :', error));

try {
  await publishSlashCommands();
} catch (error) {
  console.error('Impossible de synchroniser les commandes slash :', error);
}

await client.login(DISCORD_TOKEN);