const config = require('../../config');
const db = require('../db');
const session = require('../session/state');
const ownerService = require('../utils/ownerService');

function getOwnerId() {
  if (Array.isArray(config.telegram.adminIds) && config.telegram.adminIds.length > 0) return config.telegram.adminIds[0];
  return null;
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function createApprovalId() {
  return `apr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function parseDuration(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (raw === 'permanent' || raw === 'selamanya') return null;
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days < 1) return undefined;
  return days;
}

function buildOwnerCaption(req) {
  const durationLabel = req.days === null ? 'Permanent' : `${req.days} hari`;
  const actionLabel = req.action === 'addakses' ? 'ADD AKSES' : 'EXTEND AKSES';

  return `
<b>PERMINTAAN ${actionLabel} (RESELLER)</b>
Status: <b>MENUNGGU APPROVAL</b>

Reseller: <b>${escapeHtml(req.requesterName)}</b>
ID Reseller: <code>${req.requesterUserId}</code>
Username TG: <code>${escapeHtml(req.requesterUsername)}</code>

Target User ID: <code>${req.targetUserId}</code>
Durasi: <b>${durationLabel}</b>
Request ID: <code>${req.id}</code>

Klik tombol untuk approve atau tolak request.
  `.trim();
}

async function handleCommand(bot, msg, commandName) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // /addakses is now handled by addAksesHandler.js (more professional)
  if (commandName === 'addakses') {
    return; // Let addAksesHandler.js handle this
  }

  const isAdmin = ownerService.isAdmin(userId);
  const isReseller = await db.isReseller(userId);

  if (!isAdmin && !isReseller) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Maaf, perintah ini tidak tersedia untuk akun kamu.', { parse_mode: 'HTML' });
  }

  if (isAdmin) {
    const parts = String(msg.text || '').trim().split(/\s+/);
    if (parts.length < 3) {
      return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Format salah. Gunakan: /${commandName} &lt;userId&gt; &lt;hari|permanent&gt;`, { parse_mode: 'HTML' });
    }
    const targetUserId = parseInt(parts[1], 10);
    const days = parseDuration(parts[2]);
    if (!Number.isFinite(targetUserId)) return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> userId harus angka.', { parse_mode: 'HTML' });
    if (days === undefined) return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Durasi tidak valid. Gunakan angka hari atau "permanent".', { parse_mode: 'HTML' });

    await db.extendMember(targetUserId, 'user', days, userId);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> ${commandName} berhasil untuk user ${targetUserId}.`, { parse_mode: 'HTML' });
  }

  session.set(userId, {
    type: 'reseller_access',
    step: 1,
    action: commandName,
    requesterUserId: userId,
    requesterName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Reseller',
    requesterUsername: msg.from?.username ? `@${msg.from.username}` : '-'
  });

  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5444856076954520455">🧾</tg-emoji> <b>Permintaan ${commandName}</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 1/3:</b> Masukkan <b>Telegram User ID</b> target.
Contoh: <code>123456789</code>

<i>Ketik /cancel untuk batal.</i>
  `.trim(), { parse_mode: 'HTML' });
}

async function handleText(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  const state = session.get(userId);
  if (!state || state.type !== 'reseller_access') return;

  if (text === '/cancel') {
    session.clear(userId);
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Dibatalkan.', { parse_mode: 'HTML' });
  }

  if (state.step === 1) {
    const targetUserId = parseInt(text, 10);
    if (!Number.isFinite(targetUserId)) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ User ID harus berupa angka.', { parse_mode: 'HTML' });
    state.targetUserId = targetUserId;
    state.step = 2;
    session.set(userId, state);
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Target User ID: <code>${targetUserId}</code>

<b>Langkah 2/3:</b> Masukkan durasi (hari) atau <code>permanent</code>.
Contoh: <code>30</code> atau <code>permanent</code>
    `.trim(), { parse_mode: 'HTML' });
  }

  if (state.step === 2) {
    const days = parseDuration(text);
    if (days === undefined) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Durasi tidak valid. Gunakan angka hari atau "permanent".', { parse_mode: 'HTML' });
    state.days = days;
    state.step = 3;
    session.set(userId, state);
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Durasi: <b>${days === null ? 'Permanent' : `${days} hari`}</b>

<b>Langkah 3/3:</b> Kirim <b>foto bukti transaksi</b> untuk approval owner.

<i>Ketik /cancel untuk batal.</i>
    `.trim(), { parse_mode: 'HTML' });
  }
}

