/**
 * reportHandler.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fitur "Laporan / Hubungi Owner" — 100% lewat command, TANPA tombol konfirmasi.
 *
 * Alur:
 *   1. User ketik /lapor <alasan bebas>, contoh:
 *        /lapor min ini kenapa ya tolong dong diperbaiki
 *      -> Langsung terkirim ke owner. Tidak ada tombol "Kirim Laporan" untuk
 *         ditekan lagi — begitu command terkirim, laporan otomatis terkirim.
 *
 *   2. Bisa juga dipakai sebagai REPLY ke pesan yang berisi foto/screenshot
 *      atau file error (misal error log .txt hasil build gagal). Ketik
 *      /lapor <alasan> pada reply tsb, dan foto/file itu diteruskan ke
 *      owner sebagai SATU pesan utuh (foto/dokumen + caption berisi semua
 *      info laporan menyatu di bawahnya) — bukan dua pesan terpisah.
 *
 * Setiap laporan yang masuk ke owner selalu menyertakan: ID laporan, nama
 * lengkap + username (kalau ada) + user ID pelapor, waktu, dan alasan.
 *
 * Semua laporan disimpan ke database/reports.json (status: pending) dan
 * owner (statis + dinamis lewat /addowner) mendapat notifikasi dengan
 * tombol [❌ Batalkan Laporan].
 */

const db = require('../db');
const ownerService = require('../utils/ownerService');

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatWaktu(isoString) {
  try {
    return new Date(isoString).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' WIB';
  } catch (e) {
    return isoString;
  }
}

