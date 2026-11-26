const db = require('../db');
const config = require('../../config');
const ownerService = require('../utils/ownerService');
const joinChecker = require('../joinCheck/checker');
const buildMenu = require('../menus/buildMenu');
const { getMainMenu } = require('../menus/mainMenu');
const accessKeyService = require('../utils/accessKeyService');

const session = require('../session/state');
const pool = require('../../worker/pool');
const installer = require('../../worker/installer');
const maintenance = require('../utils/maintenance');
const jobRegistry = require('../../worker/jobRegistry');
const axios = require('axios');

function formatUserLink(userId) {
  return `<a href="tg://user?id=${userId}">${userId}</a>`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r} dtk`;
  return `${m} mnt ${r} dtk`;
}

function isAdminUser(userId) {
  return ownerService.isAdmin(userId);
}

function buildCommandsMessage(isAdmin, isReseller) {
  let text = `<tg-emoji emoji-id="5397782960512444700">📌</tg-emoji> <b>Perintah</b>\n━━━━━━━━━━━━━━━━━\n\n`;

  text += `<tg-emoji emoji-id="5429368540849260641">🧩</tg-emoji> <b>Umum</b>\n`;
  text += `• /start — Mulai bot & tampilkan menu\n\n`;
  text += `• /done <code>nama item, harga, [payment]</code> — Konfirmasi transaksi\n\n`;

  text += `<tg-emoji emoji-id="5462921117423384478">🛠</tg-emoji>️ <b>Build</b>\n`;
  text += `• Gunakan tombol <b>Build APK</b> di menu utama\n`;
  text += `\n`;

  if (isReseller) {
    text += `<tg-emoji emoji-id="5445221832074483553">💼</tg-emoji> <b>Reseller</b>\n`;
    text += `• /addakses <code>&lt;userId&gt;</code> <code>&lt;hari|permanent&gt;</code>\n`;
    text += `• /extendakses <code>&lt;userId&gt;</code> <code>&lt;hari|permanent&gt;</code>\n`;
    text += `<i>Catatan: reseller akan diminta foto bukti transaksi untuk approval owner.</i>\n\n`;
  }

  if (isReseller && !isAdmin) {
    text += `<tg-emoji emoji-id="5217822164362739968">👑</tg-emoji> <b>Owner (Khusus)</b>\n`;
    text += `• /workers — Menu manajemen worker (VPS + GitHub)\n\n`;
    text += `<tg-emoji emoji-id="5445221832074483553">💼</tg-emoji> <b>Reseller Management (Khusus)</b>\n`;
    text += `• /addreseller <code>&lt;userId&gt;</code> <code>[label]</code>\n`;
    text += `• /delreseller <code>&lt;userId&gt;</code>\n`;
    text += `• /listreseller\n\n`;
    text += `<tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>Akses (Khusus)</b>\n`;
    text += `• /delakses <code>&lt;userId&gt;</code> — Hapus akses\n`;
    text += `• /listakses — Daftar akses\n\n`;
  }

  if (isAdmin) {
    text += `<tg-emoji emoji-id="5217822164362739968">👑</tg-emoji> <b>Admin</b>\n`;
    text += `• /workers — Menu manajemen worker (VPS + GitHub)\n\n`;
    text += `• /maintenance <code>on|off</code> — Toggle mode maintenance\n\n`;

    text += `<tg-emoji emoji-id="5445221832074483553">💼</tg-emoji> <b>Reseller Management</b>\n`;
    text += `• /addreseller <code>&lt;userId&gt;</code> <code>[label]</code>\n`;
    text += `• /delreseller <code>&lt;userId&gt;</code>\n`;
    text += `• /listreseller\n\n`;

    text += `<tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>Akses</b>\n`;
    text += `• /addakses <code>&lt;userId&gt;</code> <code>&lt;hari|permanent&gt;</code> — Tambah akses\n`;
    text += `• /extendakses <code>&lt;userId&gt;</code> <code>&lt;hari|permanent&gt;</code> — Perpanjang akses\n`;
    text += `• /delakses <code>&lt;userId&gt;</code> — Hapus akses\n`;
    text += `• /listakses — Daftar akses\n\n`;

    text += `<tg-emoji emoji-id="5370599459661045441">📢</tg-emoji> <b>Broadcast</b>\n`;
    text += `• /broadcast <code>&lt;pesan&gt;</code> — Broadcast teks ke semua user\n`;
    text += `• Reply pesan + <code>/broadcast</code> — Forward pesan ke semua user\n`;
  }

  text += `\n<i>Tip: tap perintah untuk menyalin.</i>`;
  return text;
}

function isStyleUnsupportedError(error) {
  const message = String(
    error?.response?.body?.description ||
    error?.response?.body ||
    error?.message ||
    ''
  ).toLowerCase();

  return (
    message.includes("can't parse inline keyboard button") ||
    message.includes('inline keyboard button') ||
    message.includes('field "style"') ||
    message.includes('style')
  );
}

function sanitizeOptions(options = {}) {
  if (!options?.reply_markup?.inline_keyboard) return options;

  return {
    ...options,
    reply_markup: {
      ...options.reply_markup,
      inline_keyboard: options.reply_markup.inline_keyboard.map(row =>
        row.map(button => {
          if (!button || typeof button !== 'object') return button;
          const { style, ...rest } = button;
          return rest;
        })
      )
    }
  };
}

async function sendMessageWithFallback(bot, chatId, text, options) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    if (!isStyleUnsupportedError(error)) throw error;
    console.warn('[menu] Button style unsupported by current API endpoint. Fallback to non-style keyboard.');
    return bot.sendMessage(chatId, text, sanitizeOptions(options));
  }
}

async function editOrSend(bot, query, text, options) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const base = {
    chat_id: chatId,
    message_id: messageId,
    ...options
  };
  const safeBase = {
    chat_id: chatId,
    message_id: messageId,
    ...sanitizeOptions(options)
  };

  if (typeof query.message.text === 'string') {
    try {
      return await bot.editMessageText(text, base);
    } catch (error) {
      if (isStyleUnsupportedError(error)) {
        try {
          console.warn('[menu] editMessageText style unsupported. Retrying without style.');
          return await bot.editMessageText(text, safeBase);
        } catch (_) {
          return sendMessageWithFallback(bot, chatId, text, options);
        }
      }
      return sendMessageWithFallback(bot, chatId, text, options);
    }
  }

  if (typeof query.message.caption === 'string' || query.message.caption === undefined) {
    try {
      return await bot.editMessageCaption(text, base);
    } catch (error) {
      if (isStyleUnsupportedError(error)) {
        try {
          console.warn('[menu] editMessageCaption style unsupported. Retrying without style.');
          return await bot.editMessageCaption(text, safeBase);
        } catch (_) {
          return sendMessageWithFallback(bot, chatId, text, options);
        }
      }
      return sendMessageWithFallback(bot, chatId, text, options);
    }
  }

  return sendMessageWithFallback(bot, chatId, text, options);
}

async function buildGlobalStatusText(requesterUserId, isAdmin) {
  const workers = await db.getWorkers();
  const queue = await db.getQueue();
  const builds = await db.getAllJobs();

  // Fix: use `!== false` to match pool.js behavior (workers without `enabled` field are included)
  const enabledWorkers = workers.filter(w => w.enabled !== false);
  const buildingWorkers = enabledWorkers.filter(w => w.status === 'building');
  const processing = buildingWorkers.length;
  // Fix: maxConcurrent slot yang ditampilkan harus mengikuti batas config
  // (config.workers.maxConcurrentBuilds), bukan cuma jumlah worker yang
  // kebetulan terdaftar. Kalau worker terdaftar lebih sedikit dari batas
  // config, slot efektif ya mengikuti jumlah worker yang ada.
  const config = require('../../config');
  const maxConcurrent = Math.min(
    enabledWorkers.length || 0,
    config.workers?.maxConcurrentBuilds || enabledWorkers.length || 0
  ) || enabledWorkers.length;

  const buildStats = await db.getDisplayBuildStats();
  const successCount = buildStats.success;
  const failCount = buildStats.failed;
  const avgDurationSeconds = buildStats.avgDurationSeconds;

  // Escape HTML helper
  const escapeHtml = (text) => {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  };

  // Format seconds to human-readable
  const formatTime = (totalSec) => {
    const s = Math.max(0, Math.floor(totalSec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0) return `${r}s`;
    return `${m}m ${r}s`;
  };

  // Helper to format user display with clickable link
  const formatUserDisplay = (item) => {
    const userId = item?.userId;
    if (!userId) return '<tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> User';
    let displayName = '';
    if (item.userUsername) {
      displayName = `@${item.userUsername}`;
    } else {
      const firstName = item.userFirstName || '';
      const lastName = item.userLastName || '';
      displayName = `${firstName} ${lastName}`.trim() || 'User';
    }
    return `<a href="tg://user?id=${userId}">${escapeHtml(displayName)}</a>`;
  };

  // Get worker friendly name
  const getWorkerName = (w, index) => {
    if (w.label) return escapeHtml(w.label);
    if (w.alias) return escapeHtml(w.alias);
    return `Worker ${index + 1}`;
  };

  // Get worker type icon & label
  const getWorkerTypeTag = (w) => {
    if (w.type === 'github') return '<tg-emoji emoji-id="5456140674028019486">⚡</tg-emoji>';
    return '<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️';
  };

  // Server status
  let statusIcon = '<tg-emoji emoji-id="5416081784641168838">🟢</tg-emoji>';
  let statusText = 'Siap';
  if (maxConcurrent > 0 && processing >= maxConcurrent) {
    statusIcon = '<tg-emoji emoji-id="5411225014148014586">🔴</tg-emoji>';
    statusText = 'Penuh';
  } else if (processing > 0) {
    statusIcon = '🟡';
    statusText = 'Aktif';
  } else if (enabledWorkers.length === 0) {
    statusIcon = '⚫';
    statusText = 'Tidak Ada Worker';
  }

  // Find user's active build
  const findActiveBuildForUser = () => {
    for (const w of enabledWorkers) {
      if (w.status === 'building' && w.currentUserId === requesterUserId) {
        return {
          worker: w,
          job: {
            jobId: w.currentJobId,
            startedAt: w.buildStartedAt
          }
        };
      }
    }
    return null;
  };

  const getEstimatedWaitMinutes = (position) => {
    if (maxConcurrent <= 0) return null;
    const minutes = Math.ceil(((Math.max(1, position) - 1) / maxConcurrent) * (avgDurationSeconds / 60));
    return Math.max(1, minutes);
  };

  // ═══ Build Message ═══
  let message = `<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji> <b>Status Antrian Build</b>\n━━━━━━━━━━━━━━━━━━\n\n`;
  message += `<tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>ID:</b> <code>${requesterUserId}</code>\n`;
  message += `${statusIcon} <b>Server:</b> ${statusText}\n`;
  message += `<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> <b>Slot:</b> ${processing}/${maxConcurrent}\n`;

  // ═══ Workers grouped by type (Hybrid) ═══
  const vpsWorkers = enabledWorkers.filter(w => w.type === 'vps');
  const ghWorkers = enabledWorkers.filter(w => w.type === 'github');

  // Render worker list for a group
  const renderWorkerGroup = (groupWorkers, groupLabel, groupIcon) => {
    if (groupWorkers.length === 0) return '';

    let section = `\n${groupIcon} <b>${groupLabel} (${groupWorkers.length}):</b>\n`;

    groupWorkers.forEach((w, i) => {
      let wIcon = '<tg-emoji emoji-id="5411225014148014586">🔴</tg-emoji>';
      let wStatus = 'Offline';

      if (w.status === 'ready' || w.status === 'online') {
        wIcon = '<tg-emoji emoji-id="5416081784641168838">🟢</tg-emoji>'; wStatus = 'Siap';
      } else if (w.status === 'building') {
        wIcon = '🟡'; wStatus = 'Sedang Build';
      } else if (w.status === 'installing') {
        wIcon = '<tg-emoji emoji-id="5449683594425410231">🔵</tg-emoji>'; wStatus = 'Installing';
      } else if (w.status === 'cooldown') {
        wIcon = '<tg-emoji emoji-id="5375061715933213332">🔵</tg-emoji>'; wStatus = 'Cooldown';
      }

      const name = getWorkerName(w, i);
      section += `\n${wIcon} <b>${name}</b> — ${wStatus}\n`;

      if (w.status === 'building' && w.currentUserId) {
        // Fix: build status in DB is 'running', not 'building'
        const build = builds.find(b => b.userId === w.currentUserId && (b.status === 'running' || b.status === 'building'));
        if (build) {
          const startedAt = build.startedAt || w.buildStartedAt;
          // Safe duration calculation with valid date check
          let durationSec = 0;
          if (startedAt) {
            const startTime = new Date(startedAt).getTime();
            if (!isNaN(startTime)) {
              durationSec = Math.round((Date.now() - startTime) / 1000);
            }
          }
          const isMe = w.currentUserId === requesterUserId;
          const est = avgDurationSeconds > 0 ? ` / est ~${formatTime(avgDurationSeconds)}` : '';
          // Merge build data with worker user info as fallback
          const userData = {
            userId: build.userId || w.currentUserId,
            userUsername: build.userUsername || w.currentUserUsername,
            userFirstName: build.userFirstName || w.currentUserFirstName,
            userLastName: build.userLastName || w.currentUserLastName
          };
          const userDisplay = formatUserDisplay(userData);
          section += `   └ <tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> ${userDisplay} (${formatTime(durationSec)})${est}${isMe ? ' ← <b>Anda</b>' : ''}\n`;
        } else {
          // Fallback: use worker's stored data
          const startedAt = w.buildStartedAt;
          let durationSec = 0;
          if (startedAt) {
            const startTime = new Date(startedAt).getTime();
            if (!isNaN(startTime)) {
              durationSec = Math.round((Date.now() - startTime) / 1000);
            }
          }
          const isMe = w.currentUserId === requesterUserId;
          // Create user data from worker stored info
          const userData = {
            userId: w.currentUserId,
            userUsername: w.currentUserUsername,
            userFirstName: w.currentUserFirstName,
            userLastName: w.currentUserLastName
          };
          const userDisplay = formatUserDisplay(userData);
          section += `   └ <tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> ${userDisplay} (${formatTime(durationSec)})${isMe ? ' ← <b>Anda</b>' : ''}\n`;
        }
      } else if (w.status === 'building') {
        // Building but no user info (edge case)
        section += `   └ <tg-emoji emoji-id="5226702984204797593">🔄</tg-emoji> Sedang Build\n`;
      } else if (w.status === 'ready' || w.status === 'online') {
        const installOk = !w.installationStatus || w.installationStatus === 'installed';
        if (!installOk) {
          section += `   └ <tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Belum terinstal (status: ${escapeHtml(w.installationStatus || 'missing')})\n`;
        } else {
          section += `   └ <tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Tersedia untuk build\n`;
        }
      } else if (w.status === 'installing') {
        section += `   └ <tg-emoji emoji-id="5413398757226076065">🔧</tg-emoji> Sedang install dependencies\n`;
      } else if (w.status === 'cooldown') {
        const remaining = w.cooldownUntil ? Math.max(0, Math.round((w.cooldownUntil - Date.now()) / 1000)) : 0;
        section += `   └ <tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Siap dalam ~${remaining}s\n`;
      } else {
        // Unknown status - show the actual status for debugging
        const statusText = w.status || 'Unknown';
        section += `   └ <tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Status: ${escapeHtml(statusText)}\n`;
      }
    });

    return section;
  };

  message += renderWorkerGroup(vpsWorkers, 'Worker VPS', '<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️');
  message += renderWorkerGroup(ghWorkers, 'Worker GitHub', '<tg-emoji emoji-id="5456140674028019486">⚡</tg-emoji>');

  // ═══ Queue ═══
  if (queue.length > 0) {
    message += `\n<b><tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Antrian (${queue.length}):</b>\n`;
    const queueList = queue.slice(0, 8);
    queueList.forEach((item, idx) => {
      const isMe = item.userId === requesterUserId;
      const userDisplay = formatUserDisplay(item);
      message += `${idx + 1}. <tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> ${userDisplay}${isMe ? ' ← <b>Anda</b>' : ''}\n`;
    });
    if (queue.length > 8) {
      message += `<i>...dan ${queue.length - 8} lainnya</i>\n`;
    }
  }

  // ═══ Statistics ═══
  message += `\n<b><tg-emoji emoji-id="5244837092042750681">📈</tg-emoji> Statistik:</b>\n`;
  message += `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> ${successCount} berhasil | <tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> ${failCount} gagal | <tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> ~${formatTime(avgDurationSeconds)}\n`;

  // ═══ User's Personal Status ═══
  const myBuild = findActiveBuildForUser();
  const myPosition = queue.findIndex(j => j.userId === requesterUserId) + 1;

  if (myBuild) {
    const startedAt = myBuild.job?.startedAt;
    const durationSec = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0;
    const est = avgDurationSeconds > 0 ? formatTime(avgDurationSeconds) : '?';
    const workerName = myBuild.worker.label || myBuild.worker.alias || 'Worker';
    message += `\n<tg-emoji emoji-id="5226702984204797593">🔄</tg-emoji> <b>Build Anda sedang berjalan!</b>`;
    message += `\n<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ ${escapeHtml(workerName)}`;
    message += `\n<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Berjalan: ${formatTime(durationSec)} | Estimasi: ~${est}`;
  } else if (myPosition > 0) {
    const waitMin = getEstimatedWaitMinutes(myPosition);
    message += `\n<tg-emoji emoji-id="5217954011268797485">🎫</tg-emoji> <b>Anda di posisi #${myPosition}</b> (~${waitMin} menit)`;
    message += `\n<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <i>Build otomatis dimulai saat giliran tiba!</i>`;
  } else {
    message += `\n<tg-emoji emoji-id="5422439311196834318">💡</tg-emoji> <i>Klik tombol di bawah untuk mulai build!</i>`;
  }

  return message;
}

