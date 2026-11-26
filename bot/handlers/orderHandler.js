/**
 * Auto Order Handler
 * Flow: Button selection → Payment info → Proof upload → Owner confirmation → Receipt
 */

const db = require('../db');
const config = require('../../config');
const ownerService = require('../utils/ownerService');

function isAdminUser(userId) {
  return ownerService.isAdmin(userId);
}

// ========== SHOW PRICE LIST (BUY MENU) ==========
async function showBuyMenu(bot, chatId, userId) {
  const prices = await db.getPrices();
  const payments = await db.getPayments();

  // Filter enabled items
  const enabledPrices = Object.entries(prices)
    .filter(([_, p]) => p.enabled)
    .sort((a, b) => (a[1].displayOrder || 0) - (b[1].displayOrder || 0));

  const enabledPayments = Object.entries(payments).filter(([_, p]) => p.enabled);

  if (enabledPrices.length === 0) {
    return bot.sendMessage(chatId, '❌ Tidak ada paket yang tersedia saat ini.', { parse_mode: 'HTML' });
  }

  if (enabledPayments.length === 0) {
    return bot.sendMessage(chatId, '❌ Tidak ada metode pembayaran yang tersedia.', { parse_mode: 'HTML' });
  }

  let text = '🛒 <b>BELI AKSES</b>\n';
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  text += 'Pilih paket akses yang ingin dibeli:\n\n';

  const keyboard = [];

  for (const [key, price] of enabledPrices) {
    const duration = price.durationDays === null ? 'Permanen' : `${price.durationDays} hari`;
    text += `<b>${price.name}</b>\n`;
    text += `╰┈➤ Rp${price.price.toLocaleString('id-ID')} / ${duration}\n\n`;

    keyboard.push([{
      text: `🛒 ${price.name} - Rp${price.price.toLocaleString('id-ID')}`,
      callback_data: `buy_${key}`
    }]);
  }

  keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

// ========== HANDLE BUY CALLBACK ==========
async function handleBuyCallback(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Check if this is a buy callback
  if (!data.startsWith('buy_')) return false;

  const priceId = data.replace('buy_', '');
  const price = await db.getPrice(priceId);

  if (!price || !price.enabled) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Paket tidak tersedia' });
  }

  // Check for existing pending order
  const pendingOrders = await db.getPendingOrdersByUser(userId);
  if (pendingOrders.length > 0) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Anda memiliki order pending. Selesaikan dulu.' });
  }

  // Show payment methods
  const payments = await db.getPayments();
  const enabledPayments = Object.entries(payments).filter(([_, p]) => p.enabled);

  let text = `🛒 <b>KONFIRMASI PEMBELIAN</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `<b>Paket:</b> ${price.name}\n`;
  text += `<b>Harga:</b> Rp${price.price.toLocaleString('id-ID')}\n`;
  text += `<b>Durasi:</b> ${price.durationDays === null ? 'Permanen' : price.durationDays + ' hari'}\n\n`;
  text += `Pilih metode pembayaran:\n`;

  const keyboard = [];

  for (const [key, payment] of enabledPayments) {
    keyboard.push([{
      text: `💳 ${payment.name}`,
      callback_data: `pay_${priceId}_${key}`
    }]);
  }

  keyboard.push([{ text: '🔙 Batal', callback_data: 'buy_menu' }]);

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: query.message.message_id,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });

  return bot.answerCallbackQuery(query.id);
}

// ========== HANDLE PAYMENT SELECTION ==========
async function handlePaymentSelection(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const data = query.data;

  // Check if this is a pay callback
  if (!data.startsWith('pay_')) return false;

  const parts = data.replace('pay_', '').split('_');
  const paymentId = parts.pop();  // Last element is payment ID
  const priceId = parts.join('_'); // Rest is price ID (handles underscores)

  const price = await db.getPrice(priceId);
  const payment = await db.getPayment(paymentId);

  if (!price || !payment) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Data tidak ditemukan' });
  }

  // Create pending order
  const order = await db.addOrder({
    userId: userId,
    username: query.from.username || query.from.first_name,
    priceId: priceId,
    priceName: price.name,
    price: price.price,
    durationDays: price.durationDays,
    paymentMethod: paymentId,
    status: 'waiting_proof'
  });

  // Show payment details
  let text = `💳 <b>DETAIL PEMBAYARAN</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `<b>Order ID:</b> <code>${order.id}</code>\n`;
  text += `<b>Paket:</b> ${price.name}\n`;
  text += `<b>Total:</b> Rp${price.price.toLocaleString('id-ID')}\n\n`;
  text += `<b>Metode:</b> ${payment.name}\n`;

  // Cancel button keyboard
  const cancelKeyboard = {
    inline_keyboard: [[
      { text: '❌ Batal', callback_data: `cancel_order_${order.id}` }
    ]]
  };

  // Send payment info based on type
  if (payment.type === 'photo' && payment.data?.photoFileId) {
    // QRIS - send photo
    await bot.deleteMessage(chatId, messageId);
    await bot.sendPhoto(chatId, payment.data.photoFileId, {
      caption: text + `\n${payment.data.caption || ''}\n\n<i>Setelah membayar, kirim foto bukti pembayaran ke chat ini.</i>`,
      parse_mode: 'HTML',
      reply_markup: cancelKeyboard
    });
  } else if (payment.type === 'number') {
    // E-wallet - show number
    text += `━━━━━━━━━━━━━━━━━━\n\n`;
    text += `<b>Nomor:</b> <code>${payment.data?.number || '-'}</code>\n`;
    text += `<b>Atas Nama:</b> ${payment.data?.holderName || '-'}\n\n`;
    text += `<i>Setelah membayar, kirim foto bukti pembayaran ke chat ini.</i>`;

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: cancelKeyboard
    });
  }

  // Set session for waiting proof
  const session = require('../session/state');
  session.set(userId, {
    type: 'waiting_payment_proof',
    orderId: order.id
  });

  return bot.answerCallbackQuery(query.id, { text: '💳 Silakan lakukan pembayaran' });
}

