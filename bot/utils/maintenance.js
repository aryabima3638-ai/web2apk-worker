const fs = require('fs-extra');
const path = require('path');
const MAINTENANCE_FILE = path.resolve(__dirname, '../../database/maintenance.json');

fs.ensureDirSync(path.dirname(MAINTENANCE_FILE));

function isEnabled() {
  try {
    if (!fs.existsSync(MAINTENANCE_FILE)) return false;
    const data = fs.readJsonSync(MAINTENANCE_FILE);
    return !!data.enabled;
  } catch (error) {
    console.error('[maintenance] Failed reading maintenance file:', error.message);
    return false;
  }
}

// Fitur baru: alasan maintenance opsional.
// Dipanggil dari /maintenance on <alasan> atau /maintenance on (tanpa alasan).
function getReason() {
  try {
    if (!fs.existsSync(MAINTENANCE_FILE)) return '';
    const data = fs.readJsonSync(MAINTENANCE_FILE);
    return typeof data.reason === 'string' ? data.reason : '';
  } catch (error) {
    console.error('[maintenance] Failed reading maintenance reason:', error.message);
    return '';
  }
}

function set(enabled, reason = '') {
  try {
    fs.writeJsonSync(MAINTENANCE_FILE, {
      enabled: !!enabled,
      // Alasan hanya disimpan saat maintenance diaktifkan; saat dimatikan, alasan dikosongkan
      // supaya sisa alasan lama tidak nyangkut kalau nanti diaktifkan lagi tanpa alasan baru.
      reason: enabled ? String(reason || '').trim() : '',
      updatedAt: new Date().toISOString()
    }, { spaces: 2 });
    return true;
  } catch (error) {
    console.error('[maintenance] Failed writing maintenance file:', error.message);
    return false;
  }
}

module.exports = {
  isEnabled,
  getReason,
  set,
  file: MAINTENANCE_FILE
};