async function handlePhoto(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const state = session.get(userId);
  if (!state || state.type !== 'reseller_access' || state.step !== 3) return;

  if (!Array.isArray(msg.photo) || msg.photo.length === 0) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Silakan kirim foto bukti transaksi.', { parse_mode: 'HTML' });
  }

  const ownerId = getOwnerId();
  if (!ownerId) {
    session.clear(userId);
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Owner belum dikonfigurasi.', { parse_mode: 'HTML' });
  }

  const proofPhoto = msg.photo[msg.photo.length - 1];
  const approvalId = createApprovalId();
  const approval = {
    id: approvalId,
    status: 'pending',
    action: state.action,
    requesterUserId: state.requesterUserId,
    requesterName: state.requesterName,
    requesterUsername: state.requesterUsername,
    targetUserId: state.targetUserId,
    days: state.days,
    proofFileId: proofPhoto.file_id,
    requestedAt: new Date().toISOString()
  };

  try {
    const ownerMessage = await bot.sendPhoto(ownerId, proofPhoto.file_id, {
      caption: buildOwnerCaption(approval),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', icon_custom_emoji_id: "5321131452274847846", callback_data: `resellerreq:approve:${approvalId}` },
          { text: 'Tolak', icon_custom_emoji_id: "5210952531676504517", callback_data: `resellerreq:reject:${approvalId}` }
        ]]
      }
    });

    approval.ownerChatId = ownerId;
    approval.ownerMessageId = ownerMessage.message_id;
    await db.addApproval(approval);
    session.clear(userId);

    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Foto bukti transaksi diterima.
Request sudah dikirim ke owner dan sedang menunggu approval.

Request ID: <code>${approvalId}</code>
    `.trim(), { parse_mode: 'HTML' });
  } catch (error) {
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Gagal mengirim request ke owner.\nError: <code>${escapeHtml(error.message)}</code>`, { parse_mode: 'HTML' });
  }
}

async function handleApprovalCallback(bot, query) {
  const data = String(query.data || '');
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const actorId = query.from.id;

  const isAdmin = ownerService.isAdmin(actorId);
  if (!isAdmin) {
    return bot.answerCallbackQuery(query.id, { text: 'Hanya admin yang bisa melakukan approval.', show_alert: true });
  }

  const parts = data.split(':');
  const action = parts[1];
  const approvalId = parts[2];
  if (!approvalId) return bot.answerCallbackQuery(query.id);

  const approval = await db.getApprovalById(approvalId);
  if (!approval || approval.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { text: 'Request sudah diproses atau tidak ditemukan.', show_alert: true });
  }

  if (action === 'approve') {
    await db.extendMember(approval.targetUserId, 'user', approval.days, actorId);
    await db.updateApproval(approvalId, { status: 'approved', decidedAt: new Date().toISOString(), decidedBy: actorId });

    const durationLabel = approval.days === null ? 'Permanent' : `${approval.days} hari`;
    const caption = `
<b>PERMINTAAN ${approval.action.toUpperCase()} (RESELLER)</b>
Status: <b><tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> APPROVED</b>

Target User ID: <code>${approval.targetUserId}</code>
Durasi: <b>${durationLabel}</b>
Request ID: <code>${approvalId}</code>
    `.trim();

    await bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    await bot.sendMessage(approval.requesterUserId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Request kamu <code>${approvalId}</code> telah disetujui.`, { parse_mode: 'HTML' }).catch(() => {});
    await bot.sendMessage(approval.targetUserId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Akses kamu telah diperbarui. Durasi: ${durationLabel}`, { parse_mode: 'HTML' }).catch(() => {});
    return bot.answerCallbackQuery(query.id, { text: 'Approved.' });
  }

  if (action === 'reject') {
    await db.updateApproval(approvalId, { status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: actorId });

    const caption = `
<b>PERMINTAAN ${approval.action.toUpperCase()} (RESELLER)</b>
Status: <b><tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> DITOLAK</b>

Target User ID: <code>${approval.targetUserId}</code>
Request ID: <code>${approvalId}</code>
    `.trim();

    await bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }).catch(() => {});
    await bot.sendMessage(approval.requesterUserId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Request kamu <code>${approvalId}</code> ditolak oleh owner.`, { parse_mode: 'HTML' }).catch(() => {});
    return bot.answerCallbackQuery(query.id, { text: 'Ditolak.' });
  }

  return bot.answerCallbackQuery(query.id);
}

module.exports = { handleCommand, handleText, handlePhoto, handleApprovalCallback };