function createReportId() {
  return `RPT-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

// Tampilan menu "Laporan / Bantuan" — sekarang murni informasional (cara
// pakai /lapor), TIDAK ADA tombol "Kirim Laporan" lagi. Mengirim laporan
// generik tanpa alasan sudah tidak didukung by design: /lapor selalu butuh
// alasan bebas, supaya owner selalu tahu konteks masalahnya dari awal.
async function showReportConfirm(bot, chatId, messageId) {
  const text = `
<tg-emoji emoji-id="5447644880824181073">🆘</tg-emoji> <b>Laporan / Bantuan</b>
━━━━━━━━━━━━━━━━━━

Butuh bantuan atau nemu error? Kirim langsung ke owner pakai command:

<code>/lapor [alasan bebas]</code>

<b>Contoh:</b>
<code>/lapor min ini kenapa ya tolong dong diperbaiki</code>

<b>Ada screenshot/file error?</b>
Reply pesan yang berisi foto atau file error tersebut, lalu ketik <code>/lapor [alasan]</code> pada reply itu. Foto/file-nya otomatis ikut terkirim ke owner beserta laporanmu — tidak perlu tekan tombol apa pun, begitu pesan terkirim laporan langsung diteruskan.

Owner akan melihat nama, username, ID, waktu, dan alasan laporanmu, lalu segera menghubungimu langsung.
  `.trim();

  const keyboard = {
    inline_keyboard: [
      [{ text: 'Kembali ke Menu', callback_data: 'main_menu', icon_custom_emoji_id: '5197269100878907942' }],
    ],
  };

  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: keyboard }).catch(() =>
      bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard })
    );
  }
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// Owner menekan "Batalkan Laporan" pada notifikasi yang ia terima
async function ownerCancelReport(bot, query, reportId) {
  const userId = query.from.id;
  if (!ownerService.isAdmin(userId)) {
    return bot.answerCallbackQuery(query.id, { text: 'Hanya owner yang bisa membatalkan laporan.', show_alert: true }).catch(() => {});
  }

  const report = await db.getReportById(reportId);
  if (!report) {
    return bot.answerCallbackQuery(query.id, { text: 'Laporan tidak ditemukan (mungkin sudah dihapus).', show_alert: true }).catch(() => {});
  }

  if (report.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { text: `Laporan ini sudah berstatus "${report.status}".`, show_alert: true }).catch(() => {});
  }

  await db.updateReport(reportId, { status: 'cancelled', cancelledBy: userId, cancelledAt: new Date().toISOString() });

  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const displayName = escapeHtml(`${report.firstName} ${report.lastName}`.trim() || 'User');

  const cancelledCaption = `
<tg-emoji emoji-id="5447644880824181073">📩</tg-emoji> <b>Laporan Dibatalkan</b>
━━━━━━━━━━━━━━━━━━

ID Laporan: <code>${report.id}</code>
Dari: ${displayName}
User ID: <code>${report.userId}</code>
Waktu Lapor: ${formatWaktu(report.createdAt)}
Status: <b>Dibatalkan</b>
  `.trim();

  // The original owner notification may have been a plain text message
  // (no attachment) or a photo/document with the report details as its
  // caption — pick the matching edit method so the button removal and
  // status update always land correctly either way.
  const hasMedia = Array.isArray(query.message.photo) && query.message.photo.length > 0;
  const hasDocument = !!query.message.document;
  try {
    if (hasMedia || hasDocument) {
      await bot.editMessageCaption(cancelledCaption, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    } else {
      await bot.editMessageText(cancelledCaption, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
    }
  } catch (_) {}

  await bot.answerCallbackQuery(query.id, { text: 'Laporan dibatalkan.' }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────
// Command /lapor <alasan bebas> — dengan dukungan reply ke foto/dokumen.
// ─────────────────────────────────────────────────────────────────────────

// Ambil alasan dari teks setelah "/lapor". Wajib ada spasi + isi, contoh:
//   "/lapor min ini kenapa ya tolong dong diperbaiki"  -> alasan diambil
//   "/lapor" (tanpa spasi/alasan)                       -> null (invalid)
function extractReasonFromCommand(text) {
  const raw = String(text || '');
  // Cocokkan "/lapor" atau "/lapor@BotUsername", lalu WAJIB ada spasi + isi.
  const match = raw.match(/^\/lapor(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  const reason = match[1].trim();
  return reason.length > 0 ? reason : null;
}

// Deteksi lampiran (foto/dokumen) dari pesan yang di-reply oleh user saat
// mengetik /lapor. Mendukung foto langsung maupun dokumen (misal file .txt
// error log yang dikirim Web2Apk saat build gagal, seperti pada contoh).
function extractAttachmentFromRepliedMessage(repliedMsg) {
  if (!repliedMsg) return null;

  if (Array.isArray(repliedMsg.photo) && repliedMsg.photo.length > 0) {
    const largest = repliedMsg.photo[repliedMsg.photo.length - 1];
    return { type: 'photo', fileId: largest.file_id, caption: repliedMsg.caption || null };
  }

  if (repliedMsg.document) {
    return {
      type: 'document',
      fileId: repliedMsg.document.file_id,
      fileName: repliedMsg.document.file_name || null,
      caption: repliedMsg.caption || null,
    };
  }

  // Pesan teks biasa yang di-reply (misal user tempel error text langsung,
  // bukan sebagai file) -> ikutkan isinya sebagai konteks tambahan.
  if (typeof repliedMsg.text === 'string' && repliedMsg.text.trim()) {
    return { type: 'text', text: repliedMsg.text.trim() };
  }

  return null;
}

// Telegram caption limit is 1024 chars; keep well under it since we also
// append the (potentially long) user reason and, for text-attachments, a
// quoted snippet of the replied message.
function truncateForCaption(text, maxLen) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

// Command handler: /lapor <alasan>
// Dipanggil dari index.js lewat bot.onText(/^\/lapor(?:@\w+)?/, ...)
// Selalu langsung terkirim begitu command dikirim — tidak ada tombol
// konfirmasi apa pun di sisi user.
async function handleLaporCommand(bot, msg) {
  const chatId = msg.chat.id;
  const user = msg.from;

  const reason = extractReasonFromCommand(msg.text);
  if (!reason) {
    const usageText = `
<tg-emoji emoji-id="5447644880824181073">🆘</tg-emoji> <b>Cara Melapor</b>
━━━━━━━━━━━━━━━━━━

Format: <code>/lapor [alasan bebas]</code>
Contoh: <code>/lapor min ini kenapa ya tolong dong diperbaiki</code>

<b>Tips:</b> Kalau ada error/screenshot, reply pesan yang berisi foto atau file error tsb, lalu ketik <code>/lapor [alasan]</code> di reply itu. Foto/file-nya otomatis ikut diteruskan ke owner dalam satu pesan.
    `.trim();
    return bot.sendMessage(chatId, usageText, { parse_mode: 'HTML' }).catch(() => {});
  }

  const attachment = extractAttachmentFromRepliedMessage(msg.reply_to_message);

  const report = {
    id: createReportId(),
    userId: user.id,
    username: user.username || null,
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    chatId,
    reason,
    hasAttachment: !!attachment,
    attachmentType: attachment ? attachment.type : null,
    status: 'pending', // pending | cancelled | resolved
    createdAt: new Date().toISOString(),
  };
  await db.addReport(report);

  const displayName = escapeHtml(`${report.firstName} ${report.lastName}`.trim() || 'User');
  const usernameText = report.username ? `@${escapeHtml(report.username)}` : '-';

  // One combined block of report details, reused as either a standalone
  // message OR as the caption directly under a photo/document — this is
  // what makes the attachment and its info appear as a single unified
  // message to the owner instead of two separate ones.
  const reportDetailsHtml = (extraLabel) => `
<tg-emoji emoji-id="5447644880824181073">📩</tg-emoji> <b>Laporan Masuk (/lapor)</b>
━━━━━━━━━━━━━━━━━━

ID Laporan: <code>${report.id}</code>
Dari: ${displayName} (${usernameText})
User ID: <code>${report.userId}</code>
Waktu: ${formatWaktu(report.createdAt)}
Status: <b>Menunggu</b>
${extraLabel ? `\n${extraLabel}` : ''}
<b>Alasan:</b>
${escapeHtml(reason)}

Silakan hubungi user tersebut langsung via Telegram: <a href="tg://user?id=${report.userId}">${displayName}</a>.
  `.trim();

  const ownerKeyboard = {
    inline_keyboard: [
      [{ text: 'Batalkan Laporan', callback_data: `report_owner_cancel_${report.id}`, icon_custom_emoji_id: '5210952531676504517' }],
    ],
  };

  const owners = ownerService.getAllAdminIds();

  for (const ownerId of owners) {
    if (attachment && attachment.type === 'photo') {
      // Photo + full report details as ONE message: the caption sits
      // directly under the photo, nothing sent separately.
      const caption = truncateForCaption(reportDetailsHtml(attachment.caption ? `<i>Caption asli: ${escapeHtml(attachment.caption)}</i>\n` : null), 1024);
      await bot.sendPhoto(ownerId, attachment.fileId, {
        caption,
        parse_mode: 'HTML',
        reply_markup: ownerKeyboard,
      }).catch(async () => {
        // Fallback: if the combined caption ever exceeds Telegram's 1024
        // char cap in some edge case, still guarantee the owner gets the
        // full report (as text) rather than silently losing it.
        await bot.sendPhoto(ownerId, attachment.fileId, { reply_markup: ownerKeyboard }).catch(() => {});
        await bot.sendMessage(ownerId, reportDetailsHtml(), { parse_mode: 'HTML' }).catch(() => {});
      });
    } else if (attachment && attachment.type === 'document') {
      const captionExtra = [
        attachment.fileName ? `<i>File: ${escapeHtml(attachment.fileName)}</i>` : null,
        attachment.caption ? `<i>Caption asli: ${escapeHtml(attachment.caption)}</i>` : null,
      ].filter(Boolean).join('\n');
      const caption = truncateForCaption(reportDetailsHtml(captionExtra ? `${captionExtra}\n` : null), 1024);
      await bot.sendDocument(ownerId, attachment.fileId, {
        caption,
        parse_mode: 'HTML',
        reply_markup: ownerKeyboard,
      }).catch(async () => {
        await bot.sendDocument(ownerId, attachment.fileId, { reply_markup: ownerKeyboard }).catch(() => {});
        await bot.sendMessage(ownerId, reportDetailsHtml(), { parse_mode: 'HTML' }).catch(() => {});
      });
    } else if (attachment && attachment.type === 'text') {
      // No native "attachment" to send here (it was plain text, not a
      // file/photo) — fold the quoted snippet directly into the same
      // message as the report details so it's still one unified message.
      const quoted = attachment.text.length > 600 ? `${attachment.text.slice(0, 600)}…` : attachment.text;
      const extraLabel = `<b>Pesan yang di-reply:</b>\n<code>${escapeHtml(quoted)}</code>\n`;
      await bot.sendMessage(ownerId, reportDetailsHtml(extraLabel), { parse_mode: 'HTML', reply_markup: ownerKeyboard }).catch(() => {});
    } else {
      // No attachment at all — plain text report.
      await bot.sendMessage(ownerId, reportDetailsHtml(), { parse_mode: 'HTML', reply_markup: ownerKeyboard }).catch(() => {});
    }
  }

  const userConfirmText = `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Laporan Terkirim</b>
━━━━━━━━━━━━━━━━━━

ID Laporan: <code>${report.id}</code>
Waktu: ${formatWaktu(report.createdAt)}
${attachment ? '📎 Lampiran ikut terkirim ke owner.\n' : ''}
Owner sudah menerima laporanmu dan akan segera menghubungi kamu.
  `.trim();

  await bot.sendMessage(chatId, userConfirmText, { parse_mode: 'HTML' }).catch(() => {});
}

// Router utama untuk semua callback_query terkait fitur laporan.
// Return true kalau callback ditangani di sini (supaya index.js tahu untuk stop).
async function handleCallback(bot, query) {
  const data = String(query.data || '');

  if (data === 'menu_report') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await showReportConfirm(bot, query.message.chat.id, query.message.message_id);
    return true;
  }

  if (data.startsWith('report_owner_cancel_')) {
    const reportId = data.replace('report_owner_cancel_', '');
    await ownerCancelReport(bot, query, reportId);
    return true;
  }

  return false;
}

module.exports = { handleCallback, showReportConfirm, handleLaporCommand };
