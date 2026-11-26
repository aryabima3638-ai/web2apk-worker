const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const config = require('../config');
const db = require('./db');
const ownerService = require('./utils/ownerService');
const winston = require('winston');
const maintenance = require('./utils/maintenance');
const buildNotifySettings = require('./utils/buildNotifySettings');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ownerHandler = require('./handlers/ownerHandler');
const reportHandler = require('./handlers/reportHandler');

// Start web server
require('../server');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

function isAdminUser(userId) {
  return ownerService.isAdmin(userId);
}

// Reseller TIDAK terkena maintenance mode — hanya user biasa (non-admin, non-reseller) yang diblokir.
async function isMaintenanceBlocked(userId) {
  if (!maintenance.isEnabled()) return false;
  if (isAdminUser(userId)) return false;
  try {
    const reseller = await db.isReseller(userId);
    if (reseller) return false;
  } catch (err) {
    logger.warn(`[maintenance] Gagal cek status reseller untuk ${userId}: ${err.message}`);
  }
  return true;
}

function getMaintenanceKeyboard() {
  const adminLink = config.telegram?.adminContactLink || config.telegram?.informationLink || null;
  if (!adminLink) return undefined;
  return {
    inline_keyboard: [
      [{ text: '🛠 Hubungi Admin', url: adminLink }]
    ]
  };
}

function escapeHtmlText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Menampilkan pesan maintenance. Ada 2 varian:
//   - Tanpa alasan (/maintenance on saja): pesan default generik.
//   - Dengan alasan (/maintenance on <alasan bebas>): baris "Alasan:" muncul
//     berisi teks custom yang diketik admin.
// Kedua varian pakai custom emoji premium: ⚠️ (judul) dan ✍️ (baris alasan).
function getMaintenanceMessage() {
  const reason = maintenance.getReason ? maintenance.getReason() : '';

  if (reason) {
    return `
<tg-emoji emoji-id="6206077285720659346">⚠️</tg-emoji> <b>MAINTENANCE MODE</b>
━━━━━━━━━━━━━━━━━━

Bot sedang dalam perbaikan server.
<tg-emoji emoji-id="5258500400918587241">✍️</tg-emoji> Alasan: ${escapeHtmlText(reason)}
Silakan coba lagi nanti.
    `.trim();
  }

  return `
<tg-emoji emoji-id="6206077285720659346">⚠️</tg-emoji> <b>MAINTENANCE MODE</b>
━━━━━━━━━━━━━━━━━━

Bot sedang dalam perbaikan server.
Silakan coba lagi nanti.
  `.trim();
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  const value = String(url).trim();
  if (!value) return '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
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

function inferButtonStyle(button) {
  const text = String(button?.text || '').toLowerCase();

  if (/\b(batal|hapus|delete|del|tolak|stop|cancel|reject)\b/.test(text)) {
    return 'danger';
  }

  if (/\b(kembali|back|skip|lanjut|next|ok|ya|yes|setuju|approve|mulai|start)\b/.test(text)) {
    return 'success';
  }

  return 'primary';
}

function mapButtonRows(rows, buttonMapper) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    if (!Array.isArray(row)) return row;
    return row.map(button => {
      if (!button || typeof button !== 'object') return button;
      return buttonMapper(button);
    });
  });
}

function withStyledReplyMarkup(options = {}) {
  if (!options || typeof options !== 'object') return options;
  const replyMarkup = options.reply_markup;
  if (!replyMarkup || typeof replyMarkup !== 'object') return options;

  const next = { ...options, reply_markup: { ...replyMarkup } };

  if (Array.isArray(replyMarkup.inline_keyboard)) {
    next.reply_markup.inline_keyboard = mapButtonRows(replyMarkup.inline_keyboard, (button) => {
      if (button.style) return button;
      return {
        ...button,
        style: inferButtonStyle(button)
      };
    });
  }

  if (Array.isArray(replyMarkup.keyboard)) {
    next.reply_markup.keyboard = mapButtonRows(replyMarkup.keyboard, (button) => {
      if (button.style) return button;
      return {
        ...button,
        style: inferButtonStyle(button)
      };
    });
  }

  return next;
}

function stripStylesFromReplyMarkup(options = {}) {
  if (!options || typeof options !== 'object') return options;
  const replyMarkup = options.reply_markup;
  if (!replyMarkup || typeof replyMarkup !== 'object') return options;

  const next = { ...options, reply_markup: { ...replyMarkup } };

  if (Array.isArray(replyMarkup.inline_keyboard)) {
    next.reply_markup.inline_keyboard = mapButtonRows(replyMarkup.inline_keyboard, (button) => {
      const { style, ...rest } = button;
      return rest;
    });
  }

  if (Array.isArray(replyMarkup.keyboard)) {
    next.reply_markup.keyboard = mapButtonRows(replyMarkup.keyboard, (button) => {
      const { style, ...rest } = button;
      return rest;
    });
  }

  return next;
}

