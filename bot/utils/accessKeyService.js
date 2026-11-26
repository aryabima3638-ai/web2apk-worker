/**
 * Access Key Service
 * Manages access keys integrated with members.json
 * Features: Key-only login, access types (all/bot/web), device binding
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const MEMBERS_PATH = path.join(__dirname, '..', '..', 'database', 'members.json');

class AccessKeyService {
  constructor() {
    this.members = [];
    this.loadDatabase();
  }

  loadDatabase() {
    if (fs.existsSync(MEMBERS_PATH)) {
      try {
        const data = fs.readFileSync(MEMBERS_PATH, 'utf8');
        this.members = JSON.parse(data);
        console.log(`🔑 Access keys loaded: ${this.members.length} members`);
      } catch (e) {
        console.error('Failed to load members:', e.message);
        this.members = [];
      }
    }
  }

  persist() {
    try {
      fs.writeFileSync(MEMBERS_PATH, JSON.stringify(this.members, null, 2));
    } catch (e) {
      console.error('Failed to save members:', e.message);
    }
  }

  /**
   * Generate random access key (16 chars uppercase)
   */
  generateKey() {
    return crypto.randomUUID().replace(/-/g, '').substring(0, 16).toUpperCase();
  }

  /**
   * Create new access key
   * @param {Object} data - { telegramId, username, days, accessType, createdBy }
   * @returns {Object} - { success, key, expiresAt } or { success, error }
   */
  createKey({ telegramId, username, days, accessType = 'all', createdBy }) {
    if (!telegramId || !days || !createdBy) {
      return { success: false, error: 'Data tidak lengkap' };
    }

    const validAccessTypes = ['all', 'bot', 'web'];
    if (!validAccessTypes.includes(accessType)) {
      accessType = 'all';
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const key = this.generateKey();

    // Check if telegramId already has active key
    const existingIndex = this.members.findIndex(
      m => m.telegramId === String(telegramId) && new Date(m.expiresAt) > now
    );

    const memberData = {
      id: crypto.randomUUID(),
      telegramId: String(telegramId),
      username: username || null,
      key: key,
      expiresAt: expiresAt.toISOString(),
      accessType: accessType,
      createdBy: createdBy,
      createdAt: now.toISOString(),
      devices: {}, // { web: 'web-xxx', apk: 'apk-yyy' }
      status: 'active'
    };

    if (existingIndex >= 0) {
      // Replace existing
      this.members[existingIndex] = memberData;
    } else {
      this.members.push(memberData);
    }

    this.persist();

    return {
      success: true,
      key: key,
      expiresAt: expiresAt.toISOString(),
      accessType: accessType,
      days: days
    };
  }

  /**
   * Validate key-only login
   * @param {string} key - Access key
   * @param {string} deviceId - Device ID (prefixed with 'web-' or 'apk-')
   * @returns {Object} - { success, member } or { success, error }
   */
  validateLogin(key, deviceId) {
    if (!key || !deviceId) {
      return { success: false, error: 'Key dan Device ID diperlukan' };
    }

    const member = this.members.find(m => m.key === key);

    if (!member) {
      return { success: false, error: 'Key tidak valid' };
    }

    // Check expiration
    const expiresAt = new Date(member.expiresAt);
    if (expiresAt < new Date()) {
      return { success: false, error: 'Key sudah expired' };
    }

    // Check access type
    const isWebDevice = deviceId.startsWith('web-');
    const accessType = member.accessType || 'all';

    if (isWebDevice && accessType === 'bot') {
      return { success: false, error: 'Key ini hanya untuk akses Bot' };
    }

    // Determine device type
    const deviceType = isWebDevice ? 'web' : 'apk';

    // Check if device slot taken by different device
    if (member.devices[deviceType] && member.devices[deviceType] !== deviceId) {
      return {
        success: false,
        error: `Sudah login di ${deviceType === 'web' ? 'browser' : 'perangkat'} lain`
      };
    }

    // Bind device
    member.devices[deviceType] = deviceId;
    this.persist();

    return {
      success: true,
      member: {
        id: member.id,
        telegramId: member.telegramId,
        username: member.username,
        accessType: member.accessType,
        expiresAt: member.expiresAt
      }
    };
  }

  /**
   * Verify session
   * @param {string} key - Access key
   * @param {string} deviceId - Device ID
   * @returns {Object} - { valid, member } or { valid, error }
   */
  verifySession(key, deviceId) {
    if (!key || !deviceId) {
      return { valid: false, error: 'Key dan Device ID diperlukan' };
    }

    const member = this.members.find(m => m.key === key);

    if (!member) {
      return { valid: false, error: 'Key tidak valid' };
    }

    // Check expiration
    const expiresAt = new Date(member.expiresAt);
    if (expiresAt < new Date()) {
      return { valid: false, error: 'Key expired' };
    }

    // Check device
    const isWebDevice = deviceId.startsWith('web-');
    const deviceType = isWebDevice ? 'web' : 'apk';

    if (member.devices[deviceType] !== deviceId) {
      return { valid: false, error: 'Device tidak cocok' };
    }

    // Check access type
    const accessType = member.accessType || 'all';
    if (isWebDevice && accessType === 'bot') {
      return { valid: false, error: 'Akses web tidak diizinkan' };
    }

    return {
      valid: true,
      member: {
        id: member.id,
        telegramId: member.telegramId,
        username: member.username,
        accessType: member.accessType,
        expiresAt: member.expiresAt
      }
    };
  }

  /**
   * Logout - clear device binding
   */
  logout(key, deviceId) {
    if (!key || !deviceId) {
      return { success: false, error: 'Key dan Device ID diperlukan' };
    }

    const member = this.members.find(m => m.key === key);
    if (!member) {
      return { success: false, error: 'Key tidak valid' };
    }

    const isWebDevice = deviceId.startsWith('web-');
    const deviceType = isWebDevice ? 'web' : 'apk';

    if (member.devices[deviceType] !== deviceId) {
      return { success: false, error: 'Device tidak cocok' };
    }

    delete member.devices[deviceType];
    this.persist();

    return { success: true };
  }

  /**
   * Extend key expiration
   */
  extendKey(key, days) {
    if (!key || !days || days < 1) {
      return { success: false, error: 'Key dan hari minimal 1 diperlukan' };
    }

    const member = this.members.find(m => m.key === key);
    if (!member) {
      return { success: false, error: 'Key tidak ditemukan' };
    }

    const currentExpires = new Date(member.expiresAt);
    const now = new Date();
    const baseDate = currentExpires < now ? now : currentExpires;
    const newExpires = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);

    member.expiresAt = newExpires.toISOString();
    this.persist();

    return {
      success: true,
      newExpiresAt: newExpires.toISOString(),
      addedDays: days
    };
  }

  /**
   * Delete key
   */
  deleteKey(key) {
    const index = this.members.findIndex(m => m.key === key);
    if (index === -1) {
      return { success: false, error: 'Key tidak ditemukan' };
    }

    this.members.splice(index, 1);
    this.persist();

    return { success: true };
  }

  /**
   * Get member by key
   */
  getMemberByKey(key) {
    return this.members.find(m => m.key === key) || null;
  }

  /**
   * Get member by Telegram ID
   */
  getMemberByTelegramId(telegramId) {
    const now = new Date();
    return this.members.find(
      m => m.telegramId === String(telegramId) && new Date(m.expiresAt) > now
    ) || null;
  }

  /**
   * List all members
   */
  listMembers() {
    const now = new Date();
    return this.members.map(m => {
      const expiresAt = new Date(m.expiresAt);
      const isExpired = expiresAt < now;
      const daysLeft = isExpired ? 0 : Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000));

      return {
        id: m.id,
        telegramId: m.telegramId,
        username: m.username,
        key: m.key,
        accessType: m.accessType,
        expiresAt: m.expiresAt,
        isExpired,
        daysLeft,
        devices: m.devices
      };
    });
  }

  /**
   * Check if Telegram user has valid access
   */
  isAuthorized(telegramId) {
    const now = new Date();
    return this.members.some(m => {
      if (m.telegramId !== String(telegramId)) return false;
      if (new Date(m.expiresAt) < now) return false;
      const accessType = m.accessType || 'all';
      return accessType !== 'web'; // Web-only can't access bot
    });
  }

  /**
   * Cleanup expired keys
   */
  cleanupExpired() {
    const now = new Date();
    const initialCount = this.members.length;

    this.members = this.members.filter(m => new Date(m.expiresAt) > now);

    const removed = initialCount - this.members.length;
    if (removed > 0) {
      this.persist();
      console.log(`🧹 Cleaned up ${removed} expired access keys`);
    }

    return removed;
  }
}

module.exports = new AccessKeyService();
