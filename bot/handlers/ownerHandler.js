/**
 * ownerHandler.js
 * ─────────────────────────────────────────────────────────────────────────
 * Fitur "Add Owner": owner yang sudah ada bisa menambahkan owner baru
 * (dapat akses admin penuh di seluruh fitur bot) tanpa perlu edit config.js
 * dan restart bot.
 *
 * Perintah:
 *   /addowner <user_id>   -> tambah owner baru
 *   /delowner <user_id>   -> hapus owner (hanya owner dinamis, owner dari
 *                             config.js tidak bisa dihapus lewat bot)
 *   /listowners           -> lihat semua owner (statis + dinamis)
 */

const ownerService = require('../utils/ownerService');

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleAddOwner(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ownerService.isAdmin(userId)) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Perintah ini hanya untuk owner.', { parse_mode: 'HTML' });
  }

  const parts = msg.text.trim().split(/\s+/);
  const targetId = parts[1];

  if (!targetId || !/^\d+$/.test(targetId)) {
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Format salah.

Gunakan: <code>/addowner &lt;user_id&gt;</code>
Contoh: <code>/addowner 123456789</code>

Tips: minta calon owner kirim ID Telegram-nya lewat @userinfobot.
    `.trim(), { parse_mode: 'HTML' });
  }

  const result = ownerService.addOwner(targetId, userId);

  if (!result.ok) {
    const reasonText = result.reason === 'exists'
      ? 'User ini sudah menjadi owner.'
      : 'User ID tidak valid.';
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> ${reasonText}`, { parse_mode: 'HTML' });
  }

  await bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Owner Baru Ditambahkan</b>
━━━━━━━━━━━━━━━━━━

User ID: <code>${escapeHtml(targetId)}</code>
Ditambahkan oleh: <code>${escapeHtml(userId)}</code>

User ini sekarang punya akses admin penuh di semua fitur bot.
  `.trim(), { parse_mode: 'HTML' });

  // Beri tahu owner baru (best-effort, kalau gagal kirim ya diabaikan)
  await bot.sendMessage(targetId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Kamu baru saja ditambahkan sebagai <b>Owner</b> bot ini.
Ketik /start untuk melihat menu admin.
  `.trim(), { parse_mode: 'HTML' }).catch(() => {});
}

async function handleDelOwner(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ownerService.isAdmin(userId)) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Perintah ini hanya untuk owner.', { parse_mode: 'HTML' });
  }

  const parts = msg.text.trim().split(/\s+/);
  const targetId = parts[1];

  if (!targetId || !/^\d+$/.test(targetId)) {
    return bot.sendMessage(chatId, 'Gunakan: <code>/delowner &lt;user_id&gt;</code>', { parse_mode: 'HTML' });
  }

  const result = ownerService.removeOwner(targetId);
  if (!result.ok) {
    const reasonText = result.reason === 'static'
      ? 'Owner ini didaftarkan lewat config.js, tidak bisa dihapus lewat bot.'
      : 'User ini bukan owner (atau sudah dihapus).';
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> ${reasonText}`, { parse_mode: 'HTML' });
  }

  return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Owner <code>${escapeHtml(targetId)}</code> berhasil dihapus.`, { parse_mode: 'HTML' });
}

async function handleListOwners(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!ownerService.isAdmin(userId)) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Perintah ini hanya untuk owner.', { parse_mode: 'HTML' });
  }

  const owners = ownerService.getOwners();
  const lines = owners.map((o, i) => {
    const tag = o.source === 'config' ? '(utama, config.js)' : `(ditambah oleh ${escapeHtml(o.addedBy)})`;
    return `${i + 1}. <code>${escapeHtml(o.id)}</code> ${tag}`;
  });

  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5334544901428229844">📋</tg-emoji> <b>Daftar Owner (${owners.length})</b>
━━━━━━━━━━━━━━━━━━

${lines.join('\n')}

Gunakan <code>/addowner &lt;id&gt;</code> untuk menambah, <code>/delowner &lt;id&gt;</code> untuk menghapus.
  `.trim(), { parse_mode: 'HTML' });
}

module.exports = { handleAddOwner, handleDelOwner, handleListOwners };
