const { NodeSSH } = require('node-ssh');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const FormData = require('form-data');
const { execSync } = require('child_process');
const { Readable } = require('stream');
const config = require('../config');
const db = require('../bot/db');
const pool = require('./pool');
const flutterPipeline = require('./pipeline/flutter');
const androidPipeline = require('./pipeline/android');
const projectPrep = require('./projectPrep');
const { updateBuildProgress, sendBuildComplete } = require('../bot/utils/progressUI');
const { notifyBuildChannel } = require('../bot/utils/buildChannelNotify');
const jobRegistry = require('./jobRegistry');

// Sentinel error, shared from jobRegistry.js (see comment there for why
// this MUST be the single shared class rather than a local copy) — used to
// unwind out of the try block below the moment a cancellation is detected,
// without it being misreported as a genuine build failure (different
// message + no error-log file sent to the user).
const { CancelledError } = jobRegistry;

class VpsWorker {
  sanitizeFileName(value, fallback = 'app-release.apk') {
    const safe = String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || fallback;
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Check local disk space (bot server side)
   * Returns free space in MB
   */
  getLocalFreeSpaceMb() {
    try {
      if (process.platform === 'win32') {
        const output = execSync('wmic logicaldisk get size,freespace,caption').toString();
        const lines = output.trim().split('\n');
        const drive = process.cwd().split(':')[0].toUpperCase();
        for (const line of lines) {
          if (line.includes(drive)) {
            const parts = line.trim().split(/\s+/);
            const free = parseInt(parts[1], 10);
            return Math.floor(free / (1024 * 1024));
          }
        }
      } else {
        const output = execSync('df -m .').toString();
        const lines = output.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].trim().split(/\s+/);
          return parseInt(parts[3], 10);
        }
      }
    } catch (e) {
      console.error('[VpsWorker] Failed to check local disk space:', e.message);
    }
    return 1024;
  }

  /**
   * Send document directly from VPS worker using curl (no file transfer to bot server)
   * This is the most efficient method - file stays on VPS and is sent directly
   */
  async sendDocumentFromWorker(ssh, remoteFilePath, chatId, botToken, localApiUrl, caption, filename) {
    if (!localApiUrl) {
      throw new Error('Local Bot API URL not configured for this worker');
    }

    const url = `${localApiUrl}/bot${botToken}/sendDocument`;
    console.log(`[VpsWorker] Sending directly from worker via curl: ${url}`);

    // Write caption to a temp file on VPS to preserve newlines and HTML tags
    // Using heredoc avoids all shell escaping issues with special characters
    const captionFile = `/tmp/web2apk-caption-${Date.now()}.txt`;
    const writeCaption = await ssh.execCommand(
      `cat > "${captionFile}" << 'W2A_CAPTION_EOF'\n${caption}\nW2A_CAPTION_EOF`
    );

    if (writeCaption.code !== 0) {
      console.warn(`[VpsWorker] Failed to write caption file: ${writeCaption.stderr}`);
    }

    // Use curl with caption loaded from file (-F "caption=<file")
    // This preserves actual newlines and HTML tags perfectly
    const cmd = `curl -s -X POST "${url}" \
      -F "chat_id=${chatId}" \
      -F "document=@${remoteFilePath}" \
      -F "caption=<${captionFile}" \
      -F "parse_mode=HTML" \
      -F "disable_notification=true" \
      --connect-timeout 60 \
      --max-time 300 \
      -w "\\nHTTP_CODE:%{http_code}"`;

    console.log(`[VpsWorker] Executing curl command on worker...`);
    const result = await ssh.execCommand(cmd);

    // Cleanup temp caption file
    await ssh.execCommand(`rm -f "${captionFile}"`).catch(() => {});

    console.log(`[VpsWorker] Curl stdout: ${result.stdout.substring(0, 500)}...`);
    if (result.stderr) {
      console.warn(`[VpsWorker] Curl stderr: ${result.stderr.substring(0, 500)}`);
    }

    // Check HTTP response code
    const httpCodeMatch = result.stdout.match(/HTTP_CODE:(\d+)/);
    const httpCode = httpCodeMatch ? parseInt(httpCodeMatch[1], 10) : 0;

    if (httpCode === 200) {
      console.log(`[VpsWorker] File sent successfully from worker (HTTP 200)`);
      return true;
    } else {
      throw new Error(`Worker send failed with HTTP ${httpCode}. Response: ${result.stdout.substring(0, 200)}`);
    }
  }

  /**
   * Send document directly to a chat via Local Bot API (supports files up to 2GB)
   */
  async sendDocumentViaLocalApi(localFilePath, chatId, botToken, localApiUrl, caption, filename) {
    if (!localApiUrl) {
      throw new Error('Local Bot API URL not configured for this worker');
    }
    
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', fs.createReadStream(localFilePath), {
      filename: filename || path.basename(localFilePath),
      contentType: 'application/vnd.android.package-archive'
    });
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }
    
    const url = `${localApiUrl}/bot${botToken}/sendDocument`;
    console.log(`[VpsWorker] Sending file via Local Bot API: ${url}`);
    
    try {
      const response = await axios.post(url, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 300000 // 5 minutes
      });
      
      if (response.data && response.data.ok) {
        console.log(`[VpsWorker] File sent successfully via Local Bot API`);
        return response.data;
      }
      throw new Error(`Local API responded but not OK: ${JSON.stringify(response.data)}`);
    } catch (err) {
      console.error('[VpsWorker] Send via Local API failed:', err.message);
      if (err.response?.data) {
        console.error('[VpsWorker] Local API error details:', JSON.stringify(err.response.data));
      }
      throw err;
    }
  }

  /**
   * Create a readable stream from SSH command output (streaming from VPS)
   */
  createSshStream(ssh, remotePath, fileSize) {
    let buffer = Buffer.alloc(0);
    const chunkSize = 64 * 1024; // 64KB chunks
    let position = 0;
    let isReading = false;

    const stream = new Readable({
      read() {
        if (isReading || position >= fileSize) return;
        isReading = true;

        const remaining = fileSize - position;
        const toRead = Math.min(chunkSize, remaining);

        // Use dd to read specific chunk from file
        const cmd = `dd if="${remotePath}" bs=1 skip=${position} count=${toRead} 2>/dev/null | base64`;
        
        ssh.execCommand(cmd).then(result => {
          isReading = false;
          if (result.code !== 0) {
            stream.destroy(new Error(`Failed to read file chunk: ${result.stderr}`));
            return;
          }

          const chunk = Buffer.from(result.stdout.trim(), 'base64');
          if (chunk.length === 0) {
            // End of file or error
            stream.push(null);
            return;
          }

          position += chunk.length;
          stream.push(chunk);

          // If we've reached the end
          if (position >= fileSize) {
            stream.push(null);
          }
        }).catch(err => {
          isReading = false;
          stream.destroy(err);
        });
      }
    });

    return stream;
  }

  /**
   * Alternative: Use cat with streaming for smaller files
   */
  async sendBuiltApk(ssh, chatId, appName, jobId, remoteApkPath, sourceUrl = '', localApiUrl = null) {
    if (!chatId || !global.bot) {
      throw new Error('chatId/bot tidak tersedia untuk kirim APK');
    }
    if (!remoteApkPath) {
      throw new Error('Path APK hasil build kosong');
    }

    const apkName = this.sanitizeFileName(`${appName || 'app'}-${jobId}.apk`);

    // Check if remote file exists and get size
    const checkFileCmd = await ssh.execCommand(`test -f "${remoteApkPath}" && stat -c%s "${remoteApkPath}" || echo "NOT_FOUND"`);
    if (checkFileCmd.stdout.trim() === 'NOT_FOUND') {
      throw new Error(`APK file not found at worker: ${remoteApkPath}`);
    }

    const fileSize = parseInt(checkFileCmd.stdout.trim(), 10);
    const sizeMb = (fileSize / (1024 * 1024)).toFixed(2);

    console.log(`[VpsWorker] Streaming APK from VPS: ${remoteApkPath} (${sizeMb}MB)`);

    const safeAppName = this.escapeHtml(appName || 'My App');
    const safeUrl = this.escapeHtml(sourceUrl);

    const caption = [
      `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>${safeAppName}</b>`,
      '',
      safeUrl ? `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <code>${safeUrl}</code>` : null,
      `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <code>${sizeMb} MB</code>`,
      '',
      '<i>Generated by Web2Apk Bot</i>'
    ].filter(Boolean).join('\n');

    const MAX_PUBLIC_API_SIZE = 50 * 1024 * 1024; // 50MB

    const publicLocalApiUrl = localApiUrl || config.telegram?.localApiUrl || null;
    const workerApiPort = Number.parseInt(String(publicLocalApiUrl || '').match(/:(\d+)(?:\/|$)/)?.[1] || '8081', 10);
    const workerLoopbackApiUrl = `http://127.0.0.1:${workerApiPort > 0 ? workerApiPort : 8081}`;

    // METHOD 1: Send directly from worker using loopback Local Bot API.
    // Never use the VPS public IP for the worker->itself request; some VPS
    // firewalls/NAT setups reject hairpin connections even though localhost works.

    // File stays on VPS, no transfer to bot server needed
    if (publicLocalApiUrl) {
      try {
        console.log(`[VpsWorker] Attempting direct send from worker via Local API (${sizeMb}MB)...`);
        const botToken = config.telegram.botToken;
        await this.sendDocumentFromWorker(ssh, remoteApkPath, chatId, botToken, workerLoopbackApiUrl, caption, apkName);
        console.log(`[VpsWorker] APK sent successfully directly from worker: ${jobId}`);

        // Send follow-up message via bot
        await global.bot.sendMessage(
          chatId,
          `<tg-emoji emoji-id="5235711785482341993">🎉</tg-emoji> <b>APK berhasil dikirim!</b>\n\nIngin membuat APK lagi?`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: 'URL to APK', icon_custom_emoji_id: '5447410659077661506', callback_data: 'url_to_apk' },
                  { text: 'ZIP to APK', icon_custom_emoji_id: '5463172695132745432', callback_data: 'zip_to_apk' }
                ],
                [
                  { text: 'Menu Utama', icon_custom_emoji_id: '5471946394195470414', callback_data: 'main_menu' }
                ]
              ]
            }
          }
        );
        return; // Success - no need for other methods
      } catch (directSendErr) {
        console.warn(`[VpsWorker] Direct send from worker failed: ${directSendErr.message}`);
        console.log(`[VpsWorker] Falling back to streaming method...`);
      }
    }

    // METHOD 2: For large files with local API - download temporarily to bot server
    if (fileSize > MAX_PUBLIC_API_SIZE && publicLocalApiUrl) {
      // Check local disk space before download
      const freeSpaceMb = this.getLocalFreeSpaceMb();
      console.log(`[VpsWorker] Local free space: ${freeSpaceMb}MB`);

      // Only download if we have enough space (1.5x file size for safety)
      if (freeSpaceMb > (fileSize / (1024 * 1024)) * 1.5 + 200) {
        const tempDir = path.join(os.tmpdir(), 'web2apk-v2-delivery');
        const localApkPath = path.join(tempDir, apkName);

        try {
          await fs.ensureDir(tempDir);
          await ssh.getFile(localApkPath, remoteApkPath);

          console.log(`[VpsWorker] File ${sizeMb}MB > 50MB, sending via Local Bot API: ${publicLocalApiUrl}`);
          const botToken = config.telegram.botToken;
          await this.sendDocumentViaLocalApi(localApkPath, chatId, botToken, publicLocalApiUrl, caption, apkName);
          console.log(`[VpsWorker] Large APK sent successfully via Local API`);
          return;
        } catch (localApiErr) {
          console.warn(`[VpsWorker] Local API send failed: ${localApiErr.message}`);
          // Continue to streaming fallback
        } finally {
          await fs.remove(localApkPath).catch(() => {});
        }
      } else {
        console.warn(`[VpsWorker] Insufficient local disk space for large file download: ${freeSpaceMb}MB available`);
      }
    }

    // For files > 50MB without local API - error
    if (fileSize > MAX_PUBLIC_API_SIZE && !publicLocalApiUrl) {
      throw new Error(`File ${sizeMb}MB terlalu besar untuk dikirim via Telegram API publik (max 50MB). Silakan setup Local Bot API.`);
    }

    // METHOD 3: STREAMING for files <= 50MB (fallback)
    console.log(`[VpsWorker] Using streaming method for ${sizeMb}MB file`);

    try {
      // Create a temporary buffer-based stream
      const chunks = [];
      const chunkSize = 256 * 1024; // 256KB chunks
      let position = 0;

      // Read file in chunks via SSH
      while (position < fileSize) {
        const remaining = fileSize - position;
        const toRead = Math.min(chunkSize, remaining);

        const cmd = `dd if="${remoteApkPath}" bs=1 skip=${position} count=${toRead} 2>/dev/null | base64`;
        const result = await ssh.execCommand(cmd);

        if (result.code !== 0) {
          throw new Error(`Failed to read file chunk at position ${position}: ${result.stderr}`);
        }

        const chunk = Buffer.from(result.stdout.trim(), 'base64');
        if (chunk.length === 0) {
          break;
        }

        chunks.push(chunk);
        position += chunk.length;

        // Log progress for large files
        if (position % (5 * 1024 * 1024) === 0 || position >= fileSize) {
          const progress = ((position / fileSize) * 100).toFixed(1);
          console.log(`[VpsWorker] Streaming progress: ${progress}% (${(position / (1024 * 1024)).toFixed(2)}MB / ${sizeMb}MB)`);
        }
      }

      // Combine all chunks into a single buffer
      const fileBuffer = Buffer.concat(chunks);
      console.log(`[VpsWorker] File loaded into memory: ${(fileBuffer.length / (1024 * 1024)).toFixed(2)}MB`);

      // Send via Telegram Bot API using buffer
      await global.bot.sendDocument(chatId, fileBuffer, { caption, parse_mode: 'HTML' }, { filename: apkName, contentType: 'application/vnd.android.package-archive' });

      console.log(`[VpsWorker] APK sent successfully via streaming: ${jobId}`);

      // Send follow-up message
      await global.bot.sendMessage(
        chatId,
        `<tg-emoji emoji-id="5235711785482341993">🎉</tg-emoji> <b>APK berhasil dikirim!</b>\n\nIngin membuat APK lagi?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: 'URL to APK', icon_custom_emoji_id: '5447410659077661506', callback_data: 'url_to_apk' },
                { text: 'ZIP to APK', icon_custom_emoji_id: '5463172695132745432', callback_data: 'zip_to_apk' }
              ],
              [
                { text: 'Menu Utama', icon_custom_emoji_id: '5471946394195470414', callback_data: 'main_menu' }
              ]
            ]
          }
        }
      );
    } catch (err) {
      console.error(`[VpsWorker] Streaming send failed: ${err.message}`);
      throw err;
    }
  }

  async sendErrorLog(chatId, appName, jobId, title, body, caption) {
    if (!chatId || !global.bot) return;

    const errorLogContent = `
${title}
-----------------------------
Job ID: ${jobId}
App Name: ${appName}
Time: ${new Date().toISOString()}
-----------------------------

${body}
    `.trim();
    const tempDir = path.join(os.tmpdir(), 'web2apk-v2-errors');
    const errorFile = path.join(tempDir, `build-error-${this.sanitizeFileName(jobId, 'job')}.txt`);

    try {
      await fs.ensureDir(tempDir);
      await fs.writeFile(errorFile, errorLogContent, 'utf8');
      await global.bot.sendDocument(
        chatId,
        errorFile,
        { caption },
        {
          filename: `build-error-${jobId}.txt`,
          contentType: 'text/plain'
        }
      );
    } catch (err) {
      console.error('[VpsWorker] Failed to send error log:', err.message);
      try {
        await global.bot.sendMessage(
          chatId,
          `❌ Build gagal untuk "${appName}".\n\nError: ${String(body || '').slice(0, 700)}`
        );
      } catch (_) {}
    } finally {
      await fs.remove(errorFile).catch(() => {});
    }
  }

  /**
   * Comprehensive cleanup and health check on worker before build starts
   */
  async preBuildCleanup(ssh, worker, jobId) {
    const buildDir = worker.buildDir || config.workers.defaultBuildDir;

    console.log(`[${jobId}] Performing pre-build cleanup on worker: ${worker.id}`);

    const cleanupScript = `
set +e
BUILD_ROOT='${buildDir.replace(/'/g, "'\"'\"'")}'

