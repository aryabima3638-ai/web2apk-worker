const db = require('../db');
const config = require('../../config');
const joinChecker = require('../joinCheck/checker');
const { getMainMenu, stripStyles } = require('../menus/mainMenu');
const path = require('path');

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

function buildMainMenus() {
  const colored = getMainMenu(true);
  return {
    colored,
    fallback: stripStyles(colored)
  };
}

async function sendWithMenuFallback(sendFn, coloredMenu, fallbackMenu) {
  try {
    return await sendFn(coloredMenu);
  } catch (error) {
    if (!isStyleUnsupportedError(error)) throw error;
    console.warn('[start] Button style unsupported by current API endpoint. Fallback to non-style keyboard.');
    return sendFn(fallbackMenu);
  }
}

async function startHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Save user to database
  await db.addUser(userId);

  // Check if user has joined all required channels
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

  // Show main menu
  const caption = `<b>𝗪𝗲𝗯𝟮𝗔𝗽𝗸 𝗩𝟯 𝗚𝗲𝗻𝟭</b>

𝗕𝗮𝗻𝗴𝘂𝗻 𝗔𝗣𝗞 𝗱𝗮𝗿𝗶 𝗽𝗿𝗼𝘆𝗲𝗸 𝗙𝗹𝘂𝘁𝘁𝗲𝗿/𝗔𝗻𝗱𝗿𝗼𝗶𝗱 𝗱𝗲𝗻𝗴𝗮𝗻 𝗮𝗹𝘂𝗿 𝘆𝗮𝗻𝗴 𝗿𝗮𝗽𝗶, 𝗰𝗲𝗽𝗮𝘁, 𝗱𝗮𝗻 𝘁𝗲𝗿𝘂𝗸𝘂𝗿.

<b>𝗙𝗶𝘁𝘂𝗿 𝘂𝘁𝗮𝗺𝗮</b>
• 𝗠𝘂𝗹𝘁𝗶-𝘄𝗼𝗿𝗸𝗲𝗿 (𝗩𝗣𝗦 + 𝗚𝗶𝘁𝗛𝘂𝗯 𝗔𝗰𝘁𝗶𝗼𝗻𝘀)
• 𝗔𝗻𝘁𝗿𝗶𝗮𝗻 𝗼𝘁𝗼𝗺𝗮𝘁𝗶𝘀 𝘀𝗮𝗮𝘁 𝘀𝗹𝗼𝘁 𝗽𝗲𝗻𝘂𝗵
• 𝗕𝘂𝗶𝗹𝗱 𝗱𝗮𝗿𝗶 𝗭𝗜𝗣 𝗮𝘁𝗮𝘂 𝗨𝗥𝗟

𝗦𝗶𝗹𝗮𝗸𝗮𝗻 𝗽𝗶𝗹𝗶𝗵 𝗺𝗲𝗻𝘂:`;

  const coverPath = path.resolve(__dirname, '../../assets/cover.png');
  const { colored: coloredMenu, fallback: fallbackMenu } = buildMainMenus();

  try {
    return await sendWithMenuFallback(
      (menu) => bot.sendPhoto(chatId, coverPath, {
        caption,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: menu
        }
      }),
      coloredMenu,
      fallbackMenu
    );
  } catch (_) {
    try {
      return await sendWithMenuFallback(
        (menu) => bot.sendMessage(chatId, caption, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: menu
          }
        }),
        coloredMenu,
        fallbackMenu
      );
    } catch (fallbackError) {
      return bot.sendMessage(chatId, caption, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: fallbackMenu
        }
      });
    }
  }
}

module.exports = startHandler;