// ========== HANDLE PAYMENT PROOF ==========
async function handlePaymentProof(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = require('../session/state');
  const state = session.get(userId);

  if (!state || state.type !== 'waiting_payment_proof') return false;

  if (!msg.photo || msg.photo.length === 0) {
    await bot.sendMessage(chatId, '❌ Kirim foto bukti pembayaran.', { parse_mode: 'HTML' });
    return true;
  }

  const order = await db.getOrderById(state.orderId);
  if (!order || order.status !== 'waiting_proof') {
    session.clear(userId);
    await bot.sendMessage(chatId, '❌ Order tidak ditemukan atau sudah diproses.', { parse_mode: 'HTML' });
    return true;
  }

  // Update order with proof
  const photo = msg.photo[msg.photo.length - 1];
  await db.updateOrder(order.id, {
    status: 'pending',
    proofPhotoId: photo.file_id,
    proofSentAt: new Date().toISOString()
  });

  session.clear(userId);

  // Notify user
  await bot.sendMessage(chatId, `
⏳ <b>BUKTI TERKIRIM</b>
━━━━━━━━━━━━━━━━━━

Order ID: <code>${order.id}</code>
Status: <b>Menunggu konfirmasi owner</b>

Owner akan memeriksa bukti pembayaran Anda.
Anda akan menerima notifikasi setelah dikonfirmasi.
  `.trim(), { parse_mode: 'HTML' });

  // Send to owner for confirmation
  const adminIds = ownerService.getAllAdminIds();
  for (const adminId of adminIds) {
    try {
      const userLink = `<a href="tg://user?id=${userId}">${msg.from.first_name || 'User'} ${msg.from.last_name || ''}</a>`.trim();

      let ownerText = `⏳ <b>ORDER BARU</b>\n`;
      ownerText += `━━━━━━━━━━━━━━━━━━\n\n`;
      ownerText += `<b>Order ID:</b> <code>${order.id}</code>\n`;
      ownerText += `<b>User:</b> ${userLink}\n`;
      ownerText += `<b>Username:</b> @${msg.from.username || '-'}\n`;
      ownerText += `<b>User ID:</b> <code>${userId}</code>\n\n`;
      ownerText += `<b>Paket:</b> ${order.priceName}\n`;
      ownerText += `<b>Harga:</b> Rp${order.price.toLocaleString('id-ID')}\n`;
      ownerText += `<b>Metode:</b> ${order.paymentMethod.toUpperCase()}\n\n`;
      ownerText += `<b>Waktu:</b> ${new Date().toLocaleString('id-ID')}\n\n`;
      ownerText += `<i>Klik tombol di bawah untuk konfirmasi.</i>`;

      await bot.sendPhoto(adminId, photo.file_id, {
        caption: ownerText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ TERIMA (YES)', callback_data: `confirm_yes_${order.id}` },
              { text: '❌ TOLAK (NO)', callback_data: `confirm_no_${order.id}` }
            ]
          ]
        }
      });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err.message);
    }
  }

  return true;
}

