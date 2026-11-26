/**
 * /addakses Command Handler
 * Interactive wizard for creating access keys
 * Features: Button-based access type selection, reseller approval flow
 */

const accessKeyService = require('../utils/accessKeyService');

// Escape HTML for Telegram messages
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Generate approval ID
function createApprovalId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Check if user is admin (static owner dari config.js ATAU owner dinamis dari /addowner)
function isAdmin(userId) {
  try {
    const ownerService = require('../utils/ownerService');
    return ownerService.isAdmin(userId);
  } catch (e) {
    return false;
  }
}

// Check if user is reseller
async function isReseller(userId) {
  try {
    const db = require('../db');
    return db && typeof db.isReseller === 'function' && await db.isReseller(userId);
  } catch (e) {
    return false;
  }
}

// Get owner ID
function getOwnerId() {
  try {
    const config = require('../../config');
    const adminIds = config?.telegram?.adminIds || config?.adminIds;
    if (!Array.isArray(adminIds) || adminIds.length === 0) return null;
    return adminIds[0];
  } catch (e) {
    return null;
  }
}

// Send processing message
async function sendProcessing(bot, chatId, messageId) {
  return bot.sendMessage(chatId, '<blockquote>memproses...</blockquote>', {
    parse_mode: 'HTML',
    reply_to_message_id: messageId
  });
}

// Main command handler - Simple format: /addakses <userId> <hari>
async function handleAddAkses(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text?.trim() || '';

  // Check permission (Admin or Reseller)
  const isAdminUser = isAdmin(userId);
  const isResellerUser = await isReseller(userId);
  if (!isAdminUser && !isResellerUser) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5260293700088511294">⛔</tg-emoji> Anda tidak memiliki akses untuk perintah ini.', { parse_mode: 'HTML' });
  }

  // Parse command: /addakses <userId> <hari>
  const parts = text.split(/\s+/);
  if (parts.length < 3) {
    return bot.sendMessage(chatId, 
      '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> <b>Format salah.</b>\n\n<code>/addakses &lt;userId&gt; &lt;hari&gt;</code>', 
      { parse_mode: 'HTML' }
    );
  }

  const telegramId = parts[1];
  const days = parseInt(parts[2], 10);

  // Validate
  if (!/^\d+$/.test(telegramId)) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ <b>Telegram ID harus berupa angka!</b>', { parse_mode: 'HTML' });
  }

  if (isNaN(days) || days < 1) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ <b>Durasi minimal 1 hari!</b>', { parse_mode: 'HTML' });
  }

  const isResellerFlow = isResellerUser && !isAdminUser;

  // Store session for callback handling
  const sessions = require('../session/state');
  sessions.set(userId, {
    addakses_pending: true,
    telegramId,
    days,
    isResellerFlow,
    createdAt: Date.now()
  });

  // Show access type buttons
  return bot.sendMessage(chatId, `
<b><tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> Pilih Tipe Akses</b>

<tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> Telegram ID: <code>${telegramId}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Durasi: ${days} hari

Silakan pilih tipe akses:
  `.trim(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Web Only', icon_custom_emoji_id: "5447410659077661506", callback_data: 'addakses_type_web' },
          { text: 'Bot Only', icon_custom_emoji_id: "5355051922862653659", callback_data: 'addakses_type_bot' }
        ],
        [
          { text: 'All Access', icon_custom_emoji_id: "5321131452274847846", callback_data: 'addakses_type_all' }
        ],
        [
          { text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'addakses_cancel' }
        ]
      ]
    }
  });
}

// Handle text input - Not needed for simplified flow
async function handleAddAksesInput(bot, msg) {
  // Simplified flow doesn't use text input after command
  // Everything is handled via buttons
  return false;
}

