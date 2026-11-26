/**
 * Payment & Price Management Handler
 * Commands: /payments, /prices
 */

const db = require('../db');
const config = require('../../config');
const ownerService = require('../utils/ownerService');

function isAdminUser(userId) {
  return ownerService.isAdmin(userId);
}

// ========== PAYMENTS COMMAND ==========
async function handlePaymentsCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminUser(userId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke perintah ini.', { parse_mode: 'HTML' });
  }

  const payments = await db.getPayments();

  let text = '<tg-emoji emoji-id="6086980694460861135">💳</tg-emoji> <b>MANAJEMEN PAYMENT</b>\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  text += '<i>Kelola metode pembayaran manual</i>\n\n';

  const keyboard = [];

  for (const [key, payment] of Object.entries(payments)) {
    const status = payment.enabled ? '🟢' : '🔴';
    text += `${status} <b>${payment.name}</b> (${payment.type})\n`;

    keyboard.push([{
      text: `${payment.enabled ? '🔴' : '🟢'} ${payment.name}`,
      callback_data: `payment_toggle_${key}`
    }]);

    if (payment.type === 'number') {
      keyboard.push([{
        text: `✏️ Edit ${payment.name}`,
        callback_data: `payment_edit_${key}`
      }]);
    } else if (payment.type === 'photo') {
      keyboard.push([{
        text: `📷 Update QRIS`,
        callback_data: `payment_update_qris`
      }]);
    }
  }

  keyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_panel' }]);

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ========== PRICES COMMAND ==========
async function handlePricesCommand(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminUser(userId)) {
    return bot.sendMessage(chatId, '⛔ Anda tidak memiliki akses ke perintah ini.', { parse_mode: 'HTML' });
  }

  const prices = await db.getPrices();

  let text = '<tg-emoji emoji-id="5409048419211682843">💰</tg-emoji> <b>MANAJEMEN HARGA</b>\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  text += '<i>Kelola harga paket akses</i>\n\n';

  const sortedPrices = Object.entries(prices).sort((a, b) => (a[1].displayOrder || 0) - (b[1].displayOrder || 0));

  const keyboard = [];

  for (const [key, price] of sortedPrices) {
    const status = price.enabled ? '🟢' : '🔴';
    const duration = price.durationDays === null ? 'Permanen' : `${price.durationDays} hari`;
    text += `${status} <b>${price.name}</b>: Rp${price.price.toLocaleString('id-ID')} (${duration})\n`;

    keyboard.push([{
      text: `${status} ${price.name} - Rp${price.price.toLocaleString('id-ID')}`,
      callback_data: `price_toggle_${key}`
    }]);

    keyboard.push([
      { text: '💰 Harga', callback_data: `price_edit_${key}_price` },
      { text: '📛 Nama', callback_data: `price_edit_${key}_name` }
    ]);
  }

  keyboard.push([{ text: '🔙 Kembali', callback_data: 'admin_panel' }]);

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ========== CALLBACK HANDLERS ==========
async function handlePaymentCallback(bot, query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  // Only handle payment callbacks
  if (!data.startsWith('payment_') && !data.startsWith('update_qris')) return false;

  if (!isAdminUser(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '⛔ Akses ditolak' });
  }

  // Toggle payment
  if (data.startsWith('payment_toggle_')) {
    const paymentId = data.replace('payment_toggle_', '');
    const payment = await db.getPayment(paymentId);

    if (!payment) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Payment tidak ditemukan' });
    }

    await db.updatePayment(paymentId, { enabled: !payment.enabled });
    await bot.answerCallbackQuery(query.id, { text: `${payment.enabled ? '🔴' : '🟢'} ${payment.name} ${payment.enabled ? 'dinonaktifkan' : 'diaktifkan'}` });

    // Refresh menu
    await bot.deleteMessage(chatId, messageId);
    return handlePaymentsCommand(bot, { chat: { id: chatId }, from: { id: userId } });
  }

  // Edit number payment
  if (data.startsWith('payment_edit_')) {
    const paymentId = data.replace('payment_edit_', '');
    const payment = await db.getPayment(paymentId);

    if (!payment) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Payment tidak ditemukan' });
    }

    const session = require('../session/state');
    session.set(userId, {
      type: 'edit_payment',
      paymentId: paymentId,
      step: 'waiting_number'
    });

    await bot.answerCallbackQuery(query.id, { text: '✏️ Mode edit aktif' });
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6086980694460861135">💳</tg-emoji> <b>Edit ${payment.name}</b>
━━━━━━━━━━━━━━━━━━

