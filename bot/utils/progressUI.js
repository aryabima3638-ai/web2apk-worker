
/**
 * Progress UI Manager
 * Handles real-time build progress updates with stage tracking.
 */
const PROGRESS_STAGES = {
  Preparing: { percent: 10, emoji: '<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji>' },
  Generating: { percent: 20, emoji: '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️' },
  Configuring: { percent: 30, emoji: '<tg-emoji emoji-id="5413398757226076065">🔧</tg-emoji>' },
  Resolving: { percent: 40, emoji: '<tg-emoji emoji-id="5346132860631791153">📚</tg-emoji>' },
  Building: { percent: 55, emoji: '<tg-emoji emoji-id="5361734213370396027">🔨</tg-emoji>' },
  Gradle: { percent: 65, emoji: '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️' },
  Signing: { percent: 90, emoji: '<tg-emoji emoji-id="5258500400918587241">✍</tg-emoji>️' },
  Finalizing: { percent: 95, emoji: '<tg-emoji emoji-id="5325547803936572038">✨</tg-emoji>' },
  Complete: { percent: 100, emoji: '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji>' },
  Success: { percent: 100, emoji: '<tg-emoji emoji-id="5235711785482341993">🎉</tg-emoji>' }
};

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeStatus(status, maxLength = 380) {
  const normalized = String(status || '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (!normalized) return 'Memproses build...';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function detectStage(status) {
  const value = String(status || '').toLowerCase();
  const entry = Object.entries(PROGRESS_STAGES).find(([name]) =>
    value.includes(name.toLowerCase())
  );
  return entry ? entry[1] : PROGRESS_STAGES.Building;
}

function formatProgressBar(percent, width = 20) {
  const bounded = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((bounded / 100) * width);
  const empty = Math.max(0, width - filled);
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatBuildProgress(percent, status, appName, workerAlias = null) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const stage = detectStage(status);
  const safeStatus = escapeHtml(normalizeStatus(status));
  const safeAppName = escapeHtml(appName || 'My App');
  const safeWorker = workerAlias ? escapeHtml(workerAlias) : '';

  return `
<tg-emoji emoji-id="5188481279963715781">🚀</tg-emoji> <b>Build APK Berjalan</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="5363892211098339885">📱</tg-emoji> <b>${safeAppName}</b>
${safeWorker ? `<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>Worker:</b> ${safeWorker}\n` : ''}<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> <b>Progress:</b> ${stage.emoji} ${safePercent}%
<code>${formatProgressBar(safePercent)}</code>

<i>${safeStatus}</i>
  `.trim();
}

function formatSuccessMessage(appName, url) {
  const safeAppName = escapeHtml(appName || 'My App');
  const safeUrl = url ? escapeHtml(url) : null;

  const lines = [
    '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Build Berhasil!</b>',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `<tg-emoji emoji-id="5363892211098339885">📱</tg-emoji> ${safeAppName}`,
    safeUrl ? `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <code>${safeUrl}</code>` : `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <i>ZIP Project</i>`,
    '',
    '<i>APK siap diunduh di pesan berikutnya.</i>'
  ];

  return lines.filter(l => l !== null).join('\n').trim();
}

function formatBuildStartMessage(appName, url) {
  const safeAppName = escapeHtml(appName || 'My App');
  const safeUrl = url ? escapeHtml(url) : null;

  const lines = [
    '<tg-emoji emoji-id="5188481279963715781">🚀</tg-emoji> <b>Memulai Build APK</b>',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `<tg-emoji emoji-id="5363892211098339885">📱</tg-emoji> <b>${safeAppName}</b>`,
    safeUrl ? `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <code>${safeUrl}</code>` : `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <i>ZIP Project</i>`,
    '',
    '<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Menyiapkan worker dan environment build...'
  ];

  return lines.filter(l => l !== null).join('\n').trim();
}

async function updateBuildProgress(bot, chatId, messageId, percent, status, appName, workerAlias, jobId) {
  try {
    const text = formatBuildProgress(percent, status, appName, workerAlias);
    console.log(`[ProgressUI] Updating message ${messageId} in chat ${chatId}: ${percent}% - ${status}`);
    const options = {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    };
    // Show the cancel button while the build is genuinely still in-flight
    // (not yet at 100%). Once it hits 100% (or later becomes a
    // success/failure message via sendBuildComplete / sendErrorLog),
    // there's nothing left to cancel, so the button is intentionally
    // dropped by simply not passing reply_markup on those calls.
    if (jobId && percent < 100) {
      options.reply_markup = {
        inline_keyboard: [[{
          text: 'Batal Build',
          callback_data: `cancel_running_build_${jobId}`,
          icon_custom_emoji_id: '6206110936789423908',
        }]]
      };
    }
    await bot.editMessageText(text, options);
    console.log(`[ProgressUI] Successfully updated message ${messageId}`);
    return true;
  } catch (error) {
    console.error(`[ProgressUI] Error updating message ${messageId}:`, error.message);
    if (error.message && error.message.includes('message is not modified')) {
      return true;
    }
    throw error;
  }
}

async function sendBuildStart(bot, chatId, appName, url) {
  const text = formatBuildStartMessage(appName, url);
  // No cancel button here intentionally: jobId doesn't exist yet at this
  // point in every call site (it's generated right after this call
  // returns). The button appears a moment later once updateBuildProgress
  // starts editing this same message with a real jobId attached.
  const message = await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  console.log(`[ProgressUI] sendBuildStart returned message_id: ${message.message_id}`);
  return message;
}

async function sendBuildComplete(bot, chatId, messageId, appName, url) {
  const text = formatSuccessMessage(appName, url);

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });
    return true;
  } catch (error) {
    console.error('[ProgressUI] Failed to edit completion message:', error.message);
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
      return true;
    } catch (sendError) {
      console.error('[ProgressUI] Failed to send fallback completion message:', sendError.message);
      return false;
    }
  }
}

module.exports = {
  formatProgressBar,
  formatBuildProgress,
  formatSuccessMessage,
  formatBuildStartMessage,
  updateBuildProgress,
  sendBuildStart,
  sendBuildComplete,
  PROGRESS_STAGES,
  escapeHtml,
  normalizeStatus,
  detectStage
};
