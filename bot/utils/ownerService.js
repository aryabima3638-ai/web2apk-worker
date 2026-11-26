/**
 * ownerService.js
 * ─────────────────────────────────────────────────────────────────────────
 * Sumber kebenaran tunggal untuk "siapa saja yang punya akses admin/owner".
 *
 * Owner terdiri dari 2 sumber:
 *  1. Static  -> config.telegram.adminIds (di config.js, tidak bisa dihapus dari bot)
 *  2. Dynamic -> database/owners.json (bisa ditambah/dihapus lewat /addowner & /delowner)
 *
 * Semua file yang tadinya cek admin langsung dari config.telegram.adminIds
 * sekarang tinggal panggil ownerService.isAdmin(userId) supaya owner baru
 * otomatis punya akses yang sama di SELURUH fitur bot.
 */

const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

const OWNERS_FILE = path.join(config.database?.dir || './database', 'owners.json');

function ensureFile() {
  fs.ensureDirSync(path.dirname(OWNERS_FILE));
  if (!fs.existsSync(OWNERS_FILE)) {
    fs.writeJsonSync(OWNERS_FILE, [], { spaces: 2 });
  }
}
ensureFile();

function loadDynamicOwners() {
  try {
    const data = fs.readJsonSync(OWNERS_FILE);
    return Array.isArray(data) ? data : [];
  } catch (error) {
    return [];
  }
}

// entry shape: { id, addedBy, addedAt, note }
let dynamicOwners = loadDynamicOwners();

function persist() {
  fs.writeJsonSync(OWNERS_FILE, dynamicOwners, { spaces: 2 });
}

function getStaticAdminIds() {
  return Array.isArray(config.telegram.adminIds) ? config.telegram.adminIds.map(String) : [];
}

function getDynamicOwnerIds() {
  return dynamicOwners.map(o => String(o.id));
}

function getAllAdminIds() {
  return Array.from(new Set([...getStaticAdminIds(), ...getDynamicOwnerIds()]));
}

function isAdmin(userId) {
  if (userId === undefined || userId === null) return false;
  return getAllAdminIds().includes(String(userId));
}

function isStaticOwner(userId) {
  return getStaticAdminIds().includes(String(userId));
}

function getOwners() {
  const staticList = getStaticAdminIds().map(id => ({
    id, source: 'config', addedBy: null, addedAt: null, note: 'Owner utama (config.js)'
  }));
  const dynamicList = dynamicOwners.map(o => ({ ...o, id: String(o.id), source: 'dynamic' }));
  return [...staticList, ...dynamicList];
}

function addOwner(userId, addedBy, note = null) {
  const id = String(userId).trim();
  if (!/^\d+$/.test(id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (getAllAdminIds().includes(id)) {
    return { ok: false, reason: 'exists' };
  }
  const entry = { id, addedBy: String(addedBy), addedAt: new Date().toISOString(), note };
  dynamicOwners.push(entry);
  persist();
  return { ok: true, entry };
}

function removeOwner(userId) {
  const id = String(userId).trim();
  if (isStaticOwner(id)) {
    return { ok: false, reason: 'static' };
  }
  const before = dynamicOwners.length;
  dynamicOwners = dynamicOwners.filter(o => String(o.id) !== id);
  if (dynamicOwners.length === before) {
    return { ok: false, reason: 'not_found' };
  }
  persist();
  return { ok: true };
}

module.exports = {
  isAdmin,
  isStaticOwner,
  getOwners,
  addOwner,
  removeOwner,
  getAllAdminIds,
};
