const session = require('../../session/state');

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function urlToApkHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const url = String(msg.text || '').trim();

  if (!isValidHttpUrl(url)) return;

  session.set(userId, {
    type: 'url_to_apk',
    step: 2,
    url,
    jobId: `job-${Date.now()}`,
    appName: null,
    iconFileId: null
  });

  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5258500400918587241">📝</tg-emoji> <b>Buat APK Baru</b>
━━━━━━━━━━━━━━━━━━

<b>Langkah 2/3: Nama Aplikasi</b>

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> URL: <code>${url}</code>

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

module.exports = urlToApkHandler;
