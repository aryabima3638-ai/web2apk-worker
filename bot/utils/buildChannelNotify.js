/**
 * buildChannelNotify.js
 * ─────────────────────────────────────────────────────────────────────────
 * Kirim notifikasi otomatis ke channel Telegram setiap kali sebuah build
 * (URL to APK / ZIP to APK, lewat worker VPS maupun GitHub
 * Actions) selesai — baik SUKSES maupun GAGAL.
 *
 * Channel diatur lewat config.build.notifyChannelId. Kalau kosong, fungsi
 * ini tidak melakukan apa-apa (fitur otomatis nonaktif).
 */

const config = require('../../config');
const notifySettings = require('./buildNotifySettings');

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {object} bot - instance node-telegram-bot-api (biasanya global.bot)
 * @param {object} data
 * @param {'success'|'failed'} data.status
 * @param {string} data.appName
 * @param {string} [data.url]
 * @param {string} data.jobId
 * @param {string|number} [data.userId]
 * @param {string} [data.userUsername]
 * @param {string} [data.workerAlias]
 * @param {number} [data.durationSeconds]
 * @param {string} [data.error]
 */
async function notifyBuildChannel(bot, data = {}) {
  const channelId = notifySettings.getChannelId();
  if (!channelId) return; // fitur tidak diaktifkan

  if (!bot || typeof bot.sendMessage !== 'function') return;

  const {
    status,
    appName,
    url,
    jobId,
    userId,
    userUsername,
    workerAlias,
    durationSeconds,
    error,
  } = data;

  const isSuccess = status === 'success';
  const title = isSuccess
    ? '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Build Sukses</b>'
    : '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>Build Gagal</b>';

  const userLabel = userUsername ? `@${escapeHtml(userUsername)}` : (userId ? `<code>${escapeHtml(userId)}</code>` : '-');
  const durationLabel = Number.isFinite(Number(durationSeconds)) ? `${Math.round(Number(durationSeconds))}s` : '-';

  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━',
    '',
    `<tg-emoji emoji-id="5363892211098339885">📱</tg-emoji> <b>App:</b> ${escapeHtml(appName || 'My App')}`,
    url ? `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <b>URL:</b> <code>${escapeHtml(url)}</code>` : null,
    `🆔 <b>Job:</b> <code>${escapeHtml(jobId)}</code>`,
    `👤 <b>User:</b> ${userLabel}`,
    workerAlias ? `🖥️ <b>Worker:</b> ${escapeHtml(workerAlias)}` : null,
    `⏱️ <b>Durasi:</b> ${durationLabel}`,
  ];

  if (!isSuccess && error) {
    lines.push('');
    lines.push(`<b>Error:</b>\n<code>${escapeHtml(String(error).substring(0, 500))}</code>`);
  }

  const text = lines.filter(Boolean).join('\n');

  try {
    await bot.sendMessage(channelId, text, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[buildChannelNotify] Gagal mengirim notifikasi ke channel:', err.message);
  }
}

module.exports = { notifyBuildChannel };