// ========== HANDLE OWNER CONFIRMATION ==========
async function handleOwnerConfirmation(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const messageId = query.message.message_id;
  const data = query.data;

  const match = String(data || '').match(/^confirm_(yes|no)_(.+)$/);
  if (!match) return false;

  if (!isAdminUser(userId)) {
    return bot.answerCallbackQuery(query.id, { text: '⛔ Akses ditolak' });
  }

  const action = match[1]; // 'yes' or 'no'
  const orderId = match[2];

  const order = await db.getOrderById(orderId);
  if (!order) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Order tidak ditemukan' });
  }

  if (order.status !== 'pending') {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Order sudah diproses' });
  }

  // YES - Approve
  if (action === 'yes') {
    // Update order status
    await db.updateOrder(orderId, {
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: userId
    });

    // Add member access
    const username = order.username || `User_${order.userId}`;
    await db.addMember(order.userId, username, order.durationDays === null ? null : new Date(Date.now() + order.durationDays * 24 * 60 * 60 * 1000).toISOString(), userId);

    // Notify buyer
    try {
      await bot.sendMessage(order.userId, `
🎉 <b>PEMBAYARAN DITERIMA!</b>
━━━━━━━━━━━━━━━━━━

Order ID: <code>${order.id}</code>
Paket: <b>${order.priceName}</b>

✅ Akses Anda telah diaktifkan!
Silakan gunakan /start untuk melihat menu.
      `.trim(), { parse_mode: 'HTML' });
    } catch (err) {
      console.error('Failed to notify buyer:', err.message);
    }

    // Send receipt to channel
    try {
      const channelId = config.payment?.paymentChannelId;
      if (channelId && channelId !== '-1001234567890') {
        const userLink = `<a href="tg://user?id=${order.userId}">${order.username || 'User'}</a>`;

        let receiptText = `✅ <b>TRANSAKSI BERHASIL</b>\n`;
        receiptText += `━━━━━━━━━━━━━━━━━━\n\n`;
        receiptText += `📦 <b>Paket:</b> ${order.priceName}\n`;
        receiptText += `💰 <b>Harga:</b> Rp${order.price.toLocaleString('id-ID')}\n`;
        receiptText += `💸 <b>Metode:</b> ${order.paymentMethod.toUpperCase()}\n`;
        receiptText += `🕐 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}\n\n`;
        receiptText += `👤 <b>Pembeli:</b> ${userLink}\n`;
        receiptText += `🏷️ <b>Order ID:</b> <code>${order.id}</code>`;

        await bot.sendPhoto(channelId, order.proofPhotoId, {
          caption: receiptText,
          parse_mode: 'HTML'
        });
      }
    } catch (err) {
      console.error('Failed to send receipt to channel:', err.message);
    }

    // Update owner message
    await bot.editMessageCaption(`✅ <b>ORDER DITERIMA</b>\n\nOrder ID: <code>${order.id}</code>\nStatus: <b>APPROVED</b>\nAkses telah diberikan ke user.`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });

    return bot.answerCallbackQuery(query.id, { text: '✅ Order diterima' });
  }

  // NO - Reject (ask for reason)
  if (action === 'no') {
    // Set session for rejection reason
    const session = require('../session/state');
    session.set(userId, {
      type: 'reject_order',
      orderId: orderId,
      step: 'waiting_reason'
    });

    await bot.editMessageCaption(`❌ <b>MENOLAK ORDER</b>\n\nOrder ID: <code>${order.id}</code>\n\nKirim alasan penolakan:`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    });

    return bot.answerCallbackQuery(query.id, { text: 'Kirim alasan penolakan' });
  }

  return false;
}