async function menuHandler(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const isAdmin = isAdminUser(userId);
  const isReseller = await db.isReseller(userId);

  if (maintenance.isEnabled() && !isAdmin) {
    return bot.answerCallbackQuery(query.id, {
      text: 'Bot sedang maintenance. Coba lagi nanti.',
      show_alert: true
    });
  }


  if (data === 'bc_confirm' || data === 'bc_cancel') {
    if (!isAdmin) {
      return bot.answerCallbackQuery(query.id, {
        text: 'Hanya admin yang dapat menjalankan broadcast.',
        show_alert: true
      });
    }

    const bc = global.pendingBroadcast;
    const expired = !bc || (Date.now() - Number(bc.createdAt || 0) > 30 * 60 * 1000);
    if (expired || String(bc.adminUserId) !== String(userId)) {
      global.pendingBroadcast = null;
      return bot.answerCallbackQuery(query.id, {
        text: 'Sesi broadcast kadaluarsa.',
        show_alert: true
      });
    }

    if (data === 'bc_cancel') {
      global.pendingBroadcast = null;
      await bot.answerCallbackQuery(query.id, { text: 'Broadcast dibatalkan.' });
      await bot.editMessageText('<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>Broadcast dibatalkan.</b>', {
        chat_id: bc.adminChatId,
        message_id: bc.confirmMsgId,
        parse_mode: 'HTML'
      }).catch(() => { });
      return;
    }

    if (bc.processing) {
      return bot.answerCallbackQuery(query.id, { text: 'Broadcast sedang berjalan...' });
    }

    bc.processing = true;
    global.pendingBroadcast = bc;
    await bot.answerCallbackQuery(query.id, { text: 'Memulai broadcast...' });

    const users = Array.isArray(bc.users) ? bc.users : [];
    const total = users.length;
    let success = 0;
    let failed = 0;
    const startedAt = Date.now();

    const getProgressBar = (current, max) => {
      const safeMax = Math.max(1, Number(max) || 1);
      const percent = Math.round((Math.max(0, current) / safeMax) * 100);
      const filled = Math.round(percent / 5);
      const empty = 20 - filled;
      return `${'█'.repeat(Math.max(0, filled))}${'░'.repeat(Math.max(0, empty))}`;
    };

    const renderProgress = async (current) => {
      const percent = total > 0 ? Math.round((current / total) * 100) : 100;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      await bot.editMessageText(`
<tg-emoji emoji-id="5188481279963715781">🚀</tg-emoji> <b>BROADCAST IN PROGRESS</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> <b>Progress:</b>
<code>[${getProgressBar(current, total)}]</code> ${percent}%

<tg-emoji emoji-id="5388894010297303730">📬</tg-emoji> Sent: <code>${success}</code>
<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Failed: <code>${failed}</code>
<tg-emoji emoji-id="5453957997418004470">👥</tg-emoji> Total: <code>${total}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji>  Elapsed: <code>${elapsed}s</code>
      `.trim(), {
        chat_id: bc.adminChatId,
        message_id: bc.confirmMsgId,
        parse_mode: 'HTML'
      }).catch(() => { });
    };

    await renderProgress(0);

    for (let i = 0; i < users.length; i++) {
      const targetUserId = users[i];
      try {
        if (bc.isReply && bc.replyMsgId) {
          await bot.forwardMessage(targetUserId, bc.adminChatId, bc.replyMsgId);
        } else {
          try {
            await bot.sendMessage(targetUserId, bc.textContent, { parse_mode: 'HTML' });
          } catch (sendErr) {
            const errMessage = String(sendErr?.message || sendErr?.response?.body?.description || '').toLowerCase();
            if (errMessage.includes('parse')) {
              await bot.sendMessage(targetUserId, bc.textContent);
            } else {
              throw sendErr;
            }
          }
        }
        success += 1;
      } catch (_) {
        failed += 1;
      }

      const current = i + 1;
      if (current % 10 === 0 || current === total) {
        await renderProgress(current);
      }

      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const totalTime = Math.round((Date.now() - startedAt) / 1000);
    const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

    await bot.editMessageText(`
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>BROADCAST COMPLETE</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="5388894010297303730">📬</tg-emoji> Sent: <code>${success}</code>
<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Failed: <code>${failed}</code>
<tg-emoji emoji-id="5244837092042750681">📈</tg-emoji> Success Rate: <code>${successRate}%</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Total Time: <code>${totalTime}s</code>
<tg-emoji emoji-id="5413879192267805083">📅</tg-emoji> Completed: <code>${new Date().toLocaleString('id-ID')}</code>
    `.trim(), {
      chat_id: bc.adminChatId,
      message_id: bc.confirmMsgId,
      parse_mode: 'HTML'
    }).catch(() => { });

    global.pendingBroadcast = null;
    return;
  }
  // Handle installvps callback - Gen 4 Style with Streaming UI
  if (typeof data === 'string' && data.startsWith('installvps_')) {
    if (!isAdmin) {
      return bot.answerCallbackQuery(query.id, { text: 'Hanya admin yang dapat menjalankan perintah ini.', show_alert: true });
    }

    const workerId = data.replace('installvps_', '');
    const workers = await db.getWorkers();
    const worker = workers.find(w => w.id === workerId);

    if (!worker) {
      return bot.answerCallbackQuery(query.id, { text: 'Worker tidak ditemukan.', show_alert: true });
    }

    // Confirm installation and start streaming UI
    await bot.answerCallbackQuery(query.id);

    // Delete the selection message and send new status message
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });

    const statusMsg = await bot.sendMessage(chatId, `
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>VPS WORKER INSTALLATION</b>
━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Memulai instalasi remote...
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>Target:</b> <code>${worker.label}</code> (${worker.host})
<i>Ini bisa memakan waktu 15-30 menit</i>
    `.trim(), { parse_mode: 'HTML' });

    // Import streaming function from installer
    const { runInstallationWithStreaming } = require('../../worker/installer');

    // Run installation with streaming updates using the installer
    const installer = require('../../worker/installer');
    runInstallationWithStreaming(bot, chatId, statusMsg.message_id, worker, installer);

    return;
  }

  if (typeof data === 'string' && data.startsWith('resellerreq:')) {
    const reseller = require('./reseller');
    return reseller.handleApprovalCallback(bot, query);
  }

  // Handle join check callback
  if (data === 'check_join') {
    const allJoined = await joinChecker.isAllJoined(bot, userId);

    const finalMenu = getMainMenu(true);

    if (allJoined) {
      return sendMessageWithFallback(bot, chatId, '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Terima kasih! Kamu sudah bergabung di semua channel/grup. Selamat menggunakan bot ini!', {
        reply_markup: {
          inline_keyboard: finalMenu
        }
      });
    } else {
      return bot.answerCallbackQuery(query.id, { text: 'Kamu belum bergabung di semua channel/grup.', show_alert: true });
    }
  }

  // Handle build APK menu
  if (data === 'build_apk') {
  const allJoined = await joinChecker.isAllJoined(bot, userId);
  if (!allJoined) {
    const channels = config.requiredJoins.map((handle, idx) => {
      const url = `https://t.me/${handle.replace('@', '')}`;
      return [{ text: `Channel ${idx + 1}`, url }];
    });
    const keyboard = [
      ...channels
    ];

    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5364090007227210044">👋</tg-emoji> Halo! Sebelum menggunakan bot ini, kamu wajib bergabung di semua channel/grup berikut:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard,
      }
    });
  }

  return editOrSend(bot, query, 'Silakan pilih mode build:', {
    reply_markup: {
      inline_keyboard: buildMenu
    }
  });
}

  // Handle cancel of a BUILD THAT IS CURRENTLY RUNNING on a worker (the
  // "❌ Batal Build" button attached to the live progress message, distinct
  // from the plain "Batal" button used earlier in the flow before a job
  // even exists — see the `cancel_build` handler below for that one).
  if (data.startsWith('cancel_running_build_')) {
    const jobId = data.slice('cancel_running_build_'.length);

    const entry = await jobRegistry.requestCancel(jobId);
    if (!entry) {
      // Job already finished (succeeded/failed/timed out) by the time the
      // user tapped the button, or it's a job type that was never
      // registered (shouldn't happen, but fail safe).
      return bot.answerCallbackQuery(query.id, {
        text: 'Build ini sudah tidak berjalan lagi.',
        show_alert: true,
      });
    }

    await bot.answerCallbackQuery(query.id, { text: 'Membatalkan build...' });

    // For GitHub Actions jobs, also cancel the actual workflow run via the
    // GitHub API so compute time isn't wasted on a run nobody wants
    // anymore. VPS jobs are already handled by jobRegistry.requestCancel's
    // SSH pkill above.
    if (entry.worker && entry.worker.type === 'github' && entry.runId) {
      try {
        await axios.post(
          `https://api.github.com/repos/${entry.worker.repo}/actions/runs/${entry.runId}/cancel`,
          {},
          { headers: { 'Authorization': `Bearer ${entry.worker.token}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
      } catch (cancelErr) {
        console.warn(`[CancelBuild] Failed to cancel GitHub run ${entry.runId}: ${cancelErr.message}`);
      }
    }

    const cancelText = `
<tg-emoji emoji-id="6206110936789423908">❌</tg-emoji> <b>BUILD DIBATALKAN</b>
━━━━━━━━━━━━━━━━━━

<i>Proses build telah dibatalkan. Seluruh berkas temporary di server &amp; worker telah dibersihkan bersih.</i>
    `.trim();

    const editOptions = {
      chat_id: entry.chatId || chatId,
      message_id: entry.messageId || query.message.message_id,
      parse_mode: 'HTML',
    };

    // A tiny grace window before the FIRST edit. entry.cancelled was just
    // flipped to true by requestCancel() above, but vpsWorker.js's smooth-
    // progress timer (ticking every 1s) and any in-flight pipeline
    // onProgress() call check that flag themselves before sending their own
    // Telegram edit — if one of those edits had already left this process
    // (network request in flight) in the instant before the flag flipped,
    // it can still land at Telegram's servers AFTER this cancellation edit
    // and visually overwrite it. Waiting briefly here first lets those
    // already-guarded checks (see publishProgress/onProgress in
    // vpsWorker.js) catch up and self-suppress before we send ours.
    await new Promise((resolve) => setTimeout(resolve, 400));

    try {
      await bot.editMessageText(cancelText, editOptions);
    } catch (editErr) {
      // Fall back to a fresh message if the original couldn't be edited
      // (e.g. it was already replaced by a success/failure message in a
      // race between the click and the pipeline's own finalization).
      console.warn(`[CancelBuild] Failed to edit progress message: ${editErr.message}`);
      await bot.sendMessage(entry.chatId || chatId, cancelText, { parse_mode: 'HTML' }).catch(() => {});
    }

    // Belt-and-suspenders re-assertion: re-send the exact same cancelled
    // edit once more shortly after. If some already in-flight progress
    // update (started a hair before the 400ms guard above) still managed
    // to slip in and overwrite our first edit, this second pass — sent
    // well after the remote kill command has had time to actually
    // terminate the process and after the timer's own isCancelled() guard
    // has had at least one more 1-second tick to fire — corrects the
    // display back to "dibatalkan" rather than leaving a stale progress bar
    // as the last thing the user sees. Silently ignored if the content is
    // already identical (Telegram's "message is not modified" case).
    setTimeout(async () => {
      try {
        await bot.editMessageText(cancelText, editOptions);
      } catch (_) {
        // Either already showing this exact text, or the message is gone —
        // both are fine outcomes here, nothing further to correct.
      }
    }, 2500);

    return;
  }

  // Handle cancel build - clear session and return to main menu
  if (data === 'cancel_build') {
    session.clear(userId);
    const finalMenu = getMainMenu(true);
    return bot.editMessageText('<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Proses build dibatalkan. Kembali ke menu utama.', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: 'Menu', icon_custom_emoji_id: "5197269100878907942", callback_data: 'main_menu' }]]
      }
    });
  }

  // Handle ZIP build type selection
  if (data === 'zip_build_release' || data === 'zip_build_debug') {
    const allJoined = await joinChecker.isAllJoined(bot, userId);
    if (!allJoined) {
      const channels = config.requiredJoins.map((handle, idx) => {
        const url = `https://t.me/${handle.replace('@', '')}`;
        return [{ text: `Channel ${idx + 1}`, url }];
      });
      const keyboard = [
        ...channels
      ];

      return bot.sendMessage(chatId, '<tg-emoji emoji-id="5364090007227210044">👋</tg-emoji> Halo! Sebelum menggunakan bot ini, kamu wajib bergabung di semua channel/grup berikut:', {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: keyboard,
        }
      });
    }

    const buildType = data === 'zip_build_release' ? 'release' : 'debug';
    const userState = session.get(userId);

    if (!userState || userState.type !== 'zip_to_apk' || userState.step !== 'build_type') {
      return bot.answerCallbackQuery(query.id, { text: 'Sesi tidak valid atau sudah kadaluarsa', show_alert: true });
    }

    await bot.answerCallbackQuery(query.id);
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });

    // Send initial progress message
    const { sendBuildStart } = require('../utils/progressUI');
    const progressMessage = await sendBuildStart(bot, chatId, userState.appName, `ZIP Project (${buildType})`);
    const messageId = progressMessage.message_id;

    // Create job with selected build type
    const jobId = `job-${Date.now()}`;
    const job = {
      jobId,
      userId,
      chatId: userState.chatId || chatId,
      progressMessageId: messageId,
      projectType: 'flutter', // Will be detected by worker
      mode: 'zip',
      buildType: buildType,
      fileId: userState.fileId,
      fileName: userState.fileName,
      localFilePath: userState.localFilePath || null, // Pre-downloaded ZIP path
      payload: {
        appName: userState.appName,
        buildType: buildType
      },
      appName: userState.appName,
      userFirstName: userState.userFirstName,
      userLastName: userState.userLastName,
      userUsername: userState.userUsername,
      createdAt: new Date().toISOString()
    };

    const pool = require('../../worker/pool');
    const result = await pool.assignJob(job);

    if (result.inQueue) {
      bot.sendMessage(chatId, `<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Semua worker penuh. Kamu berada di antrian #${result.position}.`, { parse_mode: 'HTML' });
    } else if (!result.assigned) {
      bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Gagal memproses job: ${result.error || 'Terjadi kesalahan'}`, { parse_mode: 'HTML' });
    }

    session.clear(userId);
    return;
  }

  // Handle listakses pagination
  if (typeof data === 'string' && data.startsWith('listakses_page_')) {
    const pageMatch = data.match(/listakses_page_(\d+)/);
    if (pageMatch) {
      const page = parseInt(pageMatch[1], 10);

      try {
        // Get members data directly
        const accessKeyService = require('../utils/accessKeyService');
        const members = accessKeyService.listMembers();

        if (members.length === 0) {
          return bot.answerCallbackQuery(query.id, { text: 'Tidak ada member', show_alert: true });
        }

        const itemsPerPage = 10;
        const totalPages = Math.ceil(members.length / itemsPerPage);

        // Validate page
        let currentPage = page;
        if (currentPage < 1) currentPage = 1;
        if (currentPage > totalPages) currentPage = totalPages;

        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = Math.min(startIndex + itemsPerPage, members.length);
        const pageMembers = members.slice(startIndex, endIndex);

        // Fetch user info from Telegram API to get usernames
        const enrichMemberData = async (member) => {
          try {
            const chat = await bot.getChat(member.telegramId);
            return {
              ...member,
              username: chat.username || member.username,
              firstName: chat.first_name,
              lastName: chat.last_name
            };
          } catch (err) {
            return member;
          }
        };

        // Enrich all page members with user data
        const enrichedMembers = await Promise.all(pageMembers.map(enrichMemberData));

        // Build text
        let listText = `<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji> <b>Daftar Member Aktif</b>\n`;
        listText += `━━━━━━━━━━━━━━━━━━\n`;
        listText += `<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Total: ${members.length} member | Halaman ${currentPage}/${totalPages}\n\n`;

        enrichedMembers.forEach((m, i) => {
          const globalIndex = startIndex + i + 1;
          const expired = m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : 'Permanent';
          let userDisplay;
          if (m.username) {
            userDisplay = `<a href="tg://user?id=${m.telegramId}">@${m.username}</a>`;
          } else if (m.firstName) {
            const fullName = `${m.firstName}${m.lastName ? ' ' + m.lastName : ''}`;
            userDisplay = `<a href="tg://user?id=${m.telegramId}">${fullName}</a>`;
          } else {
            userDisplay = `<a href="tg://user?id=${m.telegramId}">User ${m.telegramId}</a>`;
          }
          listText += `${globalIndex}. <tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> ${userDisplay}\n   <tg-emoji emoji-id="5413879192267805083">📅</tg-emoji> Expired: ${expired}\n\n`;
        });

        // Build keyboard
        const keyboard = { inline_keyboard: [] };
        if (totalPages > 1) {
          const navButtons = [];
          if (currentPage > 1) {
            navButtons.push({ text: 'Prev', icon_custom_emoji_id: "6084901676886526521", callback_data: `listakses_page_${currentPage - 1}` });
          }
          navButtons.push({ text: `${currentPage}/${totalPages}`, icon_custom_emoji_id: "5433982607035474385", callback_data: 'listakses_current' });
          if (currentPage < totalPages) {
            navButtons.push({ text: 'Next', icon_custom_emoji_id: "6084704202880191624", callback_data: `listakses_page_${currentPage + 1}` });
          }
          keyboard.inline_keyboard.push(navButtons);
        }
        keyboard.inline_keyboard.push([{ text: 'Kembali ke Menu', icon_custom_emoji_id: "6084901676886526521", callback_data: 'main_menu' }]);

        // Edit message instead of delete+send
        await bot.editMessageText(listText, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: keyboard
        });

        await bot.answerCallbackQuery(query.id);

      } catch (err) {
        console.error('[Pagination Error]', err);
        await bot.answerCallbackQuery(query.id, { text: 'Gagal memuat halaman', show_alert: true });
      }
      return;
    }
  }

  // Handle back to main menu
  if (data === 'main_menu') {
    const finalMenu = getMainMenu(true);

    return editOrSend(bot, query, 'Silakan pilih menu di bawah:', {
      reply_markup: {
        inline_keyboard: finalMenu
      }
    });
  }

  if (data === 'commands') {
    const text = buildCommandsMessage(isAdmin, isReseller);
    return editOrSend(bot, query, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Kembali', icon_custom_emoji_id: "6084901676886526521", callback_data: 'main_menu' }]
        ]
      }
    });
  }

  if (data === 'status_build') {
    const text = await buildGlobalStatusText(userId, isAdmin);
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Refresh', icon_custom_emoji_id: "5226702984204797593", callback_data: 'status_build_refresh' },
            { text: 'Kembali', icon_custom_emoji_id: "6084901676886526521", callback_data: 'status_build_back' }
          ]
        ]
      }
    });
  }

  // Handle status build refresh
  if (data === 'status_build_refresh') {
    const text = await buildGlobalStatusText(userId, isAdmin);
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
    return bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Refresh', icon_custom_emoji_id: "5226702984204797593", callback_data: 'status_build_refresh' },
            { text: 'Kembali', icon_custom_emoji_id: "6084901676886526521", callback_data: 'status_build_back' }
          ]
        ]
      }
    });
  }

  // Handle status build back - delete message and show main menu
  if (data === 'status_build_back') {
    await bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
    const mainMenuKeyboard = getMainMenu(isAdmin);
    return bot.sendMessage(chatId, 'Silakan pilih menu di bawah:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: mainMenuKeyboard
      }
    });
  }

  // Handle build mode: zip_to_apk
  if (data === 'zip_to_apk') {
  const allJoined = await joinChecker.isAllJoined(bot, userId);
  if (!allJoined) {
    const channels = config.requiredJoins.map((handle, idx) => {
      const url = `https://t.me/${handle.replace('@', '')}`;
      return [{ text: `Channel ${idx + 1}`, url }];
    });
    const keyboard = [
      ...channels
    ];

    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5364090007227210044">👋</tg-emoji> Halo! Sebelum menggunakan bot ini, kamu wajib bergabung di semua channel/grup berikut:', {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: keyboard,
      }
    });
  }

  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <b>Build dari ZIP</b>
