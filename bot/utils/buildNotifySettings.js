const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

const SETTINGS_FILE = path.resolve(__dirname, '../../database/buildNotifySettings.json');

fs.ensureDirSync(path.dirname(SETTINGS_FILE));

function getChannelId() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readJsonSync(SETTINGS_FILE);
      if (data && data.channelId) return String(data.channelId);
    }
  } catch (error) {
    console.error('[buildNotifySettings] Gagal membaca setting:', error.message);
  }
  // fallback ke config.js kalau belum pernah di-set lewat command
  return config.build?.notifyChannelId || '';
}

function setChannelId(channelId) {
  try {
    fs.writeJsonSync(SETTINGS_FILE, {
      channelId: String(channelId || ''),
      updatedAt: new Date().toISOString()
    }, { spaces: 2 });
    return true;
  } catch (error) {
    console.error('[buildNotifySettings] Gagal menyimpan setting:', error.message);
    return false;
  }
}

module.exports = { getChannelId, setChannelId, file: SETTINGS_FILE };