// Handle callback queries (access type selection)
async function handleAddAksesCallback(bot, query) {
  const data = query.data;
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  // Handle cancel
  if (data === 'addakses_cancel') {
    const sessions = require('../session/state');
    sessions.clear(userId);
    await bot.editMessageText('<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Proses dibatalkan.', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML'
    });
    return bot.answerCallbackQuery(query.id, { text: 'Dibatalkan' });
  }

  // Access type selection (new format: addakses_type_xxx)
  if (data.startsWith('addakses_type_')) {
    const sessions = require('../session/state');
    const session = sessions.get(userId);

    if (!session || !session.addakses_pending) {
      return bot.answerCallbackQuery(query.id, { text: 'Sesi tidak valid', show_alert: true });
    }

    const accessType = data.replace('addakses_type_', '');
    session.accessType = accessType;

    const isResellerFlow = session.isResellerFlow;

    if (isResellerFlow) {
      // Reseller flow: need payment proof
      session.step = 'addakses_proof';
      sessions.set(userId, session);

      await bot.editMessageText(`
<b><tg-emoji emoji-id="5445355530111437729">📤</tg-emoji> Upload Bukti Transaksi</b>

Silakan kirim <b>foto bukti pembayaran</b>.
Request akan dikirim ke Owner untuk approval.

<i>Ketik /cancel untuk membatalkan.</i>
      `.trim(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });

      return bot.answerCallbackQuery(query.id, { text: 'Silakan upload bukti transaksi' });
    } else {
      // Admin flow: create directly
      sessions.clear(userId);

      const processingMsg = await sendProcessing(bot, chatId, query.message.message_id);
      await new Promise(r => setTimeout(r, 1500));

      const result = accessKeyService.createKey({
        telegramId: session.telegramId,
        username: session.username,
        days: session.days,
        accessType: session.accessType,
        createdBy: userId
      });

      await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

      if (!result.success) {
        return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Error: ${result.error}`, { parse_mode: 'HTML' });
      }

      // Send to requester - Professional Gen 4 Style
      await bot.sendMessage(session.telegramId, `
<blockquote><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> 「 𝗔𝗞𝗦𝗘𝗦 𝗗𝗜𝗕𝗘𝗥𝗜𝗞𝗔𝗡 」<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>𝗔𝗖𝗖𝗘𝗦𝗦 𝗞𝗘𝗬 :</b> <code>${result.key}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <b>𝗗𝗨𝗥𝗔𝗦𝗜 :</b> ${result.days} 𝗛𝗮𝗿𝗶
<tg-emoji emoji-id="5445355530111437729">📅</tg-emoji> <b>𝗘𝗫𝗣𝗜𝗥𝗘𝗗 :</b> ${result.expiresAt.split('T')[0]}
<tg-emoji emoji-id="5296369303661067030">🔓</tg-emoji> <b>𝗧𝗜𝗣𝗘 𝗔𝗞𝗦𝗘𝗦 :</b> ${result.accessType.toUpperCase()}</blockquote>

<blockquote><tg-emoji emoji-id="5422439311196834318">💡</tg-emoji> <i>𝗦𝗶𝗺𝗽𝗮𝗻 𝗸𝗲𝘆 𝗶𝗻𝗶 𝗱𝗲𝗻𝗴𝗮𝗻 𝗮𝗺𝗮𝗻. 𝗝𝗮𝗻𝗴𝗮𝗻 𝗯𝗮𝗴𝗶𝗸𝗮𝗻 𝗸𝗲𝗽𝗮𝗱𝗮 𝗼𝗿𝗮𝗻𝗴 𝗹𝗮𝗶𝗻.</i></blockquote>
      `.trim(), { parse_mode: 'HTML' }).catch(() => {});

      // Confirm to creator - Professional Gen 4 Style
      return bot.sendMessage(chatId, `
<blockquote><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> 「 𝗔𝗞𝗦𝗘𝗦 𝗕𝗘𝗥𝗛𝗔𝗦𝗜𝗟 𝗗𝗜𝗕𝗨𝗔𝗧 」<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>𝗧𝗘𝗟𝗘𝗚𝗥𝗔𝗠 𝗜𝗗 :</b> <code>${session.telegramId}</code>
<tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>𝗔𝗖𝗖𝗘𝗦𝗦 𝗞𝗘𝗬 :</b> <code>${result.key}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <b>𝗗𝗨𝗥𝗔𝗦𝗜 :</b> ${result.days} 𝗛𝗮𝗿𝗶
<tg-emoji emoji-id="5296369303661067030">🔓</tg-emoji> <b>𝗧𝗜𝗣𝗘 𝗔𝗞𝗦𝗘𝗦 :</b> ${result.accessType.toUpperCase()}</blockquote>

<blockquote><tg-emoji emoji-id="5253742260054409879">📨</tg-emoji> <b>𝗦𝘁𝗮𝘁𝘂𝘀 :</b> 𝗞𝗲𝘆 𝘁𝗲𝗹𝗮𝗵 𝗱𝗶𝗸𝗶𝗿𝗶𝗺 𝗸𝗲 𝘂𝘀𝗲𝗿.</blockquote>
      `.trim(), { parse_mode: 'HTML' }).catch(() => {});
    }
  }

  // Approval callbacks (owner only)
  if (data.startsWith('addakses_approve:') || data.startsWith('addakses_reject:')) {
    const ownerId = getOwnerId();
    if (String(userId) !== String(ownerId)) {
      return bot.answerCallbackQuery(query.id, { text: 'Hanya owner', show_alert: true });
    }

    const approvalId = data.split(':')[1];
    const action = data.startsWith('addakses_approve') ? 'approve' : 'reject';

    // Get pending approvals from global
    const pendingApprovals = global.pendingAddAksesApprovals || new Map();
    const pending = pendingApprovals.get(approvalId);

    if (!pending) {
      return bot.answerCallbackQuery(query.id, { text: 'Request tidak ditemukan', show_alert: true });
    }

    if (action === 'reject') {
      pendingApprovals.delete(approvalId);
      global.pendingAddAksesApprovals = pendingApprovals;

      // Notify reseller - Professional
      await bot.sendMessage(pending.resellerId, `
<blockquote><tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> 「 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗗𝗜𝗧𝗢𝗟𝗔𝗞 」<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>𝗧𝗘𝗟𝗘𝗚𝗥𝗔𝗠 𝗜𝗗 :</b> <code>${pending.telegramId}</code>
<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji> <b>𝗦𝗧𝗔𝗧𝗨𝗦 :</b> 𝗗𝗶𝘁𝗼𝗹𝗮𝗸 𝗢𝘄𝗻𝗲𝗿</blockquote>

<blockquote><i>𝗦𝗶𝗹𝗮𝗸𝗮𝗻 𝗵𝘂𝗯𝘂𝗻𝗴𝗶 𝗼𝘄𝗻𝗲𝗿 𝘂𝗻𝘁𝘂𝗸 𝗸𝗲𝘁𝗲𝗿𝗮𝗻𝗴𝗮𝗻 𝗹𝗲𝗯𝗶𝗵 𝗹𝗮𝗻𝗷𝘂𝘁.</i></blockquote>
      `.trim(), { parse_mode: 'HTML' }).catch(() => {});

      // Update owner message - Professional
      await bot.editMessageCaption(`
<blockquote><tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> 「 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗗𝗜𝗧𝗢𝗟𝗔𝗞 」<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>𝗥𝗘𝗦𝗘𝗟𝗟𝗘𝗥 :</b> ${escapeHtml(pending.resellerName)}
<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> <b>𝗧𝗘𝗟𝗘𝗚𝗥𝗔𝗠 𝗜𝗗 :</b> <code>${pending.telegramId}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <b>𝗗𝗨𝗥𝗔𝗦𝗜 :</b> ${pending.days} 𝗛𝗮𝗿𝗶
<tg-emoji emoji-id="5296369303661067030">🔓</tg-emoji> <b>𝗧𝗜𝗣𝗘 𝗔𝗞𝗦𝗘𝗦 :</b> ${pending.accessType.toUpperCase()}</blockquote>
      `.trim(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'HTML'
      });

      return bot.answerCallbackQuery(query.id, { text: 'Request ditolak' });
    }

    // Approve: create the key
    const processingMsg = await bot.sendMessage(chatId, '<blockquote>memproses approval...</blockquote>', {
      parse_mode: 'HTML'
    });

    const result = accessKeyService.createKey({
      telegramId: pending.telegramId,
      username: pending.username,
      days: pending.days,
      accessType: pending.accessType,
      createdBy: pending.resellerId
    });

    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    pendingApprovals.delete(approvalId);
    global.pendingAddAksesApprovals = pendingApprovals;

    if (!result.success) {
      return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Error: ${result.error}`, { parse_mode: 'HTML' });
    }

    // Send to target user - Professional
    await bot.sendMessage(pending.telegramId, `
<blockquote><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> 「 𝗔𝗞𝗦𝗘𝗦 𝗔𝗣𝗣𝗥𝗢𝗩𝗘𝗗 」<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>𝗔𝗖𝗖𝗘𝗦𝗦 𝗞𝗘𝗬 :</b> <code>${result.key}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <b>𝗗𝗨𝗥𝗔𝗦𝗜 :</b> ${result.days} 𝗛𝗮𝗿𝗶
<tg-emoji emoji-id="5445355530111437729">📅</tg-emoji> <b>𝗘𝗫𝗣𝗜𝗥𝗘𝗗 :</b> ${result.expiresAt.split('T')[0]}
<tg-emoji emoji-id="5296369303661067030">🔓</tg-emoji> <b>𝗧𝗜𝗣𝗘 𝗔𝗞𝗦𝗘𝗦 :</b> ${result.accessType.toUpperCase()}</blockquote>

<blockquote><tg-emoji emoji-id="5422439311196834318">💡</tg-emoji> <i>𝗦𝗶𝗺𝗽𝗮𝗻 𝗸𝗲𝘆 𝗶𝗻𝗶 𝗱𝗲𝗻𝗴𝗮𝗻 𝗮𝗺𝗮𝗻. 𝗚𝘂𝗻𝗮𝗸𝗮𝗻 𝘂𝗻𝘁𝘂𝗸 𝗹𝗼𝗴𝗶𝗻 𝗱𝗶 𝗱𝗮𝘀𝗵𝗯𝗼𝗮𝗿𝗱.</i></blockquote>
    `.trim(), { parse_mode: 'HTML' }).catch(() => {});

    // Notify reseller - Professional
    await bot.sendMessage(pending.resellerId, `
<blockquote><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> 「 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗔𝗣𝗣𝗥𝗢𝗩𝗘𝗗 」<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>𝗧𝗘𝗟𝗘𝗚𝗥𝗔𝗠 𝗜𝗗 :</b> <code>${pending.telegramId}</code>
<tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>𝗔𝗖𝗖𝗘𝗦𝗦 𝗞𝗘𝗬 :</b> <code>${result.key}</code>
<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji> <b>𝗦𝗧𝗔𝗧𝗨𝗦 :</b> 𝗔𝗽𝗽𝗿𝗼𝘃𝗲𝗱 𝗢𝘄𝗻𝗲𝗿</blockquote>
    `.trim(), { parse_mode: 'HTML' }).catch(() => {});

    // Update owner message - Professional
    await bot.editMessageCaption(`
<blockquote><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> 「 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗔𝗣𝗣𝗥𝗢𝗩𝗘𝗗 」<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji></blockquote>

<blockquote><tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> <b>𝗥𝗘𝗦𝗘𝗟𝗟𝗘𝗥 :</b> ${escapeHtml(pending.resellerName)}
<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> <b>𝗧𝗘𝗟𝗘𝗚𝗥𝗔𝗠 𝗜𝗗 :</b> <code>${pending.telegramId}</code>
<tg-emoji emoji-id="5278573677900752088">🔑</tg-emoji> <b>𝗔𝗖𝗖𝗘𝗦𝗦 𝗞𝗘𝗬 :</b> <code>${result.key}</code>
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <b>𝗗𝗨𝗥𝗔𝗦𝗜 :</b> ${result.days} 𝗛𝗮𝗿𝗶
<tg-emoji emoji-id="5296369303661067030">🔓</tg-emoji> <b>𝗧𝗜𝗣𝗘 𝗔𝗞𝗦𝗘𝗦 :</b> ${result.accessType.toUpperCase()}</blockquote>
    `.trim(), {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'HTML'
    });

    return bot.answerCallbackQuery(query.id, { text: 'Request approved & key created!' });
  }

  return false;
}