Nomor saat ini: <code>${payment.data?.number || '-'}</code>
Atas nama: <code>${payment.data?.holderName || '-'}</code>

Kirim nomor dan nama pemisah dengan koma:
<code>081234567890, Nama Pemilik</code>

Atau ketik /cancel untuk batal.
    `.trim(), { parse_mode: 'HTML' });
  }

  // Update QRIS
  if (data === 'payment_update_qris') {
    const session = require('../session/state');
    session.set(userId, {
      type: 'update_qris',
      step: 'waiting_photo'
    });

    await bot.answerCallbackQuery(query.id, { text: '📷 Kirim foto QRIS' });
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6086980694460861135">💳</tg-emoji> <b>Update QRIS</b>
━━━━━━━━━━━━━━━━━━

Silakan kirim foto QRIS Anda.
Foto akan disimpan dan ditampilkan ke pembeli.

Ketik /cancel untuk batal.
    `.trim(), { parse_mode: 'HTML' });
  }

  return false;
}

async function handlePriceCallback(bot, query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const userId = query.from.id;

  // Only handle price callbacks
  if (!data.startsWith('price_')) return false;

  if (!isAdminUser(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '⛔ Akses ditolak' });
  }

  // Toggle price
  if (data.startsWith('price_toggle_')) {
    const priceId = data.replace('price_toggle_', '');
    const price = await db.getPrice(priceId);

    if (!price) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Harga tidak ditemukan' });
    }

    await db.updatePrice(priceId, { enabled: !price.enabled });
    await bot.answerCallbackQuery(query.id, { text: `${price.enabled ? '🔴' : '🟢'} ${price.name} ${price.enabled ? 'dinonaktifkan' : 'diaktifkan'}` });

    // Refresh menu
    await bot.deleteMessage(chatId, messageId);
    return handlePricesCommand(bot, { chat: { id: chatId }, from: { id: userId } });
  }

  // Edit price value
  if (data.startsWith('price_edit_') && data.endsWith('_price')) {
    const priceId = data.replace('price_edit_', '').replace('_price', '');
    const price = await db.getPrice(priceId);

    if (!price) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Harga tidak ditemukan' });
    }

    const session = require('../session/state');
    session.set(userId, {
      type: 'edit_price_value',
      priceId: priceId,
      step: 'waiting_price'
    });

    await bot.answerCallbackQuery(query.id, { text: '💰 Masukkan harga baru' });
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5409048419211682843">💰</tg-emoji> <b>Edit Harga ${price.name}</b>
━━━━━━━━━━━━━━━━━━

Harga saat ini: Rp${price.price.toLocaleString('id-ID')}

Kirim harga baru (angka saja):
<code>25000</code>

Ketik /cancel untuk batal.
    `.trim(), { parse_mode: 'HTML' });
  }

  // Edit price name
  if (data.startsWith('price_edit_') && data.endsWith('_name')) {
    const priceId = data.replace('price_edit_', '').replace('_name', '');
    const price = await db.getPrice(priceId);

    if (!price) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Harga tidak ditemukan' });
    }

    const session = require('../session/state');
    session.set(userId, {
      type: 'edit_price_name',
      priceId: priceId,
      step: 'waiting_name'
    });

    await bot.answerCallbackQuery(query.id, { text: '📛 Masukkan nama baru' });
    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5409048419211682843">💰</tg-emoji> <b>Edit Nama Paket</b>
━━━━━━━━━━━━━━━━━━

Nama saat ini: ${price.name}

Kirim nama baru:
<code>Nama Baru</code>

Ketik /cancel untuk batal.
    `.trim(), { parse_mode: 'HTML' });
  }

  return false;
}