// ========== HANDLE REJECTION REASON ==========
async function handleRejectionReason(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;
  const session = require('../session/state');
  const state = session.get(userId);

  if (!state || state.type !== 'reject_order' || state.step !== 'waiting_reason') {
    return false;
  }

  if (text === '/cancel') {
    session.clear(userId);
    await bot.sendMessage(chatId, '❌ Dibatalkan.', { parse_mode: 'HTML' });
    return true;
  }

  const order = await db.getOrderById(state.orderId);
  if (!order) {
    session.clear(userId);
    await bot.sendMessage(chatId, '❌ Order tidak ditemukan.', { parse_mode: 'HTML' });
    return true;
  }

  // Update order
  await db.updateOrder(order.id, {
    status: 'rejected',
    rejectedAt: new Date().toISOString(),
    rejectedBy: userId,
    rejectionReason: text
  });

  session.clear(userId);

  // Notify buyer
  try {
    await bot.sendMessage(order.userId, `
❌ <b>PEMBAYARAN DITOLAK</b>
━━━━━━━━━━━━━━━━━━

Order ID: <code>${order.id}</code>
Paket: <b>${order.priceName}</b>

<b>Alasan:</b> ${text}

Silakan hubungi owner untuk informasi lebih lanjut.
    `.trim(), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Failed to notify buyer:', err.message);
  }

  await bot.sendMessage(chatId, `✅ Order <code>${order.id}</code> ditolak.\nAlasan: ${text}`, { parse_mode: 'HTML' });
  return true;
}

// ========== CALLBACK ROUTER ==========
async function handleOrderCallback(bot, query) {
  const data = query.data;

  if (data === 'buy_menu') {
    await bot.deleteMessage(query.message.chat.id, query.message.message_id);
    return showBuyMenu(bot, query.message.chat.id, query.from.id);
  }

  // Handle buy callbacks
  const buyResult = await handleBuyCallback(bot, query);
  if (buyResult !== false) return buyResult;

  // Handle payment selection
  const payResult = await handlePaymentSelection(bot, query);
  if (payResult !== false) return payResult;

  // Handle owner confirmation
  const confirmResult = await handleOwnerConfirmation(bot, query);
  if (confirmResult !== false) return confirmResult;

  // Handle cancel order
  if (data.startsWith('cancel_order_')) {
    const orderId = data.replace('cancel_order_', '');
    const order = await db.getOrderById(orderId);

    if (!order || order.userId !== query.from.id) {
      return bot.answerCallbackQuery(query.id, { text: '❌ Order tidak ditemukan' });
    }

    if (order.status !== 'waiting_proof') {
      return bot.answerCallbackQuery(query.id, { text: '❌ Order sudah diproses' });
    }

    // Delete order
    await db.deleteOrder(orderId);
    session.clear(query.from.id);

    await bot.deleteMessage(query.message.chat.id, query.message.message_id);
    await bot.answerCallbackQuery(query.id, { text: '✅ Order dibatalkan' });
    return showBuyMenu(bot, query.message.chat.id, query.from.id);
  }

  return false;
}

module.exports = {
  showBuyMenu,
  handleOrderCallback,
  handlePaymentProof,
  handleRejectionReason
};
