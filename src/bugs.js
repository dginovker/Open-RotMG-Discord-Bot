import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ChannelType, MessageFlags, PermissionFlagsBits, Routes, escapeMarkdown } from 'discord.js';

export const PUBLIC_BUG_CHANNEL_ID = '1559759855621898313';
const repository = 'OpenRotMG/Open-RotMG-Server';
const repoPath = `repos/${repository}`;
export const BUG_REPLY = 'Please use "Report bug" at the bottom of https://openrotmg.org/ so we can add this to our backlog!';

export function bugConfig(env, gameOrigin, linkToken) {
  if (env.BUG_REPORTING === undefined) return null;
  if (env.BUG_REPORTING !== '1') throw new Error('BUG_REPORTING must be 1 or unset');
  if (!env.GITHUB_BUG_TOKEN_FILE || !isAbsolute(env.GITHUB_BUG_TOKEN_FILE)) throw new Error('GITHUB_BUG_TOKEN_FILE must be absolute');
  const githubToken = readFileSync(env.GITHUB_BUG_TOKEN_FILE, 'utf8').trim();
  if (!githubToken) throw new Error('GitHub bug credential is empty');
  return {url: `${gameOrigin}/internal/discord/bugs`, publicOrigin: 'https://game.openrotmg.org', token: linkToken, githubToken};
}