// ========== INPUT HANDLERS ==========
async function handlePaymentInput(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = require('../session/state');
  const state = session.get(userId);

  if (!state) return false;

  // Cancel command
  if (text === '/cancel') {
    session.clear(userId);
    await bot.sendMessage(chatId, '❌ Dibatalkan.', { parse_mode: 'HTML' });
    return true;
  }

  // Edit payment number
  if (state.type === 'edit_payment' && state.step === 'waiting_number') {
    const parts = text.split(',').map(p => p.trim());
    if (parts.length < 2) {
      await bot.sendMessage(chatId, '❌ Format salah. Gunakan: <code>nomor, nama</code>', { parse_mode: 'HTML' });
      return true;
    }

    const [number, holderName] = parts;
    await db.updatePayment(state.paymentId, {
      data: { number, holderName }
    });

    session.clear(userId);
    await bot.sendMessage(chatId, `✅ <b>Payment diupdate!</b>\nNomor: <code>${number}</code>\nAtas nama: ${holderName}`, { parse_mode: 'HTML' });
    return true;
  }

  // Edit price value
  if (state.type === 'edit_price_value' && state.step === 'waiting_price') {
    const price = parseInt(text.replace(/[^0-9]/g, ''));
    if (!price || price < 1000) {
      await bot.sendMessage(chatId, '❌ Harga tidak valid. Minimal Rp1.000', { parse_mode: 'HTML' });
      return true;
    }

    await db.updatePrice(state.priceId, { price });
    session.clear(userId);

    const priceData = await db.getPrice(state.priceId);
    await bot.sendMessage(chatId, `✅ <b>Harga diupdate!</b>\n${priceData.name}: Rp${price.toLocaleString('id-ID')}`, { parse_mode: 'HTML' });
    return true;
  }

  // Edit price name
  if (state.type === 'edit_price_name' && state.step === 'waiting_name') {
    if (text.length < 2 || text.length > 50) {
      await bot.sendMessage(chatId, '❌ Nama terlalu pendek/panjang (2-50 karakter)', { parse_mode: 'HTML' });
      return true;
    }

    await db.updatePrice(state.priceId, { name: text });
    session.clear(userId);

    await bot.sendMessage(chatId, `✅ <b>Nama diupdate!</b>\nNama baru: ${text}`, { parse_mode: 'HTML' });
    return true;
  }

  return false;
}

async function handlePaymentPhoto(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = require('../session/state');
  const state = session.get(userId);

  if (!state || state.type !== 'update_qris') return false;

  const photo = msg.photo[msg.photo.length - 1];
  const caption = msg.caption || 'Silakan scan QRIS di atas untuk melakukan pembayaran.';

  await db.updatePayment('qris', {
    data: {
      photoFileId: photo.file_id,
      caption: caption
    }
  });

  session.clear(userId);

  await bot.sendMessage(chatId, '✅ <b>QRIS berhasil diupdate!</b>', { parse_mode: 'HTML' });

  // Show preview
  await bot.sendPhoto(chatId, photo.file_id, {
    caption: `<tg-emoji emoji-id="6086980694460861135">💳</tg-emoji> <b>Preview QRIS</b>\n\n${caption}`,
    parse_mode: 'HTML'
  });

  return true;
}

module.exports = {
  handlePaymentsCommand,
  handlePricesCommand,
  handlePaymentCallback,
  handlePriceCallback,
  handlePaymentInput,
  handlePaymentPhoto
};