# 1. Remove orphaned build directories older than 30 minutes (more aggressive)
if [ -d "$BUILD_ROOT" ]; then
  find "$BUILD_ROOT" -maxdepth 1 -type d -mmin +30 -name "job-*" -exec rm -rf {} + 2>/dev/null
  echo "Cleaned old build directories (older than 30min)"
fi

# 2. Cleanup common junk
rm -rf /tmp/web2apk-* 2>/dev/null
rm -f /tmp/*.zip 2>/dev/null
rm -rf /opt/web2apk/builds/*/build 2>/dev/null
rm -rf /opt/web2apk/builds/*/.dart_tool 2>/dev/null
rm -rf /opt/web2apk/builds/*/.gradle 2>/dev/null

# 3. Clean Flutter cache if disk is low
rm -rf ~/.pub-cache/.cache 2>/dev/null

# 4. Check disk space with error handling
if [ -d "$BUILD_ROOT" ]; then
  AVAILABLE_MB=$(df -m "$BUILD_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
else
  AVAILABLE_MB=0
fi
# Default to 0 if df failed or empty
if [ -z "$AVAILABLE_MB" ] || [ "$AVAILABLE_MB" = "" ]; then
  AVAILABLE_MB=0
fi
echo "DISK_FREE_MB:$AVAILABLE_MB"

# 5. Try to free up space if below 3GB (more aggressive threshold)
# Only run if AVAILABLE_MB is a valid number
if [ -n "$AVAILABLE_MB" ] && [ "$AVAILABLE_MB" -gt 0 ] && [ "$AVAILABLE_MB" -lt 3072 ] 2>/dev/null; then
  echo "Low disk space detected ($AVAILABLE_MB MB), running deep cleanup..."
  # Remove all build directories older than 10 minutes
  find "$BUILD_ROOT" -maxdepth 1 -type d -mmin +10 -name "job-*" -exec rm -rf {} + 2>/dev/null
  # Clean Gradle cache
  rm -rf ~/.gradle/caches 2>/dev/null
  # Clean Flutter pub cache
  rm -rf ~/.pub-cache/hosted 2>/dev/null
fi
    `.trim();

    try {
      const result = await ssh.execCommand(`bash -lc '${cleanupScript.replace(/'/g, "'\"'\"'")}'`);
      const output = result.stdout || '';

      const match = output.match(/DISK_FREE_MB:(\d+)/);
      const freeMb = match ? parseInt(match[1], 10) : 0;

      console.log(`[${jobId}] Worker free space: ${freeMb}MB`);

      if (freeMb > 0 && freeMb < 2048) {
        throw new Error(`Worker disk space too low: ${freeMb}MB available (min 2GB required)`);
      }

      return { success: true, freeMb };
    } catch (e) {
      console.warn(`[${jobId}] Pre-build cleanup warning: ${e.message}`);
      if (e.message.includes('too low')) throw e;
      return { success: false, error: e.message };
    }
  }

  async execute(worker, job) {
    const ssh = new NodeSSH();
    const startedAtMs = Date.now();
    const BUILD_TIMEOUT_MS = config.workers?.buildTimeoutMs || (30 * 60 * 1000); // 30 minutes default

    let currentProgress = 0;
    let targetProgress = 0;
    let progressStatus = 'Menyiapkan build...';
    let progressTimer = null;
    let progressUpdateInFlight = false;
    let timeoutHandle = null;
    let buildTimedOut = false;
    const chatId = job.chatId;
    const messageId = job.progressMessageId;
    const appName = job.payload?.appName || job.appName || 'My App';
    const workerAlias = worker.alias || worker.id;

    const publishProgress = async (force = false) => {
      if (!chatId || !messageId || progressUpdateInFlight) return;
      // Once a cancellation has been requested for this job, no further
      // progress edit should ever reach Telegram — the cancel handler in
      // menu.js already owns this message from this point on (it edits it
      // to "BUILD DIBATALKAN"). Any progress update still in flight when
      // the cancel landed must be dropped here rather than sent, or it can
      // land AFTER the cancellation message and visually overwrite it.
      if (job.jobId && jobRegistry.isCancelled(job.jobId)) return;
      if (!force && currentProgress >= targetProgress) return;

      progressUpdateInFlight = true;
      try {
        await updateBuildProgress(global.bot, chatId, messageId, currentProgress, progressStatus, appName, workerAlias, job.jobId);
      } catch (err) {
        console.error('[VpsWorker] Failed to update progress:', err.message);
      } finally {
        progressUpdateInFlight = false;
      }
    };

    const startSmoothProgress = () => {
      if (progressTimer || !chatId || !messageId) return;
      progressTimer = setInterval(async () => {
        // A cancellation can land at any moment between this timer's 1-second
        // ticks — including the instant right after the cancel handler has
        // already edited this same message to show "BUILD DIBATALKAN". Without
        // this check, the next tick would call publishProgress() and silently
        // overwrite that cancellation message with a stale progress bar,
        // making it look like the build "came back to life" even though the
        // remote process was already killed — this was the actual bug behind
        // reports of cancel appearing to work and then the build resuming.
        if (job.jobId && jobRegistry.isCancelled(job.jobId)) {
          clearInterval(progressTimer);
          progressTimer = null;
          return;
        }
        // Never advance while the previous Telegram edit is still in flight;
        // this guarantees the visible percentage cannot skip a number.
        if (currentProgress < targetProgress && !progressUpdateInFlight) {
          currentProgress += 1;
          await publishProgress(true);
        }
      }, 1000);
    };

    const stopSmoothProgress = () => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    };

    const onProgress = async (percent, status) => {
      // Same reasoning as the guard in publishProgress: once cancelled, this
      // job's progress message belongs to the cancel handler. A pipeline
      // command that was already in flight when the kill signal was sent can
      // still call onProgress() one or two more times before it actually
      // dies — those calls must be no-ops, not new targets for the smooth
      // progress timer to chase.
      if (job.jobId && jobRegistry.isCancelled(job.jobId)) return;

      const requested = Math.max(0, Math.min(100, Number(percent) || 0));
      targetProgress = Math.max(targetProgress, requested);
      progressStatus = status || progressStatus;

      // First visible value is 1%, then the ticker advances one point at a time.
      if (currentProgress === 0 && targetProgress > 0) {
        currentProgress = 1;
        await publishProgress(true);
      }
      startSmoothProgress();
      console.log(`[VpsWorker] Job ${job.jobId} - target=${targetProgress}% current=${currentProgress}% - ${progressStatus}`);
    };

    // BUG FIX #3: Build timeout handler
    const startBuildTimeout = () => {
      return setTimeout(async () => {
        buildTimedOut = true;
        console.error(`[VpsWorker] Build timeout reached for job ${job.jobId} after ${BUILD_TIMEOUT_MS}ms`);
        try {
          // Kill any running build processes on worker
          await ssh.execCommand('pkill -9 -f "flutter build" || pkill -9 -f gradle || true');
          console.log(`[VpsWorker] Killed build processes on worker for job ${job.jobId}`);
        } catch (killErr) {
          console.warn(`[VpsWorker] Failed to kill build processes: ${killErr.message}`);
        }
      }, BUILD_TIMEOUT_MS);
    };

    try {
      await onProgress(5, 'Connecting to worker...');

      const connectConfig = {
        host: worker.host,
        username: worker.user,
        timeout: config.workers.sshTimeoutSeconds * 1000
      };

      if (worker.authMethod === 'password' && worker.password) {
        connectConfig.password = worker.password;
      } else if (worker.sshKeyPath) {
        connectConfig.privateKey = worker.sshKeyPath;
      }

      await ssh.connect(connectConfig);
      await onProgress(10, 'Connected to worker, preparing build...');

      // Register this job's live SSH connection so the Telegram "❌ Batal
      // Build" button (handled elsewhere, via jobRegistry.requestCancel)
      // can reach in and actually kill the remote process, not just stop
      // the UI from updating.
      jobRegistry.register(job.jobId, {
        ssh,
        worker,
        chatId,
        messageId,
        userId: job.userId,
        appName,
      });

      // CRITICAL: Pre-build cleanup and disk check
      await this.preBuildCleanup(ssh, worker, job.jobId);

      if (jobRegistry.isCancelled(job.jobId)) {
        throw new CancelledError();
      }

      await db.updateWorkers((workers) => {
        const index = workers.findIndex(w => w.id === worker.id);
        if (index > -1) {
          workers[index].status = 'building';
          return workers;
        }
        return false;
      });

      await onProgress(15, 'Starting build pipeline...');

      // BUG FIX #3: Start build timeout timer
      timeoutHandle = startBuildTimeout();

      const prep = await projectPrep.prepare(ssh, worker, job, onProgress);

      // Check if timed out during prep
      if (buildTimedOut) {
        throw new Error('Build timeout: Persiapan build terlalu lama');
      }
      if (jobRegistry.isCancelled(job.jobId)) {
        throw new CancelledError();
      }

      let result;
      if (!prep.success) {
        result = { success: false, error: prep.error };
      } else {
        if (prep.projectType) job.projectType = prep.projectType;
        if (prep.projectPath) job.projectPath = prep.projectPath;
        if (prep.flutterCmd) job.flutterCmd = prep.flutterCmd;

        const modeLabel = job.projectType === 'android' ? 'Android' : 'Flutter';
        await onProgress(20, `Project ready (${modeLabel}), starting build...`);

        if (job.projectType === 'flutter') {
          result = await flutterPipeline.run(ssh, worker, job, onProgress);
        } else {
          result = await androidPipeline.run(ssh, worker, job, onProgress);
        }
      }

      // BUG FIX #3: Check if build timed out
      if (buildTimedOut) {
        result = { success: false, error: 'Build timeout: Proses build terlalu lama (>30 menit)' };
      }
      if (jobRegistry.isCancelled(job.jobId)) {
        throw new CancelledError();
      }

      // Clear timeout on completion
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }

      if (result.success) {
        await onProgress(100, 'Build complete! Sending APK...');
        // Let the same one-percent ticker advance to 100. Never jump from the
        // current percentage directly to 100.
        while (currentProgress < 100) {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        stopSmoothProgress();
        console.log(`Job ${job.jobId} success:`, result.apkPath);

        const successDurationSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));

        await db.upsertJob(job.userId, job.jobId, {
          status: 'success',
          finishedAt: new Date().toISOString(),
          buildDurationSeconds: successDurationSeconds,
          apkPath: result.apkPath,
          workerId: worker.id
        });

        notifyBuildChannel(global.bot, {
          status: 'success',
          appName,
          url: job.url,
          jobId: job.jobId,
          userId: job.userId,
          userUsername: job.userUsername,
          workerAlias,
          durationSeconds: successDurationSeconds,
        }).catch(() => {});

        if (chatId) {
          try {
            const workerApiUrl = worker.localApiUrl || (worker.host ? `http://${worker.host}:${Number(worker.apiPort) > 0 ? worker.apiPort : 8081}` : null);
            await this.sendBuiltApk(ssh, chatId, appName, job.jobId, result.apkPath, job.url, workerApiUrl);

            // CRITICAL: Cleanup build directory immediately after successful delivery
            console.log(`[${job.jobId}] APK sent successfully, cleaning up build directory...`);
            await this.cleanupBuildDirectory(ssh, job);
          } catch (sendErr) {
            console.error(`[VpsWorker] Failed to send APK for ${job.jobId}:`, sendErr.message);
            await this.sendErrorLog(
              chatId,
              appName,
              job.jobId,
              'BUILD SUCCESS BUT DELIVERY FAILED',
              `Worker: ${workerAlias}\n\nBuild output:\n${result.apkPath}\n\nDelivery error:\n${sendErr.message}`,
              'Build sukses, tapi APK gagal dikirim. Cek error log terlampir.'
            );
          }
        }

        if (chatId && messageId) {
          await sendBuildComplete(global.bot, chatId, messageId, appName, job.url);
        }
      } else {
        stopSmoothProgress();
        progressStatus = `Build failed: ${result.error}`;
        await publishProgress(true);
        console.error(`Job ${job.jobId} failed:`, result.error);

        const failedDurationSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));

        await db.upsertJob(job.userId, job.jobId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          buildDurationSeconds: failedDurationSeconds,
          error: result.error,
          workerId: worker.id
        });

        notifyBuildChannel(global.bot, {
          status: 'failed',
          appName,
          url: job.url,
          jobId: job.jobId,
          userId: job.userId,
          userUsername: job.userUsername,
          workerAlias,
          durationSeconds: failedDurationSeconds,
          error: result.error,
        }).catch(() => {});

        await this.sendErrorLog(
          chatId,
          appName,
          job.jobId,
          'BUILD FAILED - Error Log',
          `Worker: ${workerAlias}\n\nError:\n${result.error}`,
          `Build failed for "${appName}". Error log attached.`
        );
      }
    } catch (error) {
      // A cancellation is not a failure: skip the generic error-log path
      // entirely and let the callback handler (which already edited the
      // message to the "BUILD DIBATALKAN" screen and answered the user)
      // own the user-facing messaging. We only need to persist final state
      // here and let cleanup run normally via `finally`.
      if (error instanceof CancelledError || jobRegistry.isCancelled(job.jobId)) {
        stopSmoothProgress();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        console.log(`Job ${job.jobId} was cancelled by user.`);

        const cancelledDurationSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
        await db.upsertJob(job.userId, job.jobId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          buildDurationSeconds: cancelledDurationSeconds,
          workerId: worker.id
        }).catch(() => {});

        notifyBuildChannel(global.bot, {
          status: 'cancelled',
          appName,
          url: job.url,
          jobId: job.jobId,
          userId: job.userId,
          userUsername: job.userUsername,
          workerAlias,
          durationSeconds: cancelledDurationSeconds,
        }).catch(() => {});
      } else {
      await onProgress(0, `Worker error: ${error.message}`);
      console.error(`Job ${job.jobId} failed on VPS worker:`, error.message);

      const workerErrorDurationSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));

      await db.upsertJob(job.userId, job.jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        buildDurationSeconds: workerErrorDurationSeconds,
        error: `VPS worker failed: ${error.message}`,
        workerId: worker.id
      });

      notifyBuildChannel(global.bot, {
        status: 'failed',
        appName,
        url: job.url,
        jobId: job.jobId,
        userId: job.userId,
        userUsername: job.userUsername,
        workerAlias,
        durationSeconds: workerErrorDurationSeconds,
        error: `VPS worker failed: ${error.message}`,
      }).catch(() => {});

      await this.sendErrorLog(
        chatId,
        appName,
        job.jobId,
        'BUILD FAILED - Worker Error',
        `Worker: ${workerAlias}\n\nError:\nVPS worker failed: ${error.message}`,
        `Build failed - VPS worker error for "${appName}"`
      );
      }
    } finally {
      stopSmoothProgress();
      // BUG FIX #3: Always clear timeout in finally block
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      jobRegistry.unregister(job.jobId);
      await pool.completeJob(worker.id, job.jobId).catch(() => {});
      await this.cleanupBuildDirectory(ssh, job);
      ssh.dispose();
    }
  }

  async cleanupBuildDirectory(ssh, job) {
    const buildDir = `/opt/web2apk/builds/${job.jobId}`;
    const projectPath = job.projectPath || buildDir;
    
    try {
      const cleanupScript = `
set +e
PROJECT_PATH='${projectPath.replace(/'/g, "'\"'\"'")}'
BUILD_DIR='${buildDir.replace(/'/g, "'\"'\"'")}'
if [ -d "$PROJECT_PATH" ]; then rm -rf "$PROJECT_PATH"; fi
if [ -d "$BUILD_DIR" ] && [ "$BUILD_DIR" != "$PROJECT_PATH" ]; then rm -rf "$BUILD_DIR"; fi
rm -f "/tmp/${job.jobId}.zip" 2>/dev/null || true
rm -rf "/tmp/web2apk-${job.jobId}-*" 2>/dev/null || true
exit 0
      `.trim();
      await ssh.execCommand(`bash -lc '${cleanupScript.replace(/'/g, "'\"'\"'")}'`);
    } catch (e) {}
  }
}

module.exports = new VpsWorker();
