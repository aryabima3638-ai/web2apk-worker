/**
 * Handle /done command for transaction confirmation
 * Usage: /done <name_item>, <price> [payment]
 * Gen 4 Style - Exact copy from transactionHandler.js
 */

async function handleDoneCommand(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Send processing message first
  const processingMsg = await bot.sendMessage(chatId, '<blockquote>memproses...</blockquote>', {
    parse_mode: 'HTML',
    reply_to_message_id: msg.message_id
  });

  // Simulate delay (as requested in original code)
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    // Parse arguments: /done name item, price, payment
    // Remove command part, support both caption and text
    const content = msg.caption || msg.text;
    const args = content.split(/\s(.+)/)[1];

    if (!args || !args.includes(',')) {
      const usage = '<blockquote>Penggunaan: /done name item, price, [payment] (Reply foto/Kirim dengan foto)</blockquote>';
      // Try to edit if it was text, otherwise send new message
      try {
        await bot.editMessageText(usage, {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (e) {
        await bot.sendMessage(chatId, usage, { parse_mode: 'HTML' });
      }
      return;
    }

    const parts = args.split(',');

    if (parts.length < 2) {
      const usage = '<blockquote>Penggunaan: /done name item, price, [payment]</blockquote>';
      try {
        await bot.editMessageText(usage, {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: 'HTML'
        });
      } catch (e) {
        await bot.sendMessage(chatId, usage, { parse_mode: 'HTML' });
      }
      return;
    }

    const nameItem = parts[0].trim();
    const price = parts[1].trim();
    const payment = parts.length > 2 ? parts[2].trim() : 'Lainnya';

    const now = new Date();
    const time = now.toISOString().replace('T', ' ').substring(0, 19);

    const EMOJI_DONE = '<tg-emoji emoji-id="6334447321257874711">✔️</tg-emoji>';
    const EMOJI_BARANG = '<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji>';
    const EMOJI_RUPIAH = '<tg-emoji emoji-id="5373174941095050893">💸</tg-emoji>';
    const EMOJI_WAKTU = '<tg-emoji emoji-id="5229045747130843073">🎖</tg-emoji>';
    const EMOJI_PAY = '<tg-emoji emoji-id="5463046637842608206">🪙</tg-emoji>';
    const EMOJI_THX = '<tg-emoji emoji-id="5463256910851546817">🤝</tg-emoji>';
    const EMOJI_LOAD = '<tg-emoji emoji-id="5226702984204797593">🔄</tg-emoji>';
    const EMOJI_OWN = '<tg-emoji emoji-id="5080331039922980916">⚡️</tg-emoji>';

    const userLink = msg.from ? `<a href="tg://user?id=${msg.from.id}">${msg.from.first_name} ${msg.from.last_name || ''}</a>`.trim() : 'Admin';

    const responseToken = `
<blockquote>${EMOJI_DONE}「 𝗣𝗘𝗠𝗕𝗔𝗬𝗔𝗥𝗔𝗡 𝗗𝗜𝗧𝗘𝗥𝗜𝗠𝗔 」${EMOJI_DONE}</blockquote>
<blockquote>${EMOJI_BARANG} <b>ʙᴀʀᴀɴɢ : ${nameItem}</b>
${EMOJI_RUPIAH} <b>ɴᴏᴍɪɴᴀʟ : ${price}</b>
${EMOJI_WAKTU} <b>ᴡᴀᴋᴛᴜ : ${time}</b>
${EMOJI_PAY} <b>ᴘᴀʏᴍᴇɴᴛ : ${payment}</b></blockquote>
<blockquote>${EMOJI_THX} ᴛᴇʀɪᴍᴀᴋᴀꜱɪʜ ᴛᴇʟᴀʜ ᴏʀᴅᴇʀ\n ${EMOJI_LOAD} ᴘᴇsᴀɴᴀɴ sᴇɢᴇʀᴀ ᴅɪᴘʀᴏsᴇs</blockquote>
<blockquote>${EMOJI_OWN} ʙʏ : ${userLink}</blockquote>
    `.trim();

    // Determine Image Source
    let imageSource = null;

    // 1. Check if replying to a photo
    if (msg.reply_to_message && msg.reply_to_message.photo) {
      imageSource = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1].file_id;
    }
    // 2. Check if the command itself has a photo (caption)
    else if (msg.photo) {
      imageSource = msg.photo[msg.photo.length - 1].file_id;
    }
    // 3. Use Default Banner if configured (Optional: Add URL here)
    // const DEFAULT_BANNER = 'https://example.com/banner.jpg'; // Uncomment to use default

    // Delete "processing..." message
    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => { });

    if (imageSource) {
      // Send Photo with Caption
      await bot.sendPhoto(chatId, imageSource, {
        caption: responseToken,
        parse_mode: 'HTML'
      });
    } else {
      // Fallback to Text Only (or edit the processing message if we prefer not to delete)
      // But since we deleted above, we send new
      await bot.sendMessage(chatId, responseToken, {
        parse_mode: 'HTML'
      });
    }

  } catch (error) {
    console.error('Transaction command error:', error);
    await bot.sendMessage(chatId, `error: ${error.message}`);
  }
}

module.exports = { handleDoneCommand };