function patchBotApiForStyledButtons(bot) {
  let fallbackLogged = false;

  const runWithStyleFallback = async (methodName, options, execute) => {
    const styledOptions = withStyledReplyMarkup(options);

    try {
      return await execute(styledOptions);
    } catch (error) {
      if (!isStyleUnsupportedError(error)) throw error;

      if (!fallbackLogged) {
        fallbackLogged = true;
        logger.info(`Button style tidak didukung endpoint saat ini. Auto fallback non-style aktif (${methodName}).`);
      }

      const safeOptions = stripStylesFromReplyMarkup(styledOptions);
      return execute(safeOptions);
    }
  };

  const originalSendMessage = bot.sendMessage.bind(bot);
  bot.sendMessage = (chatId, text, options = {}) => {
    return runWithStyleFallback('sendMessage', options, (opts) => originalSendMessage(chatId, text, opts));
  };

  const originalSendPhoto = bot.sendPhoto.bind(bot);
  bot.sendPhoto = (chatId, photo, options = {}, fileOptions) => {
    return runWithStyleFallback('sendPhoto', options, (opts) => originalSendPhoto(chatId, photo, opts, fileOptions));
  };

  const originalEditMessageText = bot.editMessageText.bind(bot);
  bot.editMessageText = (text, options = {}) => {
    return runWithStyleFallback('editMessageText', options, (opts) => originalEditMessageText(text, opts));
  };

  const originalEditMessageCaption = bot.editMessageCaption.bind(bot);
  bot.editMessageCaption = (caption, options = {}) => {
    return runWithStyleFallback('editMessageCaption', options, (opts) => originalEditMessageCaption(caption, opts));
  };
}

function parseApiPort(value, fallback = 8081) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function rankWorkerLocalApiCandidate(worker) {
  if (!worker || worker.type !== 'vps' || worker.enabled === false) return -1;
  const status = String(worker.status || '').toLowerCase();
  if (status.includes('offline')) return 0;
  if (status.includes('online')) return 3;
  if (status.includes('building') || status.includes('installing')) return 2;
  return 1;
}

function buildWorkerLocalApiCandidates(workers = []) {
  if (!Array.isArray(workers)) return [];

  const ranked = [...workers]
    .filter(worker => worker && worker.type === 'vps' && worker.enabled !== false)
    .sort((a, b) => {
      const rankDiff = rankWorkerLocalApiCandidate(b) - rankWorkerLocalApiCandidate(a);
      if (rankDiff !== 0) return rankDiff;

      const aPing = Date.parse(a.lastPingAt || '') || 0;
      const bPing = Date.parse(b.lastPingAt || '') || 0;
      return bPing - aPing;
    });

  const seen = new Set();
  const candidates = [];

  for (const worker of ranked) {
    const explicit = normalizeBaseUrl(worker.localApiUrl);
    if (explicit && !seen.has(explicit)) {
      seen.add(explicit);
      candidates.push(explicit);
      continue;
    }

    if (worker.host) {
      const fallback = normalizeBaseUrl(`http://${worker.host}:${parseApiPort(worker.apiPort)}`);
      if (fallback && !seen.has(fallback)) {
        seen.add(fallback);
        candidates.push(fallback);
      }
    }
  }

  return candidates;
}

async function resolveLocalApiCandidates() {
  const seen = new Set();
  const candidates = [];

  try {
    const workers = await db.getWorkers();
    const workerCandidates = buildWorkerLocalApiCandidates(workers);
    for (const candidate of workerCandidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      candidates.push(candidate);
    }
  } catch (error) {
    logger.info(`Local API discovery: gagal membaca workers (${error.message}).`);
  }

  return candidates;
}

async function resolveBotOptions() {
  const botOptions = { 
    polling: {
      interval: 300,
      timeout: 10,
      limit: 10
    }
  };

  if (!config.telegram.useLocalApi) {
    global.isLocalApiActive = false;
    return botOptions;
  }

  const localApiCandidates = await resolveLocalApiCandidates();

  if (localApiCandidates.length === 0) {
    global.isLocalApiActive = false;
    logger.info('Mode API: Telegram public API (belum ada kandidat Local Bot API dari worker).');
    return botOptions;
  }

  for (const baseApiUrl of localApiCandidates) {
    const probeUrl = `${baseApiUrl}/bot${config.telegram.botToken}/getMe`;
    try {
      await axios.get(probeUrl, { timeout: 3000 });
      botOptions.baseApiUrl = baseApiUrl;
      global.isLocalApiActive = true;
      logger.info(`Mode API: Local Bot API aktif (${baseApiUrl}).`);
      return botOptions;
    } catch (_) {
      // try next candidate
    }
  }

  global.isLocalApiActive = false;
  logger.info(`Mode API: Semua kandidat Local Bot API tidak tersambung (${localApiCandidates.length} kandidat). Menjalankan Telegram public API.`);
  return botOptions;
}

