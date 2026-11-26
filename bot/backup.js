const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../config');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getBackupRoot() {
  return path.resolve(__dirname, '..', 'backups');
}

function getTodayDir() {
  return path.join(getBackupRoot(), formatDateKey(new Date()));
}

function getSentMarkerPath(outDir) {
  return path.join(outDir, '.sent');
}

function listBackupDirs() {
  const root = getBackupRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map(name => ({ name, full: path.join(root, name) }))
    .filter(entry => fs.existsSync(entry.full) && fs.statSync(entry.full).isDirectory())
    .map(entry => entry.name)
    .sort();
}

async function createBackup(logger) {
  const outDir = getTodayDir();
  await fs.ensureDir(outDir);

  // Full project backup with exclusions
  const projectRoot = path.resolve(__dirname, '..');
  
  // Folders/files to exclude from backup
  const excludePatterns = [
    'node_modules',
    'package-lock.json',
    'backups',
    '.git',
    'build',
    'dist',
    'temp',
    'tmp',
    '.cache',
    '.npm',
    '*.log',
    'bot.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'yarn-error.log*',
    '.env',
    '.env.local',
    '.DS_Store',
    'Thumbs.db',
    '*.zip',           // Exclude any zip files
    '2026-*',          // Exclude date folders (old backups)
    '2025-*',          // Exclude date folders (old backups)
    '2027-*',          // Exclude date folders (future backups)
    // IMPORTANT: config.js and database/ MUST be backed up (core data)
  ];

  const copied = [];
  
  // Helper to check if path should be excluded
  const shouldExclude = (itemPath) => {
    const relativePath = path.relative(projectRoot, itemPath);
    const basename = path.basename(itemPath);
    
    for (const pattern of excludePatterns) {
      // Check exact match
      if (basename === pattern) return true;
      // Check if path contains pattern
      if (relativePath.includes(pattern)) return true;
      // Check glob patterns: *.log (ends with)
      if (pattern.startsWith('*') && !pattern.endsWith('*') && basename.endsWith(pattern.slice(1))) return true;
      // Check glob patterns: 2026-* (starts with)
      if (pattern.endsWith('*') && !pattern.startsWith('*') && basename.startsWith(pattern.slice(0, -1))) return true;
      // Check glob patterns: *zip* (contains)
      if (pattern.startsWith('*') && pattern.endsWith('*') && basename.includes(pattern.slice(1, -1))) return true;
    }
    return false;
  };

  // Recursive copy function
  async function copyRecursive(src, dest) {
    const stat = await fs.stat(src);
    
    if (shouldExclude(src)) {
      return;
    }
    
    if (stat.isDirectory()) {
      await fs.ensureDir(dest);
      const items = await fs.readdir(src);
      for (const item of items) {
        await copyRecursive(path.join(src, item), path.join(dest, item));
      }
    } else {
      await fs.copy(src, dest, { overwrite: true });
      copied.push(path.relative(projectRoot, dest));
    }
  }

  try {
    await copyRecursive(projectRoot, outDir);
  } catch (error) {
    if (logger) logger.warn(`Backup copy error: ${error.message}`);
  }

  if (logger) {
    logger.info(`Backup dibuat: ${outDir} (${copied.length} file/folder)`);
  }

  return { outDir, copied };
}

async function sendBackupToTelegram(bot, logger, outDir, copied) {
  // CRITICAL: Focus ONLY on the first admin ID (index 0)
  const adminIds = Array.isArray(config.telegram.adminIds) ? config.telegram.adminIds : [];
  const primaryAdminId = adminIds.length > 0 ? adminIds[0] : null;

  if (!bot || !primaryAdminId) {
    if (logger) logger.warn('[Backup] Missing bot instance or primary admin ID. Skip sending.');
    return { sent: false, reason: 'missing_bot_or_admin' };
  }

  const markerPath = getSentMarkerPath(outDir);
  if (await fs.pathExists(markerPath)) return { sent: false, reason: 'already_sent' };

  const zip = new AdmZip();
  zip.addLocalFolder(outDir);

  const zipPath = path.join(getBackupRoot(), `${path.basename(outDir)}.zip`);
  zip.writeZip(zipPath);

  const sizeMB = (await fs.stat(zipPath)).size / (1024 * 1024);
  
  // Check what's backed up
  const hasConfig = copied.some(p => p.includes('config.js'));
  const hasDatabase = copied.some(p => p.includes('database'));
  const hasBot = copied.some(p => p.includes('bot'));
  const hasWorker = copied.some(p => p.includes('worker'));
  const hasAssets = copied.some(p => p.includes('assets'));
  
  const backupInfo = `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Backup harian full project

<tg-emoji emoji-id="5413879192267805083">📅</tg-emoji> Tanggal: ${path.basename(outDir)}
<tg-emoji emoji-id="5345987742276797245">📁</tg-emoji> File: ${copied.length} item
<tg-emoji emoji-id="5462956611033117422">💾</tg-emoji> Size: ${sizeMB.toFixed(2)} MB

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Config: ${hasConfig ? '✓' : '✗'}
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Database: ${hasDatabase ? '✓' : '✗'}
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Bot: ${hasBot ? '✓' : '✗'}
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Worker: ${hasWorker ? '✓' : '✗'}
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Assets: ${hasAssets ? '✓' : '✗'}

<i>Exclude: node_modules, .git, backups, logs</i>`;

  try {
    await bot.sendDocument(primaryAdminId, zipPath, { caption: backupInfo, parse_mode: 'HTML' });
    await fs.writeFile(markerPath, new Date().toISOString(), 'utf8');
    if (logger) logger.info(`[Backup] Success sending backup to primary admin: ${primaryAdminId}`);
    return { sent: true };
  } catch (error) {
    if (logger) logger.warn(`[Backup] Failed to send backup to admin: ${error?.message || error}`);
    return { sent: false, reason: 'send_failed' };
  } finally {
    await fs.remove(zipPath).catch(() => {});
  }
}

async function rotateBackups(logger, keepDays = 7) {
  const dirs = listBackupDirs();
  if (dirs.length <= keepDays) return;
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - keepDays));
  const root = getBackupRoot();
  for (const name of toDelete) {
    const full = path.join(root, name);
    await fs.remove(full);
    if (logger) logger.info(`Backup lama dihapus: ${full}`);
  }
}

function msUntilNextDaily(hour = 3, minute = 0) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function ensureDailyBackup(logger, bot) {
  const today = getTodayDir();
  let created = null;
  if (!await fs.pathExists(today)) {
    created = await createBackup(logger);
  } else {
    created = { outDir: today, copied: [] };
  }
  await sendBackupToTelegram(bot, logger, created.outDir, created.copied);
  await rotateBackups(logger, 7);
}

function start(logger, bot) {
  ensureDailyBackup(logger, bot).catch(() => {});

  const delay = msUntilNextDaily(3, 0);
  setTimeout(() => {
    ensureDailyBackup(logger, bot).catch(() => {});
    setInterval(() => {
      ensureDailyBackup(logger, bot).catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

module.exports = { start, createBackup, rotateBackups };