━━━━━━━━━━━━━━━━━━

Silakan kirim file <b>.zip</b> project Flutter/Android Anda.

<i>Pastikan source code lengkap (lib/, android/, pubspec.yaml/gradlew, dll).</i>
  `.trim(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'cancel_build' }]]
    }
  });
}
  // Handle build mode: url_to_apk
  if (data === 'url_to_apk') {
    const message = `
<tg-emoji emoji-id="5363892211098339885">📱</tg-emoji> <b>Buat APK Baru</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 1/3: URL Website</b>

Silakan kirim URL website yang ingin dijadikan aplikasi.

<b>Contoh:</b>
<code>https://google.com</code>
<code>https://facebook.com</code>

<i><tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ URL harus diawali http:// atau https://</i>
    `.trim();
    return bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'cancel_build' }]
        ]
      }
    });
  }
  // URL to APK Flow Steps
  const userState = session.get(userId);
  if (userState && userState.type === 'url_to_apk') {
    const renderIconStep = (state) => `
<tg-emoji emoji-id="5429200581858182504">🖼</tg-emoji>️ <b>Buat APK Baru</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 3/3: Icon Aplikasi</b>

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${state.url}</code>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Nama: <b>${state.appName || 'My App'}</b>

Kirim foto untuk icon aplikasi (opsional).