// ====================================================================
// FITUR LOG USER BARU (ANTI-SPAM VIA DATABASE JSON)
// ====================================================================
async function sendNewUserLogKawakunChan(bot, msg) {
  // Mengambil ID Channel dari config
  const idch = config.payment.paymentChannelId; 
  if (!idch) return;

  const userId = msg.from.id;
  
  // Path file database lokal di dalam folder utils
  const logPath = path.join(__dirname, 'utils', 'logs_user.json');

  // Pastikan folder utils sudah dibuat
  const dirPath = path.dirname(logPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  // Buat file json baru berbentuk array kosong jika belum ada
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, JSON.stringify([]));
  }

  let loggedUsers = [];
  try {
    const data = fs.readFileSync(logPath, 'utf8');
    loggedUsers = JSON.parse(data);
  } catch (e) {
    loggedUsers = [];
  }

  // GERBANG ANTI-SPAM: Jika ID sudah ada di database, STOP di sini!
  if (loggedUsers.includes(userId)) return;

  const name = msg.from.first_name || 'User';
  const username = msg.from.username ? `@${msg.from.username}` : '-';
  const time = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const caption = `<blockquote><b>✨ 𝗨𝗦𝗘𝗥 𝗣𝗘𝗡𝗚𝗚𝗨𝗡𝗔 𝗕𝗔𝗥𝗨 ✨
━━━━━━━━━━━━━━━━
╭─ 👤 𝗣𝗥𝗢𝗙𝗜𝗟 𝗨𝗦𝗘𝗥
├ 👤 Nama: ${name}
├ 🆔 ID: ${userId}
├ 🏷️ Username: ${username}
╰─ 🗓️ Waktu: ${time}
━━━━━━━━━━━━━━━━
╭─ 📂 𝗙𝗜𝗧𝗨𝗥 𝗕𝗢𝗧:
├ 🛠 Build Apk Free
━━━━━━━━━━━━━━━━
"𝙆𝙖𝙡𝙖𝙪 𝙈𝙖𝙪 𝙍𝙚𝙦 𝙁𝙞𝙩𝙪𝙧 𝙋𝙫 𝘿𝙚𝙫"</b></blockquote>`;

  const videoUrl = "https://files.catbox.moe/78ix0j.mp4";

  try {
    // Kirim video log ke channel
    await bot.sendVideo(idch, videoUrl, {
      caption: caption,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 𝘽𝙤𝙩", url: `https://t.me/suwhhsd_bot`, style: "Danger" }], 
          [
            { text: "👑 𝘿𝙚𝙫 1", url: "https://t.me/uyagantengg", style: "Success" }
          ]
        ]
      }
    });

    loggedUsers.push(userId);
    fs.writeFileSync(logPath, JSON.stringify(loggedUsers, null, 2));
    logger.info(`[Log] User baru ${name} (${userId}) berhasil disimpan ke database dan dikirim ke channel.`);
    
  } catch (err) {
    logger.warn(`[Log] Gagal mengirim log video ke channel: ${err.message}`);
  }
}