// Handle photo upload (payment proof from reseller)
async function handleAddAksesPhoto(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const sessions = require('../session/state');
  const session = sessions.get(userId);

  if (!session || !session.addakses_pending || session.step !== 'addakses_proof') {
    return false; // Not in proof step
  }

  if (!msg.photo || msg.photo.length === 0) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Kirim foto sebagai bukti transaksi!', { parse_mode: 'HTML' });
  }

  const photo = msg.photo[msg.photo.length - 1];
  const approvalId = createApprovalId();

  // Store pending approval
  if (!global.pendingAddAksesApprovals) {
    global.pendingAddAksesApprovals = new Map();
  }

  const pendingRequest = {
    approvalId,
    resellerId: userId,
    resellerName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
    telegramId: session.telegramId,
    username: session.username,
    days: session.days,
    accessType: session.accessType,
    proofPhoto: photo.file_id,
    createdAt: Date.now()
  };

  global.pendingAddAksesApprovals.set(approvalId, pendingRequest);
  sessions.clear(userId);

  // Send to owner for approval
  const ownerId = getOwnerId();
  if (ownerId) {
    await bot.sendPhoto(ownerId, photo.file_id, {
      caption: `
<b><tg-emoji emoji-id="5226702984204797593">🔄</tg-emoji> REQUEST ADD AKSES</b>

Reseller: ${escapeHtml(pendingRequest.resellerName)}
Reseller ID: <code>${userId}</code>
Target ID: <code>${session.telegramId}</code>
Durasi: ${session.days} hari
Akses: ${session.accessType.toUpperCase()}
Username: ${session.username || '-'}

Request ID: <code>${approvalId}</code>
      `.trim(),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', icon_custom_emoji_id: "5321131452274847846", callback_data: `addakses_approve:${approvalId}` },
            { text: 'Reject', icon_custom_emoji_id: "5210952531676504517", callback_data: `addakses_reject:${approvalId}` }
          ]
        ]
      }
    });
  }

  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Request Terkirim!</b>

Bukti transaksi telah dikirim ke Owner.
Menunggu approval...

Request ID: <code>${approvalId}</code>
  `.trim(), { parse_mode: 'HTML' });
}

module.exports = {
  handleAddAkses,
  handleAddAksesInput,
  handleAddAksesCallback,
  handleAddAksesPhoto
};