<i>Disarankan ukuran 512x512 (rasio 1:1)</i>

Atau klik tombol di bawah untuk lanjut tanpa icon.
    `.trim();

    const renderConfirmStep = (state) => `
<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <b>Konfirmasi Build APK</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${state.url}</code>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Nama: <b>${state.appName || 'My App'}</b>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Icon: ${state.iconFileId ? '<b>Custom</b>' : '<i>Default</i>'}

Klik tombol di bawah untuk memulai build.
`.trim();

    if (data === 'change_name') {
      userState.step = 2;
      session.set(userId, userState);
      return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5258500400918587241">📝</tg-emoji> <b>Buat APK Baru</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 2/3: Nama Aplikasi</b>

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${userState.url}</code>

Sekarang kirim nama aplikasi Anda.

<i>Contoh: My App</i>
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'cancel_build' }]
          ]
        }
      });
    }

    if (data === 'skip_icon') {
      userState.step = 5;
      userState.iconFileId = null;
      session.set(userId, userState);
      return bot.editMessageText(renderConfirmStep(userState), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Buat APK', icon_custom_emoji_id: "5188481279963715781", callback_data: 'confirm_url_build' }],
            [{ text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'cancel_build' }]
          ]
        }
      });
    }

    if (data === 'confirm_url_build') {
      await bot.answerCallbackQuery(query.id).catch(() => { });
      const confirmMessageId = query?.message?.message_id;

      const job = {
        jobId: userState.jobId,
        userId,
        chatId,
        projectType: 'android',
        mode: 'url',
        url: userState.url,
        payload: {
          appName: userState.appName || 'My App',
          customIcon: userState.iconFileId || null
        },
        // Store user info for display in status
        userFirstName: query.from.first_name,
        userLastName: query.from.last_name,
        userUsername: query.from.username,
        createdAt: new Date().toISOString()
      };

      session.clear(userId);

      if (confirmMessageId) {
        try {
          await bot.deleteMessage(chatId, confirmMessageId);
        } catch (deleteErr) {
          console.warn(`[BuildFlow] Failed deleting confirm message ${confirmMessageId}: ${deleteErr.message}`);
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: confirmMessageId }
          ).catch(() => { });
        }
      }

      const { sendBuildStart } = require('../utils/progressUI');
      const message = await sendBuildStart(bot, chatId, job.payload.appName, userState.url);
      job.progressMessageId = message.message_id;

      console.log(`[BuildFlow] Finalizing build for job ${job.jobId}, assigning to worker pool...`);
      pool.assignJob(job).then(result => {
        if (result.inQueue) {
          bot.sendMessage(chatId, `<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Semua worker penuh. Kamu berada di antrian #${result.position}.`, { parse_mode: 'HTML' });
        } else if (!result.assigned) {
          bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Gagal memproses build: ${result.error || 'Terjadi kesalahan'}`, { parse_mode: 'HTML' });
        }
      }).catch((err) => {
        console.error(`[BuildFlow] Failed assigning job ${job.jobId}:`, err.message);
        bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Gagal memproses build karena kesalahan internal.', { parse_mode: 'HTML' });
      });
      return;
    }
  }
  bot.answerCallbackQuery(query.id);
}

module.exports = menuHandler;




