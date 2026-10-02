import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

const TIME_ZONE = 'Europe/Paris';
const BOARD_TYPES = ['quiz', 'messages', 'vocal'];
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function parisParts(date = new Date()) {
  return Object.fromEntries(dateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
}

function parisDayKey(date = new Date()) {
  const { year, month, day } = parisParts(date);
  return `${year}-${month}-${day}`;
}

function dayKeysForRange(days, date = new Date()) {
  const { year, month, day } = parisParts(date);
  const today = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return Array.from({ length: days }, (_, offset) =>
    new Date(today - (days - offset - 1) * 86_400_000).toISOString().slice(0, 10));
}

function currentWeekDayKeys(date = new Date()) {
  const { year, month, day } = parisParts(date);
  const today = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const weekday = new Date(today).getUTCDay();
  const monday = today - ((weekday + 6) % 7) * 86_400_000;
  const count = Math.floor((today - monday) / 86_400_000) + 1;
  return Array.from({ length: count }, (_, offset) =>
    new Date(monday + offset * 86_400_000).toISOString().slice(0, 10));
}

function parisMidnight(year, month, day) {
  const utcGuess = Date.UTC(year, month - 1, day);
  const local = parisParts(new Date(utcGuess));
  const localAsUtc = Date.UTC(
    Number(local.year),
    Number(local.month) - 1,
    Number(local.day),
    Number(local.hour),
    Number(local.minute),
    Number(local.second),
  );
  return new Date(utcGuess - (localAsUtc - utcGuess));
}

function nextReset(date = new Date()) {
  const { year, month, day } = parisParts(date);
  return parisMidnight(Number(year), Number(month), Number(day) + 1);
}

function panel(title, body, footer, menu) {
  const components = [
    { type: 10, content: `## ${title}` },
    { type: 14, divider: true, spacing: 1 },
    { type: 10, content: body },
    { type: 14, divider: true, spacing: 1 },
    { type: 10, content: footer },
  ];
  if (menu) components.push({ type: 1, components: [menu] });
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [{
      type: 17,
      accent_color: 0x808080,
      components,
    }],
  };
}

