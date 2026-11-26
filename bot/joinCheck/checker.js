const config = require('../../config');

async function isAllJoined(bot, userId) {
  const channels = config.requiredJoins;
  if (!channels || channels.length === 0) return true;

  for (const channel of channels) {
    try {
      const member = await bot.getChatMember(channel, userId);
      const status = member.status;
      if (status !== 'member' && status !== 'administrator' && status !== 'creator') {
        return false;
      }
    } catch (error) {
      console.error(`Error checking join status for ${channel}:`, error);
      // Assume not joined if there's an error (e.g., bot not admin in channel)
      return false;
    }
  }
  return true;
}

module.exports = { isAllJoined };
