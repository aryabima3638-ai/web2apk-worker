const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const config = require('../../../config');
const ownerService = require('../../utils/ownerService');
const db = require('../../db');
const pool = require('../../../worker/pool');
const { sendBuildStart } = require('../../utils/progressUI');
const accessKeyService = require('../../utils/accessKeyService');
const session = require('../../session/state');

// Pre-download directory for ZIP files
const ZIP_CACHE_DIR = path.join(os.tmpdir(), 'web2apk-v2-zip-cache');

function isAdminUser(userId) {
  return ownerService.isAdmin(userId);
}

/**
 * Pre-download ZIP immediately when received
 * This ensures the file is available regardless of which worker handles the build
 */
async function preDownloadZip(bot, fileId, jobTag, originalFileSize) {
  const maxAttempts = 2;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.ensureDir(ZIP_CACHE_DIR);
      const downloadedPath = await bot.downloadFile(fileId, ZIP_CACHE_DIR);
      
      if (!downloadedPath || !await fs.pathExists(downloadedPath)) {
        console.warn(`[ZipToApk] Attempt ${attempt}: Pre-download returned but file not found`);
        if (attempt < maxAttempts) continue;
        return null;
      }
      
      const stat = await fs.stat(downloadedPath);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
      
      // Verify file size matches expected (if provided)
      if (originalFileSize && stat.size !== originalFileSize) {
        console.warn(`[ZipToApk] Attempt ${attempt}: Size mismatch expected=${originalFileSize}, got=${stat.size}`);
        await fs.remove(downloadedPath).catch(() => {});
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return null;
      }
      
      // Verify ZIP integrity using system unzip -t
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      try {
        await execPromise(`unzip -t "${downloadedPath}"`, { timeout: 30000 });
        console.log(`[ZipToApk] ✅ Pre-downloaded ZIP verified (${sizeMb}MB): ${downloadedPath}`);
        return downloadedPath;
      } catch (zipErr) {
        console.warn(`[ZipToApk] Attempt ${attempt}: ZIP integrity check failed: ${zipErr.message}`);
        await fs.remove(downloadedPath).catch(() => {});
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return null;
      }
    } catch (err) {
      console.warn(`[ZipToApk] Pre-download attempt ${attempt} failed (${jobTag}): ${err.message}`);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      // Don't fail here — build will try other download methods later
      return null;
    }
  }
  
  return null;
}

async function zipToApkHandler(bot, msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const document = msg.document;

  if (!document) return;

  // 1. Validation
  if (!document.file_name.endsWith('.zip')) {
    return bot.sendMessage(chatId, '<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> File harus berupa .zip.', { parse_mode: 'HTML' });
  }

  const maxMb = config.build.maxFileSizeMb;
  if (document.file_size > maxMb * 1024 * 1024) {
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084880262179588505">❌</tg-emoji> Ukuran file maksimal adalah ${maxMb}MB.`, { parse_mode: 'HTML' });
  }

  // 3. Pre-download ZIP immediately while file_id is fresh
  // This downloads through the bot's API connection (Local API if available)
  // File is saved to local disk so ANY worker can receive it via SSH later
  const preDownloadedPath = await preDownloadZip(bot, document.file_id, `${userId}-${document.file_name}`, document.file_size);

  // 4. Store ZIP info in session and ask for build type
  const appName = document.file_name.replace('.zip', '');
  
  session.set(userId, {
    type: 'zip_to_apk',
    step: 'build_type',
    fileId: document.file_id,
    fileName: document.file_name,
    appName: appName,
    chatId: chatId,
    localFilePath: preDownloadedPath || null, // Pre-downloaded path (if available)
    userFirstName: msg.from.first_name,
    userLastName: msg.from.last_name,
    userUsername: msg.from.username
  });

  // Calculate file size for display
  const fileSizeMb = (document.file_size / (1024 * 1024)).toFixed(2);
  const cacheStatus = preDownloadedPath ? '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Tersimpan di cache' : '<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Akan di-download saat build';
  
  // Ask for build type (debug/release)
  return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <b>Build dari ZIP</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> File: <b>${document.file_name}</b>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Size: <code>${fileSizeMb} MB</code>
<tg-emoji emoji-id="5345987742276797245">📁</tg-emoji> Project: <code>${appName}</code>
${cacheStatus}

<b>Pilih tipe build:</b>

<tg-emoji emoji-id="5188481279963715781">🚀</tg-emoji> <b>Release</b> - Optimized, smaller size
<tg-emoji emoji-id="5199544484358013013">🐛</tg-emoji> <b>Debug</b> - For testing only
  `.trim(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Release', icon_custom_emoji_id: "5188481279963715781", callback_data: 'zip_build_release' },
          { text: 'Debug', icon_custom_emoji_id: "5456140674028019486", callback_data: 'zip_build_debug' }
        ],
        [{ text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'cancel_build' }]
      ]
    }
  });
}

module.exports = zipToApkHandler;
