const config = require('../../config');

function handleToUrl(handle) {
  if (!handle) return null;
  const cleaned = String(handle).trim().replace(/^@/, '');
  if (!cleaned) return null;
  return `https://t.me/${cleaned}`;
}

const ownerLink = config.telegram.ownerLink;
const ownerLink2 = config.telegram.ownerLink2;
const informationLink = config.telegram.informationLink || handleToUrl((config.requiredJoins || [])[0]);

function createButton({ text, callback_data, url, style, icon_custom_emoji_id }, useColors = false) {
  const button = { text, icon_custom_emoji_id };
  if (callback_data) button.callback_data = callback_data;
  if (url) button.url = url;
  if (useColors && style) button.style = style;
  return button;
}

/**
 * Generate main menu keyboard with optional colored buttons
 * @param {boolean} useColors - Whether to include button style metadata
 * @returns {Array} Inline keyboard array
 */
function getMainMenu(useColors = false) {
  const topRow = [
    createButton({
      text: '𝗕𝘂𝗶𝗹𝗱 𝗔𝗣𝗞',
      callback_data: 'build_apk',
      style: 'primary',
      icon_custom_emoji_id: "5361734213370396027"
    }, useColors),
    createButton({
      text: '𝗖𝗲𝗸 𝗔𝗻𝘁𝗿𝗶𝗮𝗻',
      callback_data: 'status_build',
      style: 'success',
      icon_custom_emoji_id: "5231200819986047254"
    }, useColors),
  ];

  const commandRow = [
    createButton({
      text: '𝗣𝗲𝗿𝗶𝗻𝘁𝗮𝗵',
      callback_data: 'commands',
      style: 'danger',
      icon_custom_emoji_id: "5397782960512444700"
    }, useColors)
  ];

  const devInfoRow = [];
  if (ownerLink) {
    devInfoRow.push(createButton({
      text: '𝗗𝗲𝘃',
      url: ownerLink,
      style: 'primary',
      icon_custom_emoji_id: "5816539591812845173"
    }, useColors));
  }
  if (informationLink) {
    devInfoRow.push(createButton({
      text: '𝗜𝗻𝗳𝗼𝗿𝗺𝗮𝘁𝗶𝗼𝗻',
      url: informationLink,
      style: 'primary',
      icon_custom_emoji_id: "5334544901428229844"
    }, useColors));
  }

  const keyboard = [topRow, commandRow];

  keyboard.push([
    createButton({
      text: '𝗟𝗮𝗽𝗼𝗿𝗮𝗻 / 𝗕𝗮𝗻𝘁𝘂𝗮𝗻',
      callback_data: 'menu_report',
      style: 'danger',
      icon_custom_emoji_id: "5447644880824181073"
    }, useColors),
  ]);

  if (devInfoRow.length > 0) keyboard.push(devInfoRow);

  // Tetap pertahankan Owner 2 jika suatu saat dikonfigurasi, tanpa mengubah fungsinya.
  if (ownerLink2) {
    keyboard.push([
      createButton({
        text: 'Owner 2',
        url: ownerLink2,
        style: 'primary',
        icon_custom_emoji_id: "5210956306952758910"
      }, useColors)
    ]);
  }

  return keyboard;
}

/**
 * Strip style properties from keyboard for compatibility with public API
 * @param {Array} keyboard - Keyboard with possible style properties
 * @returns {Array} Clean keyboard without style
 */
function stripStyles(keyboard) {
  return keyboard.map(row =>
    row.map(btn => {
      const { style, ...rest } = btn;
      return rest;
    })
  );
}

// Default export is non-colored for backward compatibility
const mainMenu = getMainMenu(false);

module.exports = mainMenu;
module.exports.getMainMenu = getMainMenu;
module.exports.stripStyles = stripStyles;