export async function validateBugChannels(client, guildId) {
  const channel = await client.channels.fetch(PUBLIC_BUG_CHANNEL_ID);
  if (channel?.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Bug notifications require a text channel in the configured guild');
  const permissions = channel.permissionsFor(client.user);
  for (const flag of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages]) {
    if (!permissions?.has(flag)) throw new Error(`Missing bug-channel permission ${flag}`);
  }
}
export function bugTitle(description) {
  const line = description.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ');
  if (!line) throw new Error('Bug description is required');
  const chars = Array.from(line);
  return chars.length > 100 ? chars.slice(0, 97).join('') + '...' : line;
}
function issueUrl(number) {
  if (!/^[1-9]\d*$/.test(String(number))) throw new Error('Invalid GitHub issue number');
  return `https://github.com/${repository}/issues/${number}`;
}
function text(value) { return escapeMarkdown(value).replaceAll('@', '@\u200b'); }
function reporter(report) {
  if (report.schema === 2) return 'not recorded (legacy report)';
  const name = report.reporter_name;
  if (typeof name !== 'string' || !name.trim() || name.length > 64 || /[\r\n]/.test(name)) throw new Error('Invalid bug reporter name');
  return text(name);
}
function diagnosticUrl(report, gameOrigin) {
  const path = `/api/bug-reports/${report.id}/diagnostics.json`;
  const canonical = gameOrigin + path;
  // Captured reports retain their website-origin URL; only delivery moves to the API origin.
  if (report.diagnostics_url !== canonical && report.diagnostics_url !== `https://openrotmg.org${path}`) throw new Error('Unexpected diagnostic attachment URL');
  return canonical;
}
export function bugIssue(report, gameOrigin) {
  if (![2, 3].includes(report.schema) || !/^[a-f0-9]{24}$/.test(report.id) || !Number.isSafeInteger(report.created_at_unix_ms)) throw new Error('Invalid bug report identity/schema');
  const title = bugTitle(report.message_untrusted);
  const diagnostics = diagnosticUrl(report, gameOrigin);
  // Delivery can lag deployments; use the frozen report: https://github.com/OpenRotMG/Open-RotMG-Server/blob/dfa6f8584ba7a778e364141485149458b9778b5b/src/server/diagnostics.rs#L691
  const revision = report.diagnostics.versions?.server;
  if (revision != null && (typeof revision !== 'string' || revision.length !== 40 || /[^a-f0-9]/i.test(revision))) throw new Error('Invalid reported server commit');
  const screenshot = `${gameOrigin}/api/bug-reports/${report.id}/screenshot.png`;
  if (report.screenshot_url !== undefined && report.screenshot_url !== screenshot && report.screenshot_url !== `https://openrotmg.org/api/bug-reports/${report.id}/screenshot.png`) throw new Error('Unexpected screenshot attachment URL');
  const environment = report.diagnostics.environment;
  const browser = ['Chrome', 'Firefox', 'Edge', 'Safari'].includes(environment.browser) ? environment.browser : 'Unknown browser';
  const os = ['Windows', 'macOS', 'Linux', 'Android', 'iOS'].includes(environment.os) ? environment.os : 'unknown OS';
  const description = report.message_untrusted.split(/\r?\n/).map(line => `> ${text(line)}`).join('\n');
  // Classify at creation without relabeling reconciled issues: https://github.com/OpenRotMG/Open-RotMG-Server/issues/1288
  return {title, labels: ['Player Report'], body: [
    `<!-- openrotmg-bug:${report.id} -->`, description, '',
    `**Reporter:** ${reporter(report)}  `,
    `**Environment:** ${browser} on ${os}  `,
    `**Server commit:** ${revision == null ? 'not recorded in report' : '`' + revision + '`'}  `,
    `**Reported:** ${new Date(report.created_at_unix_ms).toISOString()}`, '',
    `Diagnostics: ${diagnostics}`,
    ...(report.screenshot_url === undefined ? [] : ['', `![Game screenshot](${screenshot})`])
  ].join('\n')};
}
async function existingMessage(rest, botId, report, url) {
  let before;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({limit: '100'});
    if (before) query.set('before', before);
    const messages = await rest.get(Routes.channelMessages(PUBLIC_BUG_CHANNEL_ID), {query});
    const match = messages.find(m => m.author.id === botId && m.content.endsWith(`\n${url}`));
    if (match) return match;
    if (messages.length < 100 || Date.parse(messages.at(-1).timestamp) < report.created_at_unix_ms - 10000) return null;
    before = messages.at(-1).id;
  }
  throw new Error(`Bug ${report.id}: reconciliation exceeded 1000 messages; manual review required`);
}
export function bugPublisher({rest, botId, config, log, request = fetch}) {
  let running = false, githubUserId;
  async function api(path, options = {}) {
    const response = await request(config.url + path, {...options,
      headers: {authorization: `Bearer ${config.token}`, 'content-type': 'application/json'},
      redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error(`Bug API returned HTTP ${response.status}`);
    return response;
  }
  async function github(path, options = {}) {
    const response = await request(`https://api.github.com/${path}`, {...options,
      headers: {authorization: `Bearer ${config.githubToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28'},
      redirect: 'error', signal: AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error(`GitHub bug API returned HTTP ${response.status}`);
    return response.json();
  }
  async function issue(report, payload) {
    for (let page = 1; page <= 10; page++) {
      const issues = await github(`${repoPath}/issues?state=all&since=${encodeURIComponent(new Date(report.created_at_unix_ms).toISOString())}&per_page=100&page=${page}`);
      const match = issues.find(i => !i.pull_request && i.body?.startsWith(`<!-- openrotmg-bug:${report.id} -->`));
      if (match) return match;
      if (issues.length < 100) return github(`${repoPath}/issues`, {method: 'POST', body: JSON.stringify(payload)});
    }
    throw new Error(`Bug ${report.id}: issue reconciliation exceeded 1000 issues; manual review required`);
  }
  async function details(report) {
    const {notes, delivery} = report, batch = delivery.note_batch;
    if (!Array.isArray(notes) || notes.length > 32 || !batch || !Number.isSafeInteger(delivery.notes_through)
        || batch.from !== delivery.notes_through + 1 || !Number.isSafeInteger(batch.through)
        || batch.through < batch.from || batch.through > notes.length) throw new Error('Invalid bug note batch');
    const marker = `<!-- openrotmg-bug-info:${report.id}:${batch.from}:${batch.through} -->`;
    const entries = notes.slice(batch.from - 1, batch.through).map(note => {
      if (!Number.isSafeInteger(note.created_at_unix_ms) || note.created_at_unix_ms <= 0
          || typeof note.text_untrusted !== 'string' || !note.text_untrusted.trim() || Array.from(note.text_untrusted).length > 500) throw new Error('Invalid bug note');
      return `**${new Date(note.created_at_unix_ms).toISOString()}**\n` + note.text_untrusted.split(/\r?\n/).map(line => `> ${text(line)}`).join('\n');
    });
    if (githubUserId === undefined) {
      const user = await github('user');
      if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Invalid GitHub publisher identity');
      githubUserId = user.id;
    }
    const path = `${repoPath}/issues/${report.delivery.issue_number}/comments`;
    for (let page = 1; page <= 10; page++) {
      const comments = await github(`${path}?per_page=100&page=${page}`);
      const match = comments.find(c => c.user?.id === githubUserId && c.body?.startsWith(marker + '\n'));
      if (match) return match;
      if (comments.length < 100) return github(path, {method: 'POST', body: JSON.stringify({body: `${marker}\n**Additional details from ${reporter(report)}**\n\n${entries.join('\n\n')}`})});
    }
    throw new Error(`Bug ${report.id}: comment reconciliation exceeded 1000 comments; manual review required`);
  }
  return async () => {
    if (running) return;
    running = true;
    let reportId = null;
    let stage = 'read_queue';
    try {
      const {report} = await (await api('')).json();
      if (report === null) return;
      reportId = report.id;
      const payload = bugIssue(report, config.publicOrigin);
      async function acknowledge(target, id, through) {
        await api(`/${report.id}`, {method: 'POST', body: JSON.stringify({target, id: String(id), ...(through === undefined ? {} : {through})})});
        if (target === 'notes') report.delivery.notes_through = through;
        else report.delivery[target] = String(id);
        log('bug_delivery_stage', {reportId, target, id: String(id), ...(through === undefined ? {} : {through})});
      }
      if (!report.delivery.issue_number) {
        stage = 'github_issue';
        const attachment = await request(diagnosticUrl(report, config.publicOrigin), {redirect: 'error', signal: AbortSignal.timeout(10000)});
        if (!attachment.ok) throw new Error(`Diagnostic attachment returned HTTP ${attachment.status}`);
        await acknowledge('issue_number', (await issue(report, payload)).number);
      }
      if (!report.delivery.public_message_id) {
        stage = 'discord_notification';
        const url = issueUrl(report.delivery.issue_number);
        const message = await existingMessage(rest, botId, report, url) ?? await rest.post(Routes.channelMessages(PUBLIC_BUG_CHANNEL_ID), {
          body: {content: `Reporter: ${reporter(report)}\n${text(report.message_untrusted)}\n${url}`, flags: MessageFlags.SuppressEmbeds, allowed_mentions: {parse: []}, nonce: `u${report.id}`, enforce_nonce: true}
        });
        await acknowledge('public_message_id', message.id);
      }
      if (report.notes !== undefined) {
        if (!Array.isArray(report.notes) || !Number.isSafeInteger(report.delivery.notes_through)
            || report.delivery.notes_through < 0 || report.delivery.notes_through > report.notes.length) throw new Error('Invalid bug note progress');
        if (report.delivery.notes_through < report.notes.length) {
          stage = 'github_details';
          await acknowledge('notes', (await details(report)).id, report.delivery.note_batch.through);
        }
      }
      log('bug_delivered', {reportId, issueNumber: report.delivery.issue_number});
    } catch (error) {
      log('bug_delivery_failed', {reportId, stage, error: {name: error.name, message: String(error.message).replaceAll(config.token, '[REDACTED]').replaceAll(config.githubToken, '[REDACTED]')}});
    } finally { running = false; }
  };
}