async function main() {
  // SOLUTION: Flush old updates + timestamp-based filtering
  const BOT_START_TIME = Math.floor(Date.now() / 1000);
  const ACCEPTABLE_DELAY_SECONDS = 30; // Reduced from 120 to be more strict after restart

  // Bot MUST poll via Local Bot API to get valid file_ids for large files (> 20MB)
  // Public API file_ids are NOT compatible with Local Bot API instances
  // This is ONLY for receiving messages & file gateway — workers are independent
  const botOptions = await resolveBotOptions();
  
  // === CRITICAL: Flush all pending updates BEFORE starting polling ===
  // This prevents old messages/callbacks from being replayed after restart
  try {
    const token = config.telegram.botToken;
    const baseUrl = botOptions.baseApiUrl || 'https://api.telegram.org';
    
    // Get the latest update_id and set offset to skip everything before it
    const flushResp = await axios.get(`${baseUrl}/bot${token}/getUpdates`, {
      params: { offset: -1, limit: 1, timeout: 0 },
      timeout: 10000
    });
    
    if (flushResp.data?.ok && flushResp.data.result?.length > 0) {
      const lastUpdateId = flushResp.data.result[0].update_id;
      // Confirm the flush by requesting with offset = lastUpdateId + 1
      await axios.get(`${baseUrl}/bot${token}/getUpdates`, {
        params: { offset: lastUpdateId + 1, limit: 1, timeout: 0 },
        timeout: 10000
      });
      logger.info(`[Startup] Flushed pending updates (last update_id: ${lastUpdateId})`);
    } else {
      logger.info('[Startup] No pending updates to flush');
    }
  } catch (flushErr) {
    logger.warn(`[Startup] Failed to flush old updates: ${flushErr.message}`);
  }
  
  const bot = new TelegramBot(config.telegram.botToken, botOptions);
  global.bot = bot;
  
  // ═══ FIX #2: Cleanup stale worker states from previous bot session ═══
  try {
    const workers = await db.getWorkers();
    let cleaned = false;
    const nowMs = Date.now();

    for (const worker of workers) {
      // Reset stuck 'building' state — no build survives a restart
      if (worker.status === 'building') {
        logger.info(`[Startup] Resetting stale 'building' status for worker: ${worker.id}`);
        worker.status = 'online';
        delete worker.currentJobId;
        delete worker.currentUserId;
        delete worker.currentUserUsername;
        delete worker.currentUserFirstName;
        delete worker.currentUserLastName;
        delete worker.buildStartedAt;
        cleaned = true;
      }

      // Reset expired cooldowns
      if (worker.status === 'cooldown' && worker.cooldownUntil && nowMs >= worker.cooldownUntil) {
        logger.info(`[Startup] Resetting expired cooldown for worker: ${worker.id}`);
        worker.status = 'online';
        delete worker.cooldownUntil;
        cleaned = true;
      }
    }

    if (cleaned) {
      await db.saveWorkers(workers);
      logger.info('[Startup] Cleaned up stale worker states');
    }

    // Mark any lingering 'running'/'queued' jobs as failed
    const builds = await db.getBuilds();
    let buildsUpdated = false;
    for (const build of builds) {
      if (build.status === 'running' || build.status === 'queued') {
        build.status = 'failed';
        build.error = 'Bot restarted — build session lost';
        build.finishedAt = new Date().toISOString();
        buildsUpdated = true;
      }
    }
    if (buildsUpdated) {
      await db.saveBuilds(builds);
      logger.info('[Startup] Marked stale running/queued builds as failed');
    }

    // Clear the queue — queued jobs can't resume after restart
    await db.saveQueue([]);
    logger.info('[Startup] Queue cleared for fresh start');
  } catch (cleanupErr) {
    logger.warn(`[Startup] Worker cleanup failed: ${cleanupErr.message}`);
  }

  if (global.isLocalApiActive) {
    logger.info(`✅ File Gateway: Local Bot API aktif. Build workers tetap independen (masing-masing VPS).`);
  } else {
    logger.warn(`⚠️ File Gateway: Public API (file > 20MB TIDAK bisa diproses). Pastikan minimal 1 worker punya Local Bot API aktif.`);
  }
  
  // Filter for regular messages (text, document, photo, etc.)
  // GRACE_SECONDS absorbs clock skew between the VPS and Telegram's server
  // clock. Without this, if the VPS clock runs even a few seconds fast,
  // EVERY incoming message (including /start) has msgTime < BOT_START_TIME
  // forever, so shouldProcessMessage silently returns false and the bot
  // never replies — this was causing /start to not show the menu.
  const BOOT_FILTER_GRACE_SECONDS = 15;

  function shouldProcessMessage(msg) {
    if (!msg || !msg.date) return false;
    
    const msgTime = msg.date; // Unix timestamp in seconds
    const now = Math.floor(Date.now() / 1000);
    const age = now - msgTime;
    
    // Reject messages sent before this boot (with grace for clock skew)
    if (msgTime < BOT_START_TIME - BOOT_FILTER_GRACE_SECONDS) {
      return false;
    }
    
    // Reject messages that are too old (network delay, etc.)
    if (age > ACCEPTABLE_DELAY_SECONDS) {
      logger.info(`[Filter] Rejecting stale message: ${age}s old (from ${msg.from?.id})`);
      return false;
    }
    
    return true;
  }
  
  // Filter for callback queries (button clicks)
  // IMPORTANT: Don't use query.message.date — that's the ORIGINAL message time (could be hours ago)
  // Instead, check if the bot was running when the button was clicked
  function shouldProcessCallback(query) {
    if (!query) return false;
    
    // The query itself doesn't have a timestamp, but we track bot start time
    // If the update was flushed at startup, this won't even be called for old callbacks
    // Additional safety: check if the message is EXTREMELY old (> 24 hours = definitely stale)
    if (query.message?.date) {
      const msgAge = Math.floor(Date.now() / 1000) - query.message.date;
      if (msgAge > 86400) { // > 24 hours
        logger.info(`[Filter] Rejecting ancient callback: message is ${Math.floor(msgAge / 3600)}h old`);
        return false;
      }
    }
    
    return true;
  }
  
  logger.info(`[Startup] Bot ready. BOT_START_TIME=${BOT_START_TIME}, filter=${ACCEPTABLE_DELAY_SECONDS}s`);

  patchBotApiForStyledButtons(bot);
  logger.info('Bot started...');

  const startHandler = require('./handlers/start');
  const menuHandler = require('./handlers/menu');
  const adminHandler = require('./handlers/admin');
  const resellerHandler = require('./handlers/reseller');
  const zipToApkHandler = require('./handlers/buildFlow/zipToApk');
  const urlToApkHandler = require('./handlers/buildFlow/urlToApk');
  const { handleDoneCommand } = require('./handlers/transaction');
  const { handleAddAkses, handleAddAksesInput, handleAddAksesCallback, handleAddAksesPhoto } = require('./handlers/addAksesHandler');
  const { handlePaymentsCommand, handlePricesCommand, handlePaymentCallback, handlePriceCallback, handlePaymentInput, handlePaymentPhoto } = require('./handlers/paymentHandler');
  const { handleOrderCallback, handlePaymentProof, handleRejectionReason } = require('./handlers/orderHandler');
  const session = require('./session/state');
  const backup = require('./backup');
  const healthMonitor = require('../worker/healthMonitor');

    bot.onText(/\/start/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }

    // Kirim notifikasi "USER PENGGUNA BARU" ke channel (lihat
    // sendNewUserLogKawakunChan di atas). Fire-and-forget: fungsi ini sudah
    // punya gerbang anti-spam sendiri (logs_user.json) yang membuatnya
    // otomatis no-op untuk user yang sudah pernah tercatat, dan sudah
    // menelan errornya sendiri (channel belum di-set / bot belum admin di
    // sana) — jadi tidak perlu await di sini, supaya kalau pengiriman ke
    // channel lambat/gagal, itu tidak pernah menunda respons /start ke user.
    sendNewUserLogKawakunChan(bot, msg).catch((err) => {
      logger.warn(`[/start] sendNewUserLogKawakunChan error: ${err.message}`);
    });

    try {
      return await startHandler(bot, msg);
    } catch (err) {
      logger.warn(`[/start] Handler error for user ${msg.from?.id}: ${err.message}`);
      return bot.sendMessage(msg.chat.id, '⚠️ Terjadi kesalahan saat memuat menu. Coba /start lagi.').catch(() => {});
    }
  });

  bot.on('callback_query', async (query) => {
    if (!shouldProcessCallback(query)) {
      return bot.answerCallbackQuery(query.id, { text: '⌛ Session expired. Ketik /start untuk mulai ulang.' }).catch(() => {});
    }
    
    const userId = query?.from?.id;
    if (await isMaintenanceBlocked(userId)) {
      await bot.answerCallbackQuery(query.id, {
        text: '🛠 Bot sedang maintenance. Coba lagi nanti.',
        show_alert: true
      }).catch(() => {});
      return bot.sendMessage(query.message.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() }).catch(() => {});
    }

    // Handle /addakses callbacks
    const addAksesHandled = await handleAddAksesCallback(bot, query);
    if (addAksesHandled) return;

    // Handle payment callbacks
    const paymentHandled = await handlePaymentCallback(bot, query);
    if (paymentHandled) return;

    // Handle price callbacks
    const priceHandled = await handlePriceCallback(bot, query);
    if (priceHandled) return;

    // Handle order callbacks
    const orderHandled = await handleOrderCallback(bot, query);
    if (orderHandled) return;

    // Handle Laporan / Hubungi Owner (menu_report -> tampilan info cara pakai /lapor; report_owner_cancel_* -> owner batalkan laporan)
    const reportHandled = await reportHandler.handleCallback(bot, query);
    if (reportHandled) return;

    return menuHandler(bot, query);
  });

  bot.onText(/^(http|https):\/\//, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return urlToApkHandler(bot, msg);
  });

  bot.onText(/^\/done(?:@\w+)?(?:\s+[\s\S]+)?$/i, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return handleDoneCommand(bot, msg);
  });
  
  bot.onText(/\/backup/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const isOwnerAdmin = ownerService.isAdmin(userId);

    if (!isOwnerAdmin) {
        return bot.sendMessage(chatId, "<tg-emoji emoji-id=\"6084880262179588505\">❌</tg-emoji> Akses ditolak. Perintah ini hanya untuk owner.", { parse_mode: 'HTML' });
    }

    const folderToZip = path.join(__dirname, '..');
    // Write the zip OUTSIDE folderToZip (in the OS temp dir) so the backup
    // process can never accidentally include its own in-progress output file,
    // and so a previous run's leftover zip (if cleanup ever failed) can't be
    // picked up as a source item either.
    const outputFileName = `Backup_Bot_${Date.now()}.zip`;
    const outputPath = path.join(require('os').tmpdir(), outputFileName);

    // Everything the bot needs to be fully restored from scratch: full source
    // (bot/worker/web), config, and every database/*.json record (users,
    // orders, workers, access keys, reports, etc.) — all bundled as ONE zip.
    const allowedItems = [
        '.github',
        'assets',
        'bot',
        'database',
        'web',
        'worker',
        'config.js',
        'package.json',
        'package-lock.json',
        'server.js',
        'clone-runtime.js'
    ];
    // Never include these even if present under an allowed folder — they are
    // either huge/regenerable (node_modules), previous backup archives
    // (backups/ — would otherwise recursively balloon in size every run), or
    // local-only secrets/logs that shouldn't leave the server.
    const excludedNames = new Set(['node_modules', 'backups', '.git', '.env', '.DS_Store']);

    try {
        const progressMsg = await bot.sendMessage(chatId, "⏳ <b>Sedang mencadangkan seluruh source code + database bot...</b>", { parse_mode: 'HTML' });

        const zip = new AdmZip();
        const items = fs.readdirSync(folderToZip);

        // Recursively count every real file under a path that will actually
        // survive the exclude filter below — used purely to cross-check
        // against the zip's own entry count afterwards, so a silent
        // under-count (partial backup) is caught here instead of only being
        // discovered later by the user re-opening the file.
        const countFilesOnDisk = (itemPath) => {
          const base = path.basename(itemPath);
          if (excludedNames.has(base)) return 0;
          const stats = fs.statSync(itemPath);
          if (stats.isDirectory()) {
            return fs.readdirSync(itemPath).reduce((sum, child) => sum + countFilesOnDisk(path.join(itemPath, child)), 0);
          }
          return 1;
        };

        let expectedFileCount = 0;
        for (const item of items) {
            if (!allowedItems.includes(item)) continue;
            const itemPath = path.join(folderToZip, item);
            if (!fs.existsSync(itemPath)) continue;
            const stats = fs.statSync(itemPath);

            if (stats.isDirectory()) {
                expectedFileCount += countFilesOnDisk(itemPath);
                // addLocalFolder is adm-zip's own battle-tested recursive
                // directory walker (rather than a hand-rolled one), with a
                // filter callback adm-zip calls for every relative path it
                // finds — this is the officially documented way to add an
                // entire directory tree in one call, and avoids any subtle
                // path-handling edge cases a custom recursive helper could
                // introduce silently.
                zip.addLocalFolder(itemPath, item, (relativePath) => {
                  const segments = relativePath.split(/[\\/]/);
                  return !segments.some(seg => excludedNames.has(seg));
                });
            } else {
                expectedFileCount += 1;
                zip.addLocalFile(itemPath);
            }
        }

        zip.writeZip(outputPath);

        // Verify nothing silently got dropped before we tell the user this
        // is a complete backup.
        const actualFileCount = zip.getEntries().filter(e => !e.isDirectory).length;
        if (actualFileCount < expectedFileCount) {
          console.warn(`[Backup] File count mismatch: expected ${expectedFileCount}, zip has ${actualFileCount}. Backup sent anyway but flagged in caption.`);
        }

        const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
        const sizeText = sizeMB >= 1 ? `${sizeMB} MB` : `${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB`;
        const waktu = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
        const integrityLine = actualFileCount >= expectedFileCount
          ? '✅ Semua file lengkap terverifikasi'
          : `⚠️ ${expectedFileCount - actualFileCount} file mungkin tidak masuk, cek log server`;

        await bot.sendDocument(chatId, outputPath, {
            caption: `✅ <b>Backup Bot Sukses!</b>\n━━━━━━━━━━━━━━━━━━\n\n📦 Isi: source code lengkap (bot, worker, web, config) + seluruh database (users, orders, workers, reports, dll)\n📁 Total file: ${actualFileCount} item\n💾 Ukuran: ${sizeText}\n📅 Waktu: ${waktu} WIB\n${integrityLine}\n\n<i>Exclude: node_modules, .git, backups, .env, logs</i>`,
            parse_mode: 'HTML'
        }).catch(async (sendErr) => {
            logger.warn(`[Backup] Gagal kirim dokumen: ${sendErr.message}`);
            await bot.sendMessage(chatId, `❌ <b>Backup berhasil dibuat tapi gagal dikirim</b> (mungkin file terlalu besar untuk Telegram, ~${sizeText}).\n<code>${sendErr.message}</code>`, { parse_mode: 'HTML' }).catch(() => {});
            throw sendErr;
        });

        await bot.deleteMessage(chatId, progressMsg.message_id).catch(() => {});

    } catch (error) {
        logger.warn(`[Backup] Gagal melakukan backup: ${error.message}`);
        await bot.sendMessage(chatId, "❌ <b>Gagal melakukan backup:</b>\n<code>" + error.message + "</code>", { parse_mode: 'HTML' }).catch(() => {});
    } finally {
        // Always clean up the temp zip, success or failure, so disk never fills up.
        if (fs.existsSync(outputPath)) {
            fs.unlink(outputPath, (err) => {
                if (err) logger.warn(`[Backup] Gagal membersihkan file sementara: ${err.message}`);
                else logger.info(`[Backup] File zip sementara ${outputFileName} berhasil dibersihkan.`);
            });
        }
    }
});

  // /lapor [alasan bebas] - User melapor masalah/error ke owner.
  // Bisa dipakai berdiri sendiri ("/lapor min ini kenapa ya") atau sebagai
  // REPLY ke pesan berisi foto/file error, supaya lampiran itu ikut
  // diteruskan ke owner. Lihat reportHandler.js untuk detail alur lengkap.
  bot.onText(/^\/lapor(?:@\w+)?/i, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return reportHandler.handleLaporCommand(bot, msg);
  });

  // /addakses command - Create access key
  bot.onText(/\/addakses/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return handleAddAkses(bot, msg);
  });

  // /payments command - Manage payment methods
  bot.onText(/\/payments/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    return handlePaymentsCommand(bot, msg);
  });

  // /prices command - Manage prices
  bot.onText(/\/prices/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    return handlePricesCommand(bot, msg);
  });

  // /setnotifchannel <channel_id|off> - Atur channel notifikasi build sukses/gagal (owner/admin only)
  bot.onText(/\/setnotifchannel(?:\s+(\S+))?/, async (msg, match) => {
    if (!shouldProcessMessage(msg)) return;
    if (!isAdminUser(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Perintah ini hanya untuk admin/owner.', { parse_mode: 'HTML' });
    }
    const value = (match && match[1]) ? match[1].trim() : '';
    if (!value) {
      const current = buildNotifySettings.getChannelId();
      return bot.sendMessage(msg.chat.id, `
📡 <b>Channel Notifikasi Build</b>
━━━━━━━━━━━━━━━━━━

Channel aktif saat ini: <code>${current || '(belum di-set)'}</code>

Format: <code>/setnotifchannel -1001234567890</code>
Kirim <code>/setnotifchannel off</code> untuk menonaktifkan.
Bot harus sudah jadi admin di channel/grup tersebut.
      `.trim(), { parse_mode: 'HTML' });
    }
    if (value.toLowerCase() === 'off') {
      buildNotifySettings.setChannelId('');
      return bot.sendMessage(msg.chat.id, '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Notifikasi channel build dinonaktifkan.', { parse_mode: 'HTML' });
    }
    buildNotifySettings.setChannelId(value);
    return bot.sendMessage(msg.chat.id, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Channel notifikasi build diset ke: <code>${value}</code>`, { parse_mode: 'HTML' });
  });

  // /addowner <user_id> - Tambah owner baru (akses admin penuh)
  bot.onText(/\/addowner/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    return ownerHandler.handleAddOwner(bot, msg);
  });

  // /delowner <user_id> - Hapus owner (hanya owner dinamis)
  bot.onText(/\/delowner/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    return ownerHandler.handleDelOwner(bot, msg);
  });

  // /listowners - Lihat semua owner (statis + dinamis)
  bot.onText(/\/listowners/, async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    return ownerHandler.handleListOwners(bot, msg);
  });

  // Handle text input for /addakses wizard
  bot.on('message', async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (msg.text && !msg.text.startsWith('/')) {
      // Check payment handler inputs first
      const paymentInputHandled = await handlePaymentInput(bot, msg);
      if (paymentInputHandled) return;

      // Check rejection reason input
      const rejectionHandled = await handleRejectionReason(bot, msg);
      if (rejectionHandled) return;

      const handled = await handleAddAksesInput(bot, msg);
      if (handled) return;

    }
  });

  bot.on('document', async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    if (await isMaintenanceBlocked(msg.from.id)) {
      const reason = maintenance.getReason ? maintenance.getReason() : '';
      const reasonBlock = reason ? `\n<tg-emoji emoji-id="5258500400918587241">✍️</tg-emoji> Alasan: ${escapeHtmlText(reason)}\n` : '';
      return bot.sendMessage(msg.chat.id, `
<tg-emoji emoji-id="6206077285720659346">⚠️</tg-emoji> <b>MAINTENANCE MODE</b>
━━━━━━━━━━━━━━━━━━

Bot sedang dalam perbaikan server.${reasonBlock}
Upload ZIP dinonaktifkan sementara. Silakan coba lagi nanti.
      `.trim(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }

    return zipToApkHandler(bot, msg);
  });

  bot.on('photo', async (msg) => {
    if (!shouldProcessMessage(msg)) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const state = session.get(userId);

    if (await isMaintenanceBlocked(userId)) {
      const reason = maintenance.getReason ? maintenance.getReason() : '';
      const reasonBlock = reason ? `\n<tg-emoji emoji-id="5258500400918587241">✍️</tg-emoji> Alasan: ${escapeHtmlText(reason)}\n` : '';
      return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6206077285720659346">⚠️</tg-emoji> <b>MAINTENANCE MODE</b>
━━━━━━━━━━━━━━━━━━

Bot sedang dalam perbaikan server.${reasonBlock}
Upload foto dinonaktifkan sementara. Silakan coba lagi nanti.
      `.trim(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }

    if (typeof msg.caption === 'string' && /^\/done(?:@\w+)?(?:\s+[\s\S]+)?$/i.test(msg.caption.trim())) {
      return handleDoneCommand(bot, msg);
    }

    // Handle build flow photo upload (custom icon)
    if (state && state.type === 'url_to_apk' && (state.step === 3 || state.step === 4)) {
      const photo = msg.photo[msg.photo.length - 1];
      state.iconFileId = photo.file_id;
      state.step = 5;
      session.set(userId, state);

      return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <b>Konfirmasi Build APK</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${state.url}</code>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Nama: <b>${state.appName || 'My App'}</b>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Icon: <b>Custom</b>

Klik tombol di bawah untuk memulai build.
      `.trim(), {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Build Sekarang', callback_data: 'confirm_url_build', icon_custom_emoji_id: "5188481279963715781" }],
            [{ text: 'Batal', callback_data: 'cancel_build', icon_custom_emoji_id: "5210952531676504517" }]
          ]
        }
      });
    }

    // Handle /addakses payment proof photo
    const addAksesHandled = await handleAddAksesPhoto(bot, msg);
    if (addAksesHandled) return;

    // Handle order payment proof (auto order system)
    const paymentProofHandled = await handlePaymentProof(bot, msg);
    if (paymentProofHandled) return;

    // Handle QRIS update photo
    const paymentPhotoHandled = await handlePaymentPhoto(bot, msg);
    if (paymentPhotoHandled) return;

    // Route to reseller handler for other photo uploads
    return resellerHandler.handlePhoto(bot, msg);
  });

  bot.onText(/^\/extendakses\b/, async (msg, match) => {
    if (await isMaintenanceBlocked(msg.from.id)) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return resellerHandler.handleCommand(bot, msg, 'extendakses');
  });

  bot.on('message', async (msg) => {
    if (await isMaintenanceBlocked(msg.from.id)) {
      if (msg.document || msg.photo || msg.video || msg.audio || msg.voice || msg.sticker) {
        return;
      }
      if (msg.chat.type === 'private' && (!msg.text || !msg.text.startsWith('/'))) {
        return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
      }
      return;
    }

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const state = session.get(userId);
    if (!state) return;
    
    // Handle URL to APK text input
    if (state.type === 'url_to_apk' && typeof msg.text === 'string' && !msg.text.startsWith('/')) {
      const textInput = msg.text.trim();
      
      // Step 2: Waiting for app name
      if (state.step === 2) {
        // Validate app name
        if (textInput.length < 2 || textInput.length > 30) {
          return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Nama aplikasi harus 2-30 karakter.', {
            reply_markup: {
              inline_keyboard: [[{ text: 'Batal', callback_data: 'cancel_build', icon_custom_emoji_id: "5210952531676504517" }]]
            }
          });
        }
        
        // Reject if it looks like URL
        if (textInput.match(/^https?:\/\//i)) {
          return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Mohon masukkan nama aplikasi, bukan URL.\n\nContoh: My App', {
            reply_markup: {
              inline_keyboard: [[{ text: 'Batal', callback_data: 'cancel_build', icon_custom_emoji_id: "5210952531676504517" }]]
            }
          });
        }
        
        // Save app name and proceed to icon step
        state.appName = textInput;
        state.step = 3;
        session.set(userId, state);
        
        return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5429200581858182504">🖼</tg-emoji>️ <b>Buat APK Baru</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 3/3: Icon Aplikasi</b>

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${state.url}</code>
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Nama: <b>${state.appName}</b>

Kirim foto untuk icon aplikasi (rasio 1:1 disarankan).

Atau klik "<tg-emoji emoji-id="5348125953090403204">⏭</tg-emoji>️ Lewati" untuk menggunakan icon default.
        `.trim(), {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Lewati (Gunakan Default)', callback_data: 'skip_icon', icon_custom_emoji_id: "5348125953090403204" }],
              [{ text: 'Batal', callback_data: 'cancel_build', icon_custom_emoji_id: "5210952531676504517" }]
            ]
          }
        });
      }
    }
    
    if (state.type === 'reseller_access' && typeof msg.text === 'string') {
      return resellerHandler.handleText(bot, msg);
    }
    if (state.type === 'addvps' || state.type === 'addghaction') {
      if (!msg.text?.startsWith('/')) return adminHandler(bot, msg, true);
    }
  });

  bot.onText(/\/(addvps|listvps|delvps|installvps|cekvps|addghaction|listghaction|delghaction|cekghaction|workers|maintenance|stat|setstat|addstat|resetstat|setavg|delakses|listakses|broadcast|addreseller|delreseller|listreseller)/, (msg) => {
    if (isAdminUser(msg.from.id)) return adminHandler(bot, msg);
    if (maintenance.isEnabled()) {
      return bot.sendMessage(msg.chat.id, getMaintenanceMessage(), { parse_mode: 'HTML', reply_markup: getMaintenanceKeyboard() });
    }
    return bot.sendMessage(msg.chat.id, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Maaf, perintah ini hanya untuk admin.', { parse_mode: 'HTML' });
  });

  backup.start(logger, bot);
  healthMonitor.start(bot);

  // ═══ FIX #3: Periodic queue processor ═══
  // Ensures the queue drains even if completeJob's timer was lost on restart
  const poolInstance = require('../worker/pool');
  setInterval(async () => {
    try {
      const queue = await db.getQueue();
      if (queue.length > 0) {
        logger.info(`[QueueProcessor] ${queue.length} job(s) in queue, attempting assignment...`);
        await poolInstance.processNextInQueue();
      }
    } catch (err) {
      logger.warn(`[QueueProcessor] Error: ${err.message}`);
    }
  }, 60000); // Check every 60 seconds

  return bot;
}

main().catch((error) => {
  logger.error(error?.stack || String(error));
  process.exitCode = 1;
});