function durationLabel(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days} j ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${Math.max(1, minutes)} min`;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export class LeaderboardManager {
  constructor(root, client, getQuizRanking) {
    this.client = client;
    this.getQuizRanking = getQuizRanking;
    this.activityPath = path.join(root, 'data', 'activity.json');
    this.boardsPath = path.join(root, 'data', 'leaderboards.json');
    this.activity = {};
    this.boards = {};
    this.voiceSessions = new Map();
    this.activitySaveQueue = Promise.resolve();
    this.boardSaveQueue = Promise.resolve();
    this.refreshTimers = new Map();
    this.refreshing = new Map();
    this.dailyTimer = undefined;
    this.voiceTimer = undefined;
  }

  async load() {
    [this.activity, this.boards] = await Promise.all([
      readJson(this.activityPath),
      readJson(this.boardsPath),
    ]);

    for (const [guildId, config] of Object.entries(this.boards)) {
      if (!config.channelId) continue;
      this.boards[guildId] = {
        automaticQuizChannelId: config.automaticQuizChannelId,
        podiumRoleId: config.podiumRoleId,
        podiumMemberIds: config.podiumMemberIds ?? [],
        ...Object.fromEntries(BOARD_TYPES.map((type) => [type, {
          channelId: config.channelId,
          messageId: config.messages?.[type] ?? null,
        }])),
      };
    }
  }

  userStats(guildId, userId, username, date = new Date()) {
    const key = `${guildId}:${userId}`;
    const today = parisDayKey(date);
    let stats = this.activity[key];

    if (!stats) {
      stats = {
        guildId,
        userId,
        username,
        messages: 0,
        dailyMessages: 0,
        voiceMs: 0,
        dailyVoiceMs: 0,
        dailyDate: today,
        history: {},
      };
      this.activity[key] = stats;
    }

    stats.username = username || stats.username;
    stats.history ??= {};
    if (stats.dailyDate !== today) {
      stats.dailyDate = today;
      stats.dailyMessages = 0;
      stats.dailyVoiceMs = 0;
    }
    return stats;
  }

  saveActivity() {
    const snapshot = JSON.stringify(this.activity, null, 2);
    this.activitySaveQueue = this.activitySaveQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.activityPath), { recursive: true });
      const temporaryPath = `${this.activityPath}.tmp`;
      await writeFile(temporaryPath, snapshot, 'utf8');
      await rename(temporaryPath, this.activityPath);
    });
    return this.activitySaveQueue;
  }

  saveBoards() {
    const snapshot = JSON.stringify(this.boards, null, 2);
    this.boardSaveQueue = this.boardSaveQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.boardsPath), { recursive: true });
      const temporaryPath = `${this.boardsPath}.tmp`;
      await writeFile(temporaryPath, snapshot, 'utf8');
      await rename(temporaryPath, this.boardsPath);
    });
    return this.boardSaveQueue;
  }

  async recordMessage(message) {
    if (!message.guildId || message.author.bot) return;
    const stats = this.userStats(message.guildId, message.author.id, message.author.username);
    const today = parisDayKey();
    const daily = dailyStats(stats, today);
    if (daily.messages === 0 && stats.dailyDate === today) daily.messages = stats.dailyMessages;
    stats.messages += 1;
    stats.dailyMessages += 1;
    daily.messages += 1;
    pruneHistory(stats);
    await this.saveActivity();
    this.scheduleRefresh(message.guildId);
  }

  async initializeVoiceSessions() {
    const startedAt = Date.now();
    let hasVoiceMembers = false;
    for (const guild of this.client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        const member = state.member ?? guild.members.cache.get(state.id);
        if (!state.channelId || state.id === this.client.user.id || member?.user.bot) continue;
        const username = member?.user.username ?? member?.displayName ?? state.id;
        const stats = this.userStats(guild.id, state.id, username, new Date(startedAt));
        const today = parisDayKey(new Date(startedAt));
        if (stats.dailyDate === today) {
          const daily = dailyStats(stats, today);
          if (!daily.voiceMs) daily.voiceMs = stats.dailyVoiceMs;
        }
        pruneHistory(stats, new Date(startedAt));
        this.voiceSessions.set(`${guild.id}:${state.id}`, {
          guildId: guild.id,
          userId: state.id,
          username,
          startedAt,
        });
        hasVoiceMembers = true;
      }
    }
    if (hasVoiceMembers) await this.saveActivity();
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const member = newState.member ?? oldState.member;
    if (member?.user.bot || oldState.channelId === newState.channelId) return;

    const guildId = newState.guild.id;
    const userId = newState.id;
    const key = `${guildId}:${userId}`;
    const now = Date.now();
    const session = this.voiceSessions.get(key);

    if (session) {
      this.voiceSessions.delete(key);
      const stats = this.userStats(guildId, userId, session.username, new Date(now));
      const elapsed = Math.max(0, now - session.startedAt);
      const today = parisDayKey(new Date(now));
      const todayStart = parisMidnight(...today.split('-').map(Number)).getTime();
      dailyStats(stats, today);
      stats.voiceMs += elapsed;
      stats.dailyVoiceMs += Math.max(0, now - Math.max(session.startedAt, todayStart));
      let cursor = session.startedAt;
      while (cursor < now) {
        const day = parisDayKey(new Date(cursor));
        const [year, month, date] = day.split('-').map(Number);
        const dayEnd = parisMidnight(year, month, date + 1).getTime();
        const segmentEnd = Math.min(now, dayEnd);
        const daily = dailyStats(stats, day);
        daily.voiceMs += segmentEnd - cursor;
        cursor = segmentEnd;
      }
      pruneHistory(stats, new Date(now));
    }

    if (newState.channelId && member?.user) {
      const stats = this.userStats(guildId, userId, member.user.username);
      this.voiceSessions.set(key, { guildId, userId, username: stats.username, startedAt: now });
    }

    await this.saveActivity();
    this.scheduleRefresh(guildId);
  }

  async configure(guildId, type, channel) {
    if (!BOARD_TYPES.includes(type)) throw new Error(`Type de classement invalide : ${type}`);
    const current = this.boards[guildId] ?? {};
    const previous = current[type];
    current[type] = {
      channelId: channel.id,
      messageId: previous?.channelId === channel.id ? previous.messageId : null,
    };
    this.boards[guildId] = current;
    await this.saveBoards();
    await this.refreshBoard(guildId, type, channel);
  }

  async configureAutomaticQuiz(guildId, channel) {
    const config = this.boards[guildId] ?? {};
    config.automaticQuizChannelId = channel.id;
    this.boards[guildId] = config;
    await this.saveBoards();
  }

  async configurePodiumRole(guildId, role) {
    const guild = role.guild;
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    const botHighestRole = botMember.roles.highest;
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('Le bot doit avoir la permission Gérer les rôles.');
    }
    if (role.id === guild.id || role.managed || role.position >= botHighestRole.position || role.permissions.bitfield !== 0n) {
      throw new Error('Choisis un rôle cosmétique sans permissions, non géré et placé sous le rôle le plus élevé du bot.');
    }

    await role.setHoist(true);
    await role.setPosition(Math.max(1, botHighestRole.position - 1));
    const config = this.boards[guildId] ?? {};
    if (config.podiumRoleId && config.podiumRoleId !== role.id) {
      const previousRole = await guild.roles.fetch(config.podiumRoleId).catch(() => null);
      for (const userId of config.podiumMemberIds ?? []) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (previousRole && member?.roles.cache.has(previousRole.id)) await member.roles.remove(previousRole);
      }
    }
    config.podiumRoleId = role.id;
    config.podiumMemberIds ??= [];
    this.boards[guildId] = config;
    await this.saveBoards();
    await this.refreshPodiumRole(guildId);
  }

  async refreshPodiumRole(guildId) {
    const config = this.boards[guildId];
    if (!config?.podiumRoleId) return;
    const guild = this.client.guilds.cache.get(guildId) ?? await this.client.guilds.fetch(guildId);
    const role = await guild.roles.fetch(config.podiumRoleId).catch(() => null);
    if (!role) return;

    const [quiz, messages, voice] = await Promise.all([
      this.getQuizRanking(guildId, { currentWeek: true, limit: 3 }),
      this.messageRanking(guildId, 7, Date.now(), true),
      this.voiceRanking(guildId, 7, Date.now(), true),
    ]);
    const desiredIds = new Set([
      ...quiz.map((score) => score.userId),
      ...messages.slice(0, 3).map((stats) => stats.userId),
      ...voice.slice(0, 3).map((stats) => stats.userId),
    ]);
    const previousIds = new Set(config.podiumMemberIds ?? []);

    for (const userId of previousIds) {
      if (desiredIds.has(userId)) continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member?.roles.cache.has(role.id)) await member.roles.remove(role);
    }

    const assignedIds = [];
    for (const userId of desiredIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      if (!member.roles.cache.has(role.id)) await member.roles.add(role);
      assignedIds.push(userId);
    }

    if (assignedIds.length !== previousIds.size || assignedIds.some((userId) => !previousIds.has(userId))) {
      config.podiumMemberIds = assignedIds;
      await this.saveBoards();
    }
  }

  async leaderboardPayload(guildId, days = 7) {
    const [quiz, messages, voice] = await Promise.all([
      this.getQuizRanking(guildId, { days, limit: 10 }),
      this.messageRanking(guildId, days),
      this.voiceRanking(guildId, days),
    ]);
    const formatRows = (rows, valueFor, suffix = '') => rows.length
      ? rows.map((row, index) => `\`${String(index + 1).padStart(2, '0')}.\` <@${row.userId}> · **${valueFor(row)}${suffix}**`).join('\n')
      : 'Aucun résultat sur cette période.';
    const roleMention = this.boards[guildId]?.podiumRoleId
      ? `Rôle du podium : <@&${this.boards[guildId].podiumRoleId}>\n\n`
      : '';
    const body = [
      roleMention.trimEnd(),
      '### Quiz',
      formatRows(quiz, (score) => `${score.rankingPoints.toLocaleString('fr-FR')} pts`),
      '### Messages',
      formatRows(messages, (stats) => stats.leaderboardMessages.toLocaleString('fr-FR'), ' messages'),
      '### Vocal',
      formatRows(voice, (stats) => durationLabel(stats.leaderboardVoiceMs)),
    ].filter(Boolean).join('\n');
    const selectedDays = String(days);
    const menu = {
      type: 3,
      custom_id: `leaderboard-period:${guildId}`,
      placeholder: `Période : ${days} jours`,
      min_values: 1,
      max_values: 1,
      options: [7, 14, 28].map((period) => ({
        label: `${period} jours`,
        value: String(period),
        default: String(period) === selectedDays,
      })),
    };
    const updated = Math.floor(Date.now() / 1000);
    const reset = Math.floor(nextWeeklyReset().getTime() / 1000);
    return panel(
      `Classements · ${days} jours`,
      body,
      `Mise à jour : <t:${updated}:f> · Rôles Top 3 remis à jour <t:${reset}:R>`,
      menu,
    );
  }

  messageRanking(guildId, days = 7, now = Date.now(), currentWeek = false) {
    const dates = currentWeek ? currentWeekDayKeys(new Date(now)) : dayKeysForRange(days, new Date(now));
    return Object.values(this.activity)
      .filter((stats) => stats.guildId === guildId)
      .map((stats) => ({
        ...stats,
        leaderboardMessages: dates.reduce((total, date) => total + (
          stats.history?.[date]?.messages ?? (stats.dailyDate === date ? stats.dailyMessages : 0)
        ), 0),
      }))
      .filter((stats) => stats.leaderboardMessages > 0)
      .sort((left, right) => right.leaderboardMessages - left.leaderboardMessages)
      .slice(0, 10);
  }

  voiceRanking(guildId, days = 7, now = Date.now(), currentWeek = false) {
    const dates = currentWeek ? currentWeekDayKeys(new Date(now)) : dayKeysForRange(days, new Date(now));
    const activeTimes = new Map();
    for (const [key, session] of this.voiceSessions) {
      if (session.guildId !== guildId) continue;
      activeTimes.set(key, dates.reduce((total, date) => total + voiceTimeOnDay(session, date, now), 0));
    }

    return Object.entries(this.activity)
      .filter(([, stats]) => stats.guildId === guildId)
      .map(([key, stats]) => ({
        ...stats,
        leaderboardVoiceMs: dates.reduce((total, date) => total + (
          stats.history?.[date]?.voiceMs ?? (stats.dailyDate === date ? stats.dailyVoiceMs : 0)
        ), 0) + (activeTimes.get(key) ?? 0),
      }))
      .filter((stats) => stats.leaderboardVoiceMs > 0)
      .sort((left, right) => right.leaderboardVoiceMs - left.leaderboardVoiceMs)
      .slice(0, 10);
  }

  async boardPayload(guildId, type) {
    let title;
    let description;
    let rows;

    if (type === 'quiz') {
      title = '🏆 Classement Quiz';
      description = 'Classement des points gagnés cette semaine.';
      rows = await this.getQuizRanking(guildId, { currentWeek: true, limit: 10 });
      rows = rows.map((score) => ({
        userId: score.userId,
        value: score.weeklyPoints,
        detail: `pts · (${score.weeklyCorrect} bonnes rép.)`,
      }));
    } else if (type === 'messages') {
      title = '🏆 Top 10 Messages';
      description = 'Classement des messages envoyés cette semaine.';
      rows = this.messageRanking(guildId, 7, Date.now(), true).map((stats) => ({
        userId: stats.userId,
        value: stats.leaderboardMessages,
        detail: 'messages',
      }));
    } else {
      title = '🏆 Top 10 Vocal';
      description = 'Classement du temps passé en vocal cette semaine.';
      rows = this.voiceRanking(guildId, 7, Date.now(), true).map((stats) => ({
        userId: stats.userId,
        value: durationLabel(stats.leaderboardVoiceMs),
      }));
    }

    const body = rows.length
      ? rows.map((row, index) => {
        const rank = String(index + 1).padStart(2, '0');
        const value = typeof row.value === 'number' ? row.value.toLocaleString('fr-FR') : row.value;
        return `\`${rank}.\` <@${row.userId}> · **${value}${row.detail ? ` ${row.detail}` : ''}**`;
      }).join('\n')
      : 'Aucune activité enregistrée cette semaine.';
    const updated = Math.floor(Date.now() / 1000);
    const reset = Math.floor(nextWeeklyReset().getTime() / 1000);
    return panel(
      title,
      `${description}\n\n${body}`,
      `Dernière mise à jour : <t:${updated}:f>\nProchaine réinitialisation <t:${reset}:R>`,
    );
  }

  async refreshBoard(guildId, type, channelOverride) {
    const refreshKey = `${guildId}:${type}`;
    if (this.refreshing.has(refreshKey)) return this.refreshing.get(refreshKey);
    const task = (async () => {
      const config = this.boards[guildId]?.[type];
      if (!config) return;
      const channel = channelOverride ?? await this.client.channels.fetch(config.channelId);
      if (!channel?.isTextBased() || !channel.messages) return;
      const payload = await this.boardPayload(guildId, type);
      let boardMessage;
      if (config.messageId) boardMessage = await channel.messages.fetch(config.messageId).catch(() => null);

      if (boardMessage) {
        await boardMessage.edit({ components: payload.components, allowedMentions: payload.allowedMentions });
      } else {
        boardMessage = await channel.send(payload);
        config.messageId = boardMessage.id;
        await this.saveBoards();
      }
    })();
    this.refreshing.set(refreshKey, task);
    try {
      await task;
    } finally {
      this.refreshing.delete(refreshKey);
    }
  }

  async refreshGuild(guildId) {
    for (const type of BOARD_TYPES) {
      if (this.boards[guildId]?.[type]) await this.refreshBoard(guildId, type);
    }
    await this.refreshPodiumRole(guildId);
  }

  scheduleRefresh(guildId) {
    if (!this.boards[guildId] || this.refreshTimers.has(guildId)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(guildId);
      void this.refreshGuild(guildId).catch((error) => console.error('Mise à jour des classements impossible :', error));
    }, 30_000);
    timer.unref?.();
    this.refreshTimers.set(guildId, timer);
  }

  async refreshAll() {
    for (const guildId of Object.keys(this.boards)) {
      await this.refreshGuild(guildId).catch((error) => console.error(`Classements indisponibles pour ${guildId} :`, error));
    }
  }

  scheduleDailyRefresh() {
    clearTimeout(this.dailyTimer);
    const delay = Math.max(1_000, nextReset().getTime() - Date.now() + 1_000);
    this.dailyTimer = setTimeout(async () => {
      await this.refreshAll();
      this.scheduleDailyRefresh();
    }, delay);
    this.dailyTimer.unref?.();
  }

  startVoiceRefresh() {
    this.voiceTimer = setInterval(() => {
      if (this.voiceSessions.size) void this.refreshAll().catch(console.error);
    }, 60_000);
    this.voiceTimer.unref?.();
  }
}

function nextWeeklyReset(date = new Date()) {
  const { year, month, day } = parisParts(date);
  const today = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const weekday = new Date(today).getUTCDay();
  const daysUntilMonday = (8 - weekday) % 7 || 7;
  return parisMidnight(Number(year), Number(month), Number(day) + daysUntilMonday);
}

function dailyStats(stats, date) {
  stats.history ??= {};
  stats.history[date] ??= {
    messages: stats.dailyDate === date ? stats.dailyMessages ?? 0 : 0,
    voiceMs: stats.dailyDate === date ? stats.dailyVoiceMs ?? 0 : 0,
  };
  return stats.history[date];
}

function pruneHistory(stats, date = new Date()) {
  const retainedDays = new Set(dayKeysForRange(28, date));
  for (const day of Object.keys(stats.history ?? {})) {
    if (!retainedDays.has(day)) delete stats.history[day];
  }
}

function voiceTimeOnDay(session, day, now) {
  const [year, month, date] = day.split('-').map(Number);
  const dayStart = parisMidnight(year, month, date).getTime();
  const dayEnd = parisMidnight(year, month, date + 1).getTime();
  return Math.max(0, Math.min(now, dayEnd) - Math.max(session.startedAt, dayStart));
}