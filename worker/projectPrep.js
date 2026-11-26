const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const sharp = require('sharp');
const config = require('../config');
const jobRegistry = require('./jobRegistry');
const { CancelledError } = jobRegistry;

const NATIVE_URL_TEMPLATE_DIR = path.resolve(__dirname, '..', 'assets', 'android-native-template-safe');

function sh(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

// Safely transport multiline shell scripts over SSH without quote parsing bugs.
function bashScriptCommand(script) {
  const encoded = Buffer.from(String(script || ''), 'utf8').toString('base64');
  return `bash -lc "printf %s ${encoded} | base64 -d | bash"`;
}

function sanitizeFileName(fileName) {
  const fallback = 'source.zip';
  return String(fileName || fallback).replace(/[^a-zA-Z0-9._-]/g, '_') || fallback;
}

function sanitizeProjectName(input) {
  let value = String(input || 'web2apk_app')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!value) value = 'web2apk_app';
  if (!/^[a-z]/.test(value)) value = `app_${value}`;
  if (value.length < 3) value = `${value}_app`;
  return value.slice(0, 30);
}

function escapeDart(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatExecError(result, fallbackMessage) {
  const details = [result?.stderr, result?.stdout].filter(Boolean).join('\n').trim();
  if (!details) return fallbackMessage;
  return `${fallbackMessage}: ${details}`;
}

async function downloadToFile(url, destinationPath) {
  await fs.ensureDir(path.dirname(destinationPath));
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: 120000
  });

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destinationPath);
    response.data.pipe(writeStream);
    response.data.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
  });
}

async function getTelegramFileUrls(fileId) {
  if (!fileId) throw new Error('fileId Telegram tidak ditemukan pada job');
  const urls = [];
  const token = config?.telegram?.botToken;
  let publicApiError = null;

  // Prioritaskan Public API Telegram karena paling stabil untuk download file.
  if (token) {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
        params: { file_id: fileId },
        timeout: 30000
      });

      const filePath = response?.data?.result?.file_path;
      if (response?.data?.ok && filePath) {
        urls.push(`https://api.telegram.org/file/bot${token}/${filePath}`);
      }
    } catch (error) {
      publicApiError = error;
    }
  }

  // Untuk Local Bot API, file_path adalah path absolut di filesystem.
  // Jangan generate HTTP URL karena akan salah (ada double slash).
  // Sebagai gantinya, worker akan copy file langsung dari filesystem lokal.
  // Skip adding Local Bot API HTTP URLs karena tidak reliable.

  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) {
    if (publicApiError) {
      throw new Error(`Gagal mendapatkan URL file Telegram: ${publicApiError.message}`);
    }
    throw new Error('Gagal mendapatkan URL download file dari Telegram Public API. Pastikan bot dapat mengakses api.telegram.org');
  }

  return unique;
}

function maskTelegramToken(url) {
  return String(url || '').replace(/bot\d+:[^/]+/g, 'bot<token>');
}

async function downloadFromAny(urls, destinationPath) {
  let lastError = null;
  const failures = [];
  for (const url of urls) {
    try {
      await downloadToFile(url, destinationPath);
      return;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      const reason = status ? `HTTP ${status}` : (error?.message || 'Unknown error');
      failures.push(`${maskTelegramToken(url)} -> ${reason}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Semua URL download Telegram gagal: ${failures.join(' | ')}`);
  }
  throw lastError || new Error('Semua URL download Telegram gagal diakses');
}

async function resolveFlutterCommand(ssh, worker) {
  // Resolve an absolute executable path without relying on ~/.bashrc. SSH
  // execCommand is normally non-interactive, so shell startup files may return
  // early and hide Flutter from PATH.
  const preferred = typeof worker.flutterBin === 'string' ? worker.flutterBin.trim() : '';
  const script = `
set +e
export CI=true BOT=true CONTINUOUS_INTEGRATION=true FLUTTER_ALLOW_SUPERUSER=1
export PATH="/opt/flutter/bin:/usr/local/bin:/root/flutter/bin:/usr/local/flutter/bin:$HOME/flutter/bin:/snap/bin:$PATH"
preferred=${sh(preferred)}

check_flutter() {
  candidate="$1"
  if [ -x "$candidate" ] && CI=true BOT=true CONTINUOUS_INTEGRATION=true FLUTTER_ALLOW_SUPERUSER=1 "$candidate" --version >/dev/null 2>&1; then
    printf '%s\\n' "$candidate"
    return 0
  fi
  return 1
}

if [ -n "$preferred" ]; then
  check_flutter "$preferred" && exit 0
fi

for candidate in \
  /opt/flutter/bin/flutter \
  /usr/local/bin/flutter \
  /root/flutter/bin/flutter \
  /usr/local/flutter/bin/flutter \
  "$HOME/flutter/bin/flutter" \
  /snap/bin/flutter; do
  check_flutter "$candidate" && exit 0
done

if command -v flutter >/dev/null 2>&1; then
  check_flutter "$(command -v flutter)" && exit 0
fi

found=$(find /opt /root /usr/local /home -maxdepth 5 -type f -name flutter -path '*/bin/flutter' 2>/dev/null | head -n 1)
if [ -n "$found" ]; then
  check_flutter "$found" && exit 0
fi
exit 1
  `.trim();

  const result = await ssh.execCommand(bashScriptCommand(script));
  if (result.code !== 0) return null;

  const value = String(result.stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .pop();

  return value || null;
}

async function ensureBuildDir(ssh, buildDir) {
  const result = await ssh.execCommand(`mkdir -p ${sh(buildDir)}`);
  if (result.code !== 0) {
    throw new Error(formatExecError(result, `Gagal membuat build directory ${buildDir}`));
  }
}

function parseProjectDetection(stdout = '') {
  const typeMatch = stdout.match(/PROJECT_TYPE=(.+)/);
  const rootMatch = stdout.match(/PROJECT_ROOT=(.+)/);
  return {
    projectType: typeMatch ? typeMatch[1].trim() : 'unknown',
    projectPath: rootMatch ? rootMatch[1].trim() : null
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch (_) {
    return null;
  }
}

/**
 * TIER 1: Try getFile + copy from Local API storage on the worker itself
 */
async function tryGetFileOnWorker(ssh, worker, fileId, remoteZipPath) {
  const botToken = String(config?.telegram?.botToken || '').trim();
  if (!botToken) return { success: false, error: 'Bot token tidak tersedia' };

  const apiPort = Number(worker?.apiPort) > 0 ? Number(worker.apiPort) : 8081;

  const getFileScript = `
set -e
API_PORT=${sh(String(apiPort))}
BOT_TOKEN=${sh(botToken)}
FILE_ID=${sh(fileId)}
RESULT=$(curl -sS --get --data-urlencode "file_id=$FILE_ID" "http://127.0.0.1:$API_PORT/bot$BOT_TOKEN/getFile" 2>&1) || {
  echo "GETFILE_FAILED: $RESULT"
  exit 1
}
echo "$RESULT"
  `.trim();

  const getFileResult = await ssh.execCommand(bashScriptCommand(getFileScript));
  if (getFileResult.code !== 0) {
    return { success: false, error: formatExecError(getFileResult, 'getFile gagal') };
  }

  const payload = parseJsonSafe(getFileResult.stdout);
  if (!payload?.ok || !payload?.result?.file_path) {
    return { success: false, error: `Respons getFile tidak valid: ${String(getFileResult.stdout || '').slice(0, 200)}` };
  }

  const workerFilePath = String(payload.result.file_path);

  // Copy from Local API storage with multiple path fallbacks
  const copyScript = `
set -e
FILE_PATH=${sh(workerFilePath)}
DEST=${sh(remoteZipPath)}

copy_if_exists() {
  if [ -f "$1" ]; then
    cp "$1" "$DEST"
    echo "OK: $1"
    return 0
  fi
  return 1
}

copy_if_exists "$FILE_PATH" && exit 0
copy_if_exists "/$FILE_PATH" && exit 0
copy_if_exists "/var/lib/telegram-bot-api/$FILE_PATH" && exit 0
copy_if_exists "/opt/telegram-bot-api/$FILE_PATH" && exit 0
copy_if_exists "/home/container/$FILE_PATH" && exit 0

echo "FILE_NOT_FOUND"
exit 1
  `.trim();

  const copyResult = await ssh.execCommand(bashScriptCommand(copyScript));
  if (copyResult.code !== 0) {
    return { success: false, error: `File tidak ditemukan di storage: ${workerFilePath}` };
  }

  // Cleanup cache
  ssh.execCommand(`rm -f ${sh(workerFilePath)} 2>/dev/null || true`).catch(() => {});

  return { success: true, method: 'getFile+copy' };
}

/**
 * TIER 2: Direct HTTP download on worker via its own Local Bot API
 * Each worker downloads through its OWN Local API independently
 */
async function tryHttpDownloadOnWorker(ssh, worker, fileId, remoteZipPath) {
  const botToken = String(config?.telegram?.botToken || '').trim();
  if (!botToken) return { success: false, error: 'Bot token tidak tersedia' };

  const apiPort = Number(worker?.apiPort) > 0 ? Number(worker.apiPort) : 8081;

  // Step 1: getFile to get file_path, then download via HTTP on the worker itself
  const downloadScript = `
set -e
API_PORT=${sh(String(apiPort))}
BOT_TOKEN=${sh(botToken)}
FILE_ID=${sh(fileId)}
DEST=${sh(remoteZipPath)}

# Get file path from Local API
RESPONSE=$(curl -sS --get --data-urlencode "file_id=$FILE_ID" "http://127.0.0.1:$API_PORT/bot$BOT_TOKEN/getFile" 2>&1)

# Extract file_path from JSON (simple grep, no jq needed)
FILE_PATH=$(echo "$RESPONSE" | grep -oP '"file_path":"\\K[^"]+' || echo "")

if [ -z "$FILE_PATH" ]; then
  echo "GETFILE_NO_PATH"
  # Try direct download without getFile (some Local API setups)
  # Try to download using sendDocument trick - skip
  exit 1
fi

# Try copy from filesystem first
if [ -f "$FILE_PATH" ]; then
  cp "$FILE_PATH" "$DEST"
  echo "OK: copied $FILE_PATH"
  rm -f "$FILE_PATH" 2>/dev/null || true
  exit 0
fi

# Fallback: download via HTTP from Local API
NORMALIZED="$FILE_PATH"
# Remove any absolute prefix
case "$NORMALIZED" in
  /var/lib/telegram-bot-api/*)
    NORMALIZED=$(echo "$NORMALIZED" | sed "s|^/var/lib/telegram-bot-api/[^/]*/||")
    ;;
  /*)
    NORMALIZED=$(echo "$NORMALIZED" | sed "s|^/||")
    ;;
esac

curl -fsS "http://127.0.0.1:$API_PORT/file/bot$BOT_TOKEN/$NORMALIZED" -o "$DEST" && {
  echo "OK: http download $NORMALIZED"
  rm -f "$FILE_PATH" 2>/dev/null || true
  exit 0
}

# Try with original path
curl -fsS "http://127.0.0.1:$API_PORT/file/bot$BOT_TOKEN/$FILE_PATH" -o "$DEST" && {
  echo "OK: http download $FILE_PATH"
  rm -f "$FILE_PATH" 2>/dev/null || true
  exit 0
}

echo "ALL_HTTP_FAILED"
exit 1
  `.trim();

  const result = await ssh.execCommand(bashScriptCommand(downloadScript));
  if (result.code !== 0) {
    return { success: false, error: formatExecError(result, 'HTTP download via worker Local API gagal') };
  }

  return { success: true, method: 'worker-http' };
}

/**
 * TIER 3: Download from worker's Local API URL via bot server (external HTTP)
 * Bot server connects to worker's external Local API URL to download
 */
async function tryDownloadFromWorkerApi(worker, fileId, localZipPath) {
  const botToken = String(config?.telegram?.botToken || '').trim();
  if (!botToken) return { success: false, error: 'Bot token tidak tersedia' };

  // Build the worker's external Local API URL
  const workerLocalApiUrl = worker.localApiUrl || (worker.host ? `http://${worker.host}:${Number(worker.apiPort) > 0 ? worker.apiPort : 8081}` : null);
  if (!workerLocalApiUrl) {
    return { success: false, error: 'Worker tidak punya Local API URL' };
  }

  try {
    // Step 1: getFile from worker's Local API
    const getFileUrl = `${workerLocalApiUrl}/bot${botToken}/getFile`;
    console.log(`[Download] Trying getFile from worker API: ${workerLocalApiUrl}`);
    
    const getFileResp = await axios.get(getFileUrl, {
      params: { file_id: fileId },
      timeout: 30000
    });

    if (!getFileResp.data?.ok || !getFileResp.data?.result?.file_path) {
      return { success: false, error: 'getFile dari worker API gagal' };
    }

    const filePath = getFileResp.data.result.file_path;

    // Step 2: Download file content from worker's Local API
    // Normalize the file path for the download URL
    let downloadPath = filePath;
    if (downloadPath.startsWith('/')) {
      // For absolute paths, try to extract relative part
      const match = downloadPath.match(/\/var\/lib\/telegram-bot-api\/[^/]+\/(.+)/);
      if (match) downloadPath = match[1];
      else downloadPath = downloadPath.replace(/^\/+/, '');
    }

    const downloadUrl = `${workerLocalApiUrl}/file/bot${botToken}/${downloadPath}`;
    console.log(`[Download] Downloading from worker API: ${downloadUrl}`);
    
    await downloadToFile(downloadUrl, localZipPath);
    return { success: true, method: 'worker-external-api' };
  } catch (err) {
    return { success: false, error: `Worker external API gagal: ${err.message}` };
  }
}

async function detectExtractedProject(ssh, projectPath) {
  const script = `
set -e
PROJECT_PATH=${sh(projectPath)}

detect_flutter="$(find "$PROJECT_PATH" -maxdepth 5 -type f -name pubspec.yaml | head -n 1 || true)"
if [ -n "$detect_flutter" ]; then
  echo "PROJECT_TYPE=flutter"
  echo "PROJECT_ROOT=$(dirname "$detect_flutter")"
  exit 0
fi

detect_android_gradlew="$(find "$PROJECT_PATH" -maxdepth 5 -type f -name gradlew | head -n 1 || true)"
if [ -n "$detect_android_gradlew" ]; then
  echo "PROJECT_TYPE=android"
  echo "PROJECT_ROOT=$(dirname "$detect_android_gradlew")"
  exit 0
fi

detect_android_build="$(find "$PROJECT_PATH" -maxdepth 6 -type f -path "*/app/build.gradle" | head -n 1 || true)"
if [ -n "$detect_android_build" ]; then
  echo "PROJECT_TYPE=android"
  echo "PROJECT_ROOT=$(dirname "$(dirname "$detect_android_build")")"
  exit 0
fi

echo "PROJECT_TYPE=unknown"
echo "PROJECT_ROOT=$PROJECT_PATH"
  `.trim();

  const result = await ssh.execCommand(bashScriptCommand(script));
  if (result.code !== 0) {
    return {
      success: false,
      error: formatExecError(result, 'Gagal mendeteksi tipe project setelah ekstrak ZIP')
    };
  }

  const parsed = parseProjectDetection(result.stdout);
  return {
    success: true,
    projectType: parsed.projectType,
    projectPath: parsed.projectPath || projectPath
  };
}

async function prepareZipProject(ssh, worker, job, buildDir, projectPath, onProgress) {
  if (job.jobId && jobRegistry.isCancelled(job.jobId)) {
    throw new CancelledError();
  }

  const localJobDir = path.join(os.tmpdir(), 'web2apk-v2-jobs', job.jobId);
  const localZipName = sanitizeFileName(job.fileName || `${job.jobId}.zip`);
  const localZipPath = path.join(localJobDir, localZipName);
  const remoteZipPath = `/tmp/${job.jobId}.zip`;

  try {
    await ensureBuildDir(ssh, buildDir);

    const resetScript = `
set -e
rm -rf ${sh(projectPath)}
mkdir -p ${sh(projectPath)}
rm -f ${sh(remoteZipPath)}
    `.trim();
    const resetResult = await ssh.execCommand(bashScriptCommand(resetScript));

    if (resetResult.code !== 0) {
      return {
        success: false,
        error: formatExecError(resetResult, 'Gagal menyiapkan folder project di VPS')
      };
    }

    await onProgress(17, 'Downloading ZIP source...');
    const workerLabel = worker.label || worker.alias || worker.id;
    
    let downloaded = false;

    // === TIER 0: Use pre-downloaded file (fastest, no Telegram API needed) ===
    if (!downloaded && job.localFilePath) {
      const localStat = await fs.stat(job.localFilePath).catch(() => null);
      if (localStat && localStat.size > 0) {
        console.log(`[${job.jobId}] TIER 0: Uploading pre-downloaded ZIP (${localStat.size} bytes) to ${workerLabel}`);
        await onProgress(18, 'Uploading ZIP to worker...');
        
        // Try upload with retry
        let uploadSuccess = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await ssh.putFile(job.localFilePath, remoteZipPath);
            
            // Verify upload succeeded by checking remote file size
            const verifyUpload = await ssh.execCommand(`stat -c%s ${sh(remoteZipPath)} 2>/dev/null || stat -f%z ${sh(remoteZipPath)} 2>/dev/null`);
            if (verifyUpload.code === 0) {
              const remoteSize = parseInt(verifyUpload.stdout.trim(), 10);
              if (remoteSize === localStat.size) {
                console.log(`[${job.jobId}] ✅ TIER 0: ZIP uploaded successfully (${remoteSize} bytes)`);
                downloaded = true;
                uploadSuccess = true;
                break;
              } else {
                console.warn(`[${job.jobId}] TIER 0 attempt ${attempt}: Size mismatch local=${localStat.size}, remote=${remoteSize}`);
              }
            }
          } catch (uploadErr) {
            console.warn(`[${job.jobId}] TIER 0 attempt ${attempt} failed: ${uploadErr.message}`);
          }
          
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
          }
        }
        
        if (!uploadSuccess) {
          console.warn(`[${job.jobId}] TIER 0: All upload attempts failed, will try other tiers`);
          // Don't fail here - let other tiers try
        }
        
        // Cleanup pre-downloaded file (async, don't wait)
        fs.remove(job.localFilePath).catch(() => {});
      } else {
        console.warn(`[${job.jobId}] TIER 0: Pre-downloaded file not found or empty: ${job.localFilePath}`);
      }
    }

    // === TIER 1: getFile + copy from Local API storage on worker ===
    if (!downloaded) {
      const tier1 = await tryGetFileOnWorker(ssh, worker, job.fileId, remoteZipPath);
      if (tier1.success) {
        console.log(`[${job.jobId}] ✅ TIER 1: ZIP downloaded on ${workerLabel} via ${tier1.method}`);
        await onProgress(18, 'ZIP source ready on worker...');
        downloaded = true;
      } else {
        console.warn(`[${job.jobId}] TIER 1 failed (${workerLabel}): ${tier1.error}`);
      }
    }

    // === TIER 2: HTTP download directly on worker via Local API ===
    if (!downloaded) {
      const tier2 = await tryHttpDownloadOnWorker(ssh, worker, job.fileId, remoteZipPath);
      if (tier2.success) {
        console.log(`[${job.jobId}] ✅ TIER 2: ZIP downloaded on ${workerLabel} via ${tier2.method}`);
        await onProgress(18, 'ZIP source ready on worker...');
        downloaded = true;
      } else {
        console.warn(`[${job.jobId}] TIER 2 failed (${workerLabel}): ${tier2.error}`);
      }
    }

    // === TIER 3: Download from worker's Local API to bot server → upload via SSH ===
    if (!downloaded) {
      const tier3 = await tryDownloadFromWorkerApi(worker, job.fileId, localZipPath);
      if (tier3.success) {
        console.log(`[${job.jobId}] ✅ TIER 3: ZIP downloaded from ${workerLabel}'s API to bot server`);
        await onProgress(18, 'Uploading ZIP to worker...');
        await ssh.putFile(localZipPath, remoteZipPath);
        downloaded = true;
        // Cleanup local ZIP after successful upload (async, don't wait)
        fs.remove(localZipPath).catch(() => {});
      } else {
        console.warn(`[${job.jobId}] TIER 3 failed (${workerLabel}): ${tier3.error}`);
      }
    }

    // === TIER 4: Download via global.bot (bot's API connection) → upload via SSH ===
    if (!downloaded && global.bot && typeof global.bot.downloadFile === 'function') {
      try {
        console.log(`[${job.jobId}] TIER 4: Trying bot.downloadFile (${global.isLocalApiActive ? 'Local' : 'Public'} API)...`);
        await fs.ensureDir(localJobDir);
        const downloadedPath = await global.bot.downloadFile(job.fileId, localJobDir);
        if (downloadedPath && await fs.pathExists(downloadedPath)) {
          await fs.move(downloadedPath, localZipPath, { overwrite: true });
          console.log(`[${job.jobId}] ✅ TIER 4: ZIP downloaded via bot API`);
          await onProgress(18, 'Uploading ZIP to worker...');
          await ssh.putFile(localZipPath, remoteZipPath);
          downloaded = true;
          // Cleanup local ZIP after successful upload (async, don't wait)
          fs.remove(localZipPath).catch(() => {});
        }
      } catch (botErr) {
        console.warn(`[${job.jobId}] TIER 4 failed: ${botErr.message}`);
      }
    }

    // === TIER 5: Public Telegram API last resort (works for files ≤ 20MB) ===
    if (!downloaded) {
      try {
        console.log(`[${job.jobId}] TIER 5: Fallback to public Telegram API...`);
        const zipUrls = await getTelegramFileUrls(job.fileId);
        await fs.ensureDir(localJobDir);
        await downloadFromAny(zipUrls, localZipPath);
        console.log(`[${job.jobId}] ✅ TIER 5: ZIP downloaded via public API`);
        await onProgress(18, 'Uploading ZIP to worker...');
        await ssh.putFile(localZipPath, remoteZipPath);
        downloaded = true;
        // Cleanup local ZIP after successful upload (async, don't wait)
        fs.remove(localZipPath).catch(() => {});
      } catch (publicErr) {
        console.error(`[${job.jobId}] TIER 5 failed: ${publicErr.message}`);
      }
    }

    if (!downloaded) {
      return {
        success: false,
        error: 'Gagal download ZIP dari semua metode (Local API worker, Bot API, Public API). Pastikan Local Bot API di VPS berjalan dengan benar.'
      };
    }

    // Verify uploaded file size matches local file (corruption check)
    await onProgress(18, 'Verifying ZIP integrity...');
    const verifyScript = `
set -e
if [ ! -f ${sh(remoteZipPath)} ]; then
  echo "FILE_NOT_FOUND"
  exit 1
fi
SIZE=$(stat -c%s ${sh(remoteZipPath)} 2>/dev/null || stat -f%z ${sh(remoteZipPath)} 2>/dev/null)
if [ -z "$SIZE" ] || [ "$SIZE" -eq 0 ]; then
  echo "FILE_EMPTY"
  exit 1
fi
if ! unzip -t ${sh(remoteZipPath)} >/dev/null 2>&1; then
  echo "ZIP_INVALID"
  exit 1
fi
echo "OK: $SIZE bytes"
exit 0
    `.trim();
    const verifyResult = await ssh.execCommand(bashScriptCommand(verifyScript));

    if (verifyResult.code !== 0) {
      const errorType = verifyResult.stdout?.trim();
      let errorMsg = 'ZIP file corrupt atau upload gagal';
      if (errorType === 'FILE_NOT_FOUND') errorMsg = 'File ZIP tidak ditemukan di worker setelah upload';
      if (errorType === 'FILE_EMPTY') errorMsg = 'File ZIP kosong (0 bytes)';
      if (errorType === 'ZIP_INVALID') errorMsg = 'File ZIP corrupt atau bukan file ZIP valid';
      return {
        success: false,
        error: `${errorMsg}. Silakan coba upload ulang file ZIP.`
      };
    }

    const sizeMatch = verifyResult.stdout?.match(/(\d+) bytes/);
    if (sizeMatch) {
      const remoteSize = parseInt(sizeMatch[1], 10);
      const localSize = job.localFilePath ? (await fs.stat(job.localFilePath).catch(() => ({ size: 0 }))).size : 0;
      if (localSize > 0 && remoteSize !== localSize) {
        console.warn(`[${job.jobId}] ⚠️ Size mismatch: local=${localSize}, remote=${remoteSize}`);
      }
    }

    await onProgress(19, 'Extracting ZIP on worker...');
    const unzipScript = `
set -e
unzip -oq ${sh(remoteZipPath)} -d ${sh(projectPath)}
rm -f ${sh(remoteZipPath)}
    `.trim();
    const unzipResult = await ssh.execCommand(bashScriptCommand(unzipScript));

    if (unzipResult.code !== 0) {
      return {
        success: false,
        error: formatExecError(unzipResult, 'Gagal ekstrak ZIP di VPS')
      };
    }

    const detected = await detectExtractedProject(ssh, projectPath);
    if (!detected.success) return detected;

    if (detected.projectType === 'unknown') {
      return {
        success: false,
        error: 'ZIP tidak berisi project Flutter/Android yang valid (pubspec.yaml/gradlew tidak ditemukan)'
      };
    }

    let flutterCmd = null;
    if (detected.projectType === 'flutter') {
      flutterCmd = await resolveFlutterCommand(ssh, worker);
      if (!flutterCmd) {
        return {
          success: false,
          error: 'Flutter tidak ditemukan di VPS. Jalankan /installvps ulang atau set worker.flutterBin.'
        };
      }
      
      // Auto-fix build.gradle to use compileSdk 36
      await onProgress(20, 'Auto-fixing build configuration...');
      await autoFixBuildGradle(ssh, detected.projectPath);
    }

    return {
      success: true,
      projectType: detected.projectType,
      projectPath: detected.projectPath,
      flutterCmd
    };
  } catch (error) {
    if (error instanceof CancelledError || (job.jobId && jobRegistry.isCancelled(job.jobId))) {
      throw error instanceof CancelledError ? error : new CancelledError();
    }
    return { success: false, error: `Project preparation failed: ${error.message}` };
  } finally {
    await fs.remove(localJobDir).catch(() => {});
    await ssh.execCommand(`rm -f ${sh(remoteZipPath)}`).catch(() => {});
  }
}

function escapeJavaString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ');
}

function encodeUrlForTemplate(url) {
  const reversed = String(url || '').split('').reverse().join('');
  return Buffer.from(reversed, 'utf8').toString('base64');
}

/**
 * Normalize Android/Gradle compatibility for the Flutter SDK installed by the
 * worker. This is intentionally conservative: it only updates the wrapper
 * distribution URL when the project wrapper is older than Flutter's minimum,
 * and adds Flutter's documented AGP 9 compatibility flags without replacing
 * project build files.
 */
async function ensureGradleCompatibility(ssh, projectPath) {
  // Keep Flutter/AGP/Gradle compatibility in one place. The worker must not
  // blindly rewrite already-compatible projects, and it must support both
  // Groovy and Kotlin DSL projects.

  // Make sure the worker's Android SDK actually has the newest platform
  // available before Gradle needs it — this runs for both Flutter and
  // native-Android builds (both pipelines call this function), so a plugin
  // that suddenly requires a newer SDK level (e.g. permission_handler_android
  // needing android-37) doesn't fail mid-build waiting on a platform that was
  // never pre-installed.
  await ensureLatestAndroidPlatformInstalled(ssh).catch((e) => {
    console.warn(`[AndroidSdkCompat] Could not verify/install latest SDK platform: ${e.message}`);
  });

  const script = `
set -e
PROJECT_PATH=${sh(projectPath)}
ANDROID_DIR="$PROJECT_PATH/android"
WRAPPER="$ANDROID_DIR/gradle/wrapper/gradle-wrapper.properties"
PROPS="$ANDROID_DIR/gradle.properties"
MIN_GRADLE="8.14.0"
TARGET_GRADLE="8.14.3"
MIN_AGP="8.11.1"
TARGET_AGP="8.11.1"
MIN_KOTLIN="2.2.20"
TARGET_KOTLIN="2.2.20"

version_ge() {
  [ "$(printf '%s\\n' "$1" "$2" | sort -V | head -1)" = "$2" ]
}

if [ ! -d "$ANDROID_DIR" ]; then
  echo "ANDROID_DIR_NOT_FOUND"
  exit 0
fi

if [ ! -f "$WRAPPER" ]; then
  echo "GRADLE_WRAPPER_MISSING"
  exit 1
fi

if ! grep -q '^distributionUrl=' "$WRAPPER"; then
  echo "GRADLE_WRAPPER_INVALID: distributionUrl missing"
  exit 1
fi

CURRENT_GRADLE=$(sed -n 's#.*gradle-\\([0-9][0-9.]*\\)-.*#\\1#p' "$WRAPPER" | head -1)
if [ -z "$CURRENT_GRADLE" ]; then
  echo "GRADLE_WRAPPER_INVALID: cannot determine Gradle version"
  exit 1
fi

if ! version_ge "$CURRENT_GRADLE" "$MIN_GRADLE"; then
  cp -f "$WRAPPER" "$WRAPPER.web2apk.bak"
  # Gradle wrapper properties commonly contain https\\://. Replacing the
  # complete line avoids fragile URL matching.
  sed -i -E "s|^distributionUrl=.*$|distributionUrl=https\\\\://services.gradle.org/distributions/gradle-$TARGET_GRADLE-bin.zip|" "$WRAPPER"
  NORMALIZED_URL=$(grep '^distributionUrl=' "$WRAPPER" | head -1 | sed 's/\\\\//g')
  EXPECTED_URL="distributionUrl=https://services.gradle.org/distributions/gradle-$TARGET_GRADLE-bin.zip"
  if [ "$NORMALIZED_URL" != "$EXPECTED_URL" ]; then
    cp -f "$WRAPPER.web2apk.bak" "$WRAPPER"
    echo "GRADLE_WRAPPER_PATCH_NOT_APPLIED"
    echo "EXPECTED:$EXPECTED_URL"
    echo "ACTUAL:$NORMALIZED_URL"
    exit 1
  fi
  rm -f "$WRAPPER.web2apk.bak"
  echo "GRADLE_UPGRADED:$CURRENT_GRADLE->$TARGET_GRADLE"
else
  echo "GRADLE_OK:$CURRENT_GRADLE"
fi

# Auto-detect and upgrade old AGP declarations. Support:
#   1) plugins { id 'com.android.application' version 'x' }
#   2) plugins { id("com.android.application") version("x") }
#   3) buildscript classpath 'com.android.tools.build:gradle:x'
#   4) Kotlin DSL equivalents.
AGP_FILES=""
for f in \
  "$ANDROID_DIR/settings.gradle" "$ANDROID_DIR/settings.gradle.kts" \
  "$ANDROID_DIR/build.gradle" "$ANDROID_DIR/build.gradle.kts"; do
  [ -f "$f" ] && AGP_FILES="$AGP_FILES $f"
done

AGP_FOUND=""
for f in $AGP_FILES; do
  v=$(grep -Eo 'com\\.android\\.application[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
  if [ -z "$v" ]; then
    v=$(grep -Eo 'com\\.android\\.tools(\\.build)?:gradle:[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
  fi
  if [ -n "$v" ]; then AGP_FOUND="$v"; break; fi
done

if [ -z "$AGP_FOUND" ]; then
  echo "AGP_NOT_DECLARED_OR_MANAGED_EXTERNALLY"
else
  echo "AGP_DETECTED:$AGP_FOUND"
  if ! version_ge "$AGP_FOUND" "$MIN_AGP"; then
    # Handle both Groovy and Kotlin DSL declarations without depending on
    # fragile quoting patterns.
    for f in $AGP_FILES; do
      if grep -q 'com\.android\.application' "$f" 2>/dev/null; then
        sed -i -E "/com\.android\.application/ s/[0-9]+\.[0-9]+\.[0-9]+/$TARGET_AGP/g" "$f" 2>/dev/null || true
      fi
      if grep -q -E 'com\.android\.tools(\.build)?:gradle:' "$f" 2>/dev/null; then
        sed -i -E "s#(com\.android\.tools(\.build)?:gradle:)[0-9]+\.[0-9]+\.[0-9]+#\\1$TARGET_AGP#g" "$f" 2>/dev/null || true
      fi
    done
  fi

  FINAL_AGP=""
  for f in $AGP_FILES; do
    v=$(grep -Eo 'com\\.android\\.application[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
    if [ -z "$v" ]; then
      v=$(grep -Eo 'com\\.android\\.tools(\\.build)?:gradle:[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
    fi
    if [ -n "$v" ]; then FINAL_AGP="$v"; break; fi
  done
  if [ -z "$FINAL_AGP" ] || ! version_ge "$FINAL_AGP" "$MIN_AGP"; then
    echo "AGP_PATCH_NOT_APPLIED"
    echo "DETECTED:$AGP_FOUND"
    echo "FINAL:$FINAL_AGP"
    exit 1
  fi
  echo "AGP_READY:$FINAL_AGP"
fi

# Auto-detect and upgrade old Kotlin/KGP declarations. Support:
#   1) plugins { id 'org.jetbrains.kotlin.android' version 'x' }
#   2) plugins { id("org.jetbrains.kotlin.android") version("x") }
#   3) ext.kotlin_version = 'x' (older Groovy templates)
#   4) Kotlin DSL equivalents (val kotlin_version / extra["kotlin_version"]).
KOTLIN_FILES=""
for f in \
  "$ANDROID_DIR/settings.gradle" "$ANDROID_DIR/settings.gradle.kts" \
  "$ANDROID_DIR/build.gradle" "$ANDROID_DIR/build.gradle.kts"; do
  [ -f "$f" ] && KOTLIN_FILES="$KOTLIN_FILES $f"
done

KOTLIN_FOUND=""
for f in $KOTLIN_FILES; do
  v=$(grep -Eo 'org\\.jetbrains\\.kotlin\\.android[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
  if [ -z "$v" ]; then
    v=$(grep -Eo 'kotlin_version[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
  fi
  if [ -n "$v" ]; then KOTLIN_FOUND="$v"; break; fi
done

if [ -z "$KOTLIN_FOUND" ]; then
  echo "KOTLIN_NOT_DECLARED_OR_MANAGED_EXTERNALLY"
else
  echo "KOTLIN_DETECTED:$KOTLIN_FOUND"
  if ! version_ge "$KOTLIN_FOUND" "$MIN_KOTLIN"; then
    for f in $KOTLIN_FILES; do
      if grep -q 'org\.jetbrains\.kotlin\.android' "$f" 2>/dev/null; then
        sed -i -E "/org\.jetbrains\.kotlin\.android/ s/[0-9]+\.[0-9]+\.[0-9]+/$TARGET_KOTLIN/g" "$f" 2>/dev/null || true
      fi
      if grep -q 'kotlin_version' "$f" 2>/dev/null; then
        sed -i -E "s/(kotlin_version[^0-9]*)[0-9]+\.[0-9]+\.[0-9]+/\\1$TARGET_KOTLIN/g" "$f" 2>/dev/null || true
      fi
    done
  fi

  FINAL_KOTLIN=""
  for f in $KOTLIN_FILES; do
    v=$(grep -Eo 'org\\.jetbrains\\.kotlin\\.android[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
    if [ -z "$v" ]; then
      v=$(grep -Eo 'kotlin_version[^0-9]*[0-9]+\\.[0-9]+\\.[0-9]+' "$f" 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1 || true)
    fi
    if [ -n "$v" ]; then FINAL_KOTLIN="$v"; break; fi
  done
  if [ -z "$FINAL_KOTLIN" ] || ! version_ge "$FINAL_KOTLIN" "$MIN_KOTLIN"; then
    echo "KOTLIN_PATCH_NOT_APPLIED"
    echo "DETECTED:$KOTLIN_FOUND"
    echo "FINAL:$FINAL_KOTLIN"
    exit 1
  fi
  echo "KOTLIN_READY:$FINAL_KOTLIN"
fi

# Flutter 3.47-era projects that are not on AGP 9 should remain on the legacy
# DSL path. Only add these compatibility flags when absent.
touch "$PROPS"
if ! grep -q '^android.newDsl=' "$PROPS"; then
  echo 'android.newDsl=false' >> "$PROPS"
fi

if grep -R -E -q 'kotlin-android|org\\.jetbrains\\.kotlin\\.android' \
  "$ANDROID_DIR/settings.gradle" "$ANDROID_DIR/settings.gradle.kts" \
  "$ANDROID_DIR/build.gradle" "$ANDROID_DIR/build.gradle.kts" \
  "$ANDROID_DIR/app/build.gradle" "$ANDROID_DIR/app/build.gradle.kts" 2>/dev/null; then
  if ! grep -q '^android.builtInKotlin=' "$PROPS"; then
    echo 'android.builtInKotlin=false' >> "$PROPS"
  fi
fi

FINAL_URL=$(grep '^distributionUrl=' "$WRAPPER" | head -1 | sed 's/\\\\//g')
FINAL_GRADLE=$(printf '%s\\n' "$FINAL_URL" | sed -n 's#.*gradle-\\([0-9][0-9.]*\\)-.*#\\1#p')
if [ -z "$FINAL_GRADLE" ] || ! version_ge "$FINAL_GRADLE" "$MIN_GRADLE"; then
  echo "GRADLE_WRAPPER_INVALID: final version is '$FINAL_GRADLE'"
  exit 1
fi

# ── JAVA_HOME auto-fix based on the FINAL (possibly just-upgraded) AGP/Gradle ──
# AGP 8.x requires JDK 17 minimum; AGP 9.x (released 2026) requires Gradle 9.x
# which in turn requires JDK 17 minimum too, but newer JDKs (21) are commonly
# recommended and some newer Gradle daemon features benefit from them. Rather
# than hardcoding java-17 everywhere (which silently stops being "the right
# choice" the moment this same compatibility script upgrades a project to a
# newer AGP than whatever java-17 assumption was written against), detect
# every JDK actually installed on this worker and pick the NEWEST one that
# still satisfies the minimum — falling back to installing JDK 17 (the
# universal safe minimum for all AGP 8.x/9.x versions) only if nothing
# suitable is found at all.
REQUIRED_JAVA_MAJOR=17
AGP_MAJOR=$(printf '%s\\n' "$FINAL_AGP" | sed -n 's#^\\([0-9]*\\).*#\\1#p')
if [ -n "$AGP_MAJOR" ] && [ "$AGP_MAJOR" -ge 9 ] 2>/dev/null; then
  REQUIRED_JAVA_MAJOR=17
fi

BEST_JAVA_HOME=""
BEST_JAVA_MAJOR=0
for jvm_dir in /usr/lib/jvm/*/; do
  [ -d "$jvm_dir" ] || continue
  candidate_bin="\${jvm_dir}bin/java"
  [ -x "$candidate_bin" ] || continue
  ver_line=$("$candidate_bin" -version 2>&1 | head -1)
  major=$(printf '%s\\n' "$ver_line" | sed -n 's/.*version "\\([0-9]*\\).*/\\1/p')
  case "$major" in ''|*[!0-9]*) continue ;; esac
  if [ "$major" -ge "$REQUIRED_JAVA_MAJOR" ] && [ "$major" -gt "$BEST_JAVA_MAJOR" ]; then
    BEST_JAVA_MAJOR="$major"
    BEST_JAVA_HOME="\${jvm_dir%/}"
  fi
done

if [ -z "$BEST_JAVA_HOME" ]; then
  echo "No installed JDK satisfies minimum Java $REQUIRED_JAVA_MAJOR for AGP $FINAL_AGP; attempting to install OpenJDK 17..."
  (apt-get install -y openjdk-17-jdk-headless >/dev/null 2>&1 || apt-get install -y openjdk-17-jdk >/dev/null 2>&1) || true
  for jvm_dir in /usr/lib/jvm/*17*/; do
    [ -d "$jvm_dir" ] || continue
    if [ -x "\${jvm_dir}bin/java" ]; then
      BEST_JAVA_HOME="\${jvm_dir%/}"
      BEST_JAVA_MAJOR=17
      break
    fi
  done
fi

if [ -n "$BEST_JAVA_HOME" ]; then
  echo "JAVA_HOME_SELECTED:$BEST_JAVA_HOME (major=$BEST_JAVA_MAJOR, required>=$REQUIRED_JAVA_MAJOR for AGP $FINAL_AGP)"
  # Merge org.gradle.java.home into the project's own android/gradle.properties
  # so the Gradle daemon picks the right JDK regardless of what JAVA_HOME
  # happens to be in the calling shell's environment — this is the same
  # mechanism Android Studio itself uses (GRADLE_LOCAL_JAVA_HOME) and is
  # more reliable across the multiple separate ssh.execCommand() calls this
  # pipeline makes than relying on an exported shell variable persisting.
  # Reuses $PROPS ("$ANDROID_DIR/gradle.properties"), already defined above
  # and already guaranteed to exist by the AGP/Kotlin property-writing logic
  # earlier in this same script.
  touch "$PROPS"
  if grep -q '^org.gradle.java.home=' "$PROPS" 2>/dev/null; then
    sed -i "s#^org.gradle.java.home=.*#org.gradle.java.home=$BEST_JAVA_HOME#" "$PROPS"
  else
    echo "org.gradle.java.home=$BEST_JAVA_HOME" >> "$PROPS"
  fi
else
  echo "WARNING: could not find or install a suitable JDK (need >=$REQUIRED_JAVA_MAJOR); build will proceed with whatever JAVA_HOME is already set and may fail."
fi

echo "COMPATIBILITY_READY:gradle=$FINAL_GRADLE agp=$FINAL_AGP kotlin=$FINAL_KOTLIN java=$BEST_JAVA_MAJOR"

# ── AndroidManifest.xml structural auto-fix ────────────────────────────────
# Beyond just bumping compileSdk/targetSdk numbers (handled above), a build
# can also fail purely on XML structure problems in AndroidManifest.xml —
# most commonly from projects assembled/edited outside Android Studio (hand-
# edited manifests, templates copy-pasted from old tutorials, or manifests
# merged from multiple sources). These are cheap, safe, well-understood
# fixes; we only ever ADD a missing declaration, never remove user content.
MANIFEST="$ANDROID_DIR/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ]; then
  cp -f "$MANIFEST" "$MANIFEST.web2apk.bak"

  # Fix 1: missing xmlns:android namespace declaration. Without this, EVERY
  # android:* attribute in the file is unresolvable and the manifest fails
  # to parse entirely — this is the single most common hard-fail XML issue.
  if ! grep -q 'xmlns:android="http://schemas.android.com/apk/res/android"' "$MANIFEST"; then
    if grep -qE '<manifest[^>]*>' "$MANIFEST"; then
      sed -i -E '0,/<manifest/{s#<manifest#<manifest xmlns:android="http://schemas.android.com/apk/res/android"#}' "$MANIFEST"
      echo "MANIFEST_FIX: added missing xmlns:android namespace"
    fi
  fi

  # Fix 2: missing xmlns:tools namespace when tools:* attributes are used
  # (e.g. tools:replace, tools:node — common in manifests merged from
  # plugin templates). Without the namespace declaration these attributes
  # are silently invalid and can cause a manifest-merger failure.
  if grep -q 'tools:' "$MANIFEST" && ! grep -q 'xmlns:tools="http://schemas.android.com/tools"' "$MANIFEST"; then
    sed -i -E '0,/<manifest/{s#<manifest#<manifest xmlns:tools="http://schemas.android.com/tools"#}' "$MANIFEST"
    echo "MANIFEST_FIX: added missing xmlns:tools namespace"
  fi

  # Fix 3: duplicate <uses-permission android:name="X"/> entries. Harmless
  # to the manifest merger in most cases but some AGP/Gradle combinations
  # (and some OEM lint configurations) flag exact duplicates as an error.
  # Deduplicate while preserving the first occurrence and original order.
  DUP_COUNT=$(grep -oE '<uses-permission[^/]*android:name="[^"]*"[^/]*/>' "$MANIFEST" | sort | uniq -d | wc -l)
  if [ "$DUP_COUNT" -gt 0 ]; then
    awk '!(/<uses-permission/ && seen[$0]++)' "$MANIFEST" > "$MANIFEST.dedup" && mv "$MANIFEST.dedup" "$MANIFEST"
    echo "MANIFEST_FIX: removed $DUP_COUNT duplicate <uses-permission> line(s)"
  fi

  # Verify the manifest is still well-formed XML after any edits above,
  # using whatever XML validator is available on this worker. If our edits
  # somehow broke well-formedness (should not happen given the fixes are
  # narrowly targeted string insertions), restore the pre-edit backup rather
  # than hand the build a manifest that's worse than what we started with.
  XML_OK=1
  if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "$MANIFEST" 2>/tmp/manifest_xmllint_err.txt || XML_OK=0
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import xml.etree.ElementTree as ET; ET.parse('$MANIFEST')" 2>/tmp/manifest_xmllint_err.txt || XML_OK=0
  fi
  if [ "$XML_OK" != "1" ]; then
    echo "MANIFEST_FIX_REVERTED: edits produced invalid XML, restored original"
    cat /tmp/manifest_xmllint_err.txt 2>/dev/null || true
    cp -f "$MANIFEST.web2apk.bak" "$MANIFEST"
  fi
  rm -f "$MANIFEST.web2apk.bak" /tmp/manifest_xmllint_err.txt
fi

exit 0
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()));
  if (result.code !== 0) {
    throw new Error(formatExecError(result, 'Gagal menyiapkan kompatibilitas Gradle/AGP'));
  }
  console.log(`[GradleCompat] ${projectPath}: ${(result.stdout || '').trim()}`);
  return result.stdout || '';
}

/**
 * Detect the highest Android SDK Platform actually installed on the worker
 * (by inspecting $ANDROID_HOME/platforms/android-N), and if a newer platform
 * is available from Google's repository, install it via sdkmanager. This
 * makes compileSdk/targetSdk auto-fixes track whatever the worker can
 * actually build against, instead of a hardcoded number that goes stale
 * every time Google ships a new Android API level (or a plugin like
 * permission_handler_android starts requiring it). Returns the highest
 * installed platform level as a number, or null if none could be determined.
 */
async function ensureLatestAndroidPlatformInstalled(ssh) {
  // IMPORTANT: this script intentionally does NOT use `set -e`. Every
  // sdkmanager call below is best-effort (guarded with `|| true`), because
  // Google's package repository metadata (repository2-3.xml) occasionally
  // bumps its schema version. When that happens, an sdkmanager build that
  // only understands an older schema prints a *warning* to stderr
  // ("This version only understands SDK XML versions up to N but an SDK XML
  // file of version N+1 was encountered") and may return a partial/garbled
  // package list. That must never be allowed to abort the whole build via
  // `set -e` + a non-zero exit further down the pipe — we always want to
  // fall back to CURRENT_MAX (the platform already installed) rather than
  // fail the job outright over what is fundamentally a version-string parse
  // hiccup, not a missing/broken toolchain.
  const script = `
ANDROID_HOME="\${ANDROID_HOME:-/opt/android-sdk}"
SDKMANAGER=""
for candidate in "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "$ANDROID_HOME/cmdline-tools/bin/sdkmanager"; do
  if [ -x "$candidate" ]; then SDKMANAGER="$candidate"; break; fi
done

CURRENT_MAX=0
if [ -d "$ANDROID_HOME/platforms" ]; then
  for d in "$ANDROID_HOME/platforms"/android-*; do
    [ -d "$d" ] || continue
    n=$(basename "$d" | sed -E 's/android-//')
    case "$n" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$n" -gt "$CURRENT_MAX" ]; then CURRENT_MAX=$n; fi
  done
fi
echo "CURRENT_MAX:$CURRENT_MAX"

if [ -z "$SDKMANAGER" ]; then
  echo "SDKMANAGER_NOT_FOUND"
  exit 0
fi

# Self-update sdkmanager first (best-effort, silenced) so it understands the
# current repository XML schema before we ask it to --list packages. This is
# throttled to once per 24h via a marker file so it doesn't add SSH round
# trips (and a network call) to every single build.
UPDATE_MARKER="$ANDROID_HOME/.sdkmanager_last_selfupdate"
NOW_EPOCH=$(date +%s)
LAST_EPOCH=0
[ -f "$UPDATE_MARKER" ] && LAST_EPOCH=$(cat "$UPDATE_MARKER" 2>/dev/null || echo 0)
case "$LAST_EPOCH" in ''|*[!0-9]*) LAST_EPOCH=0 ;; esac
if [ $((NOW_EPOCH - LAST_EPOCH)) -gt 86400 ]; then
  yes | "$SDKMANAGER" --update >/dev/null 2>&1 || true
  echo "$NOW_EPOCH" > "$UPDATE_MARKER" 2>/dev/null || true
fi

# Ask the SDK repository what the newest available platform is, and install
# it (plus matching build-tools) if it's newer than what we already have.
# The XML-schema warning (if any) goes to stderr and is discarded here;
# only stdout package identifiers are parsed, so a stray warning line can't
# corrupt LATEST_AVAILABLE.
LATEST_AVAILABLE=$(yes | "$SDKMANAGER" --list 2>/dev/null | grep -Eo 'platforms;android-[0-9]+' | grep -Eo '[0-9]+' | sort -n | tail -1 || true)
if [ -z "$LATEST_AVAILABLE" ]; then
  echo "LATEST_AVAILABLE_UNKNOWN"
  exit 0
fi
echo "LATEST_AVAILABLE:$LATEST_AVAILABLE"

if [ "$LATEST_AVAILABLE" -gt "$CURRENT_MAX" ]; then
  echo "Installing newer platform android-$LATEST_AVAILABLE..."
  yes | "$SDKMANAGER" "platforms;android-$LATEST_AVAILABLE" >/dev/null 2>&1 || true
  # Best-effort matching build-tools; ignore failure, Gradle can often reuse an older build-tools.
  LATEST_BUILD_TOOLS=$(yes | "$SDKMANAGER" --list 2>/dev/null | grep -Eo 'build-tools;[0-9]+\\.[0-9]+\\.[0-9]+' | sort -V | tail -1 || true)
  if [ -n "$LATEST_BUILD_TOOLS" ]; then
    yes | "$SDKMANAGER" "$LATEST_BUILD_TOOLS" >/dev/null 2>&1 || true
  fi
  # Verify the platform actually landed on disk before claiming success; the
  # sdkmanager install call above is best-effort (|| true) and could have
  # silently failed if the same schema-mismatch warning made THIS call bail.
  if [ -d "$ANDROID_HOME/platforms/android-$LATEST_AVAILABLE" ]; then
    echo "INSTALLED:$LATEST_AVAILABLE"
  else
    echo "INSTALL_FAILED_FALLBACK:$CURRENT_MAX"
  fi
else
  echo "ALREADY_UP_TO_DATE:$CURRENT_MAX"
fi
`;
  const result = await ssh.execCommand(bashScriptCommand(script.trim()), { execOptions: { timeout: 240000 } });
  const out = result.stdout || '';
  console.log(`[AndroidSdkCompat] ${out.trim() || result.stderr || '(no output)'}`);

  const installedMatch = out.match(/INSTALLED:(\d+)/);
  if (installedMatch) return Number(installedMatch[1]);
  const upToDateMatch = out.match(/ALREADY_UP_TO_DATE:(\d+)/);
  if (upToDateMatch) return Number(upToDateMatch[1]);
  const fallbackMatch = out.match(/INSTALL_FAILED_FALLBACK:(\d+)/);
  if (fallbackMatch && Number(fallbackMatch[1]) > 0) return Number(fallbackMatch[1]);
  const currentMaxMatch = out.match(/CURRENT_MAX:(\d+)/);
  if (currentMaxMatch && Number(currentMaxMatch[1]) > 0) return Number(currentMaxMatch[1]);
  return null;
}

/**
 * Auto-fix build.gradle/build.gradle.kts to target the highest Android SDK
 * Platform actually available on the worker, and normalize Gradle
 * compatibility required by the installed Flutter SDK.
 */
async function autoFixBuildGradle(ssh, projectPath) {
  // ensureGradleCompatibility already calls ensureLatestAndroidPlatformInstalled
  // internally (so both Flutter and native-Android pipelines get the SDK
  // check), so we just re-query the result here rather than re-running the
  // install/list step a second time.
  await ensureGradleCompatibility(ssh, projectPath);

  const detectedSdk = await ensureLatestAndroidPlatformInstalled(ssh).catch((e) => {
    console.warn(`[AndroidSdkCompat] Could not verify/install latest SDK platform: ${e.message}`);
    return null;
  });
  const targetSdk = detectedSdk || 36; // Fall back to the previous known-good default.

  try {
    const script = `
set -e
PROJECT_PATH=${sh(projectPath)}
TARGET_SDK=${Number(targetSdk)}

BUILD_GRADLE=""
if [ -f "$PROJECT_PATH/android/app/build.gradle.kts" ]; then
  BUILD_GRADLE="$PROJECT_PATH/android/app/build.gradle.kts"
elif [ -f "$PROJECT_PATH/android/app/build.gradle" ]; then
  BUILD_GRADLE="$PROJECT_PATH/android/app/build.gradle"
fi

if [ -z "$BUILD_GRADLE" ]; then
  echo "No build.gradle found in android/app"
  exit 0
fi

echo "Found: $BUILD_GRADLE"

case "$BUILD_GRADLE" in
  *.kts)
    sed -i -E "s/compileSdk[[:space:]]*=[[:space:]]*[0-9]+/compileSdk = $TARGET_SDK/g" "$BUILD_GRADLE"
    sed -i -E "s/compileSdkVersion[[:space:]]*=[[:space:]]*[0-9]+/compileSdk = $TARGET_SDK/g" "$BUILD_GRADLE"
    sed -i -E "s/targetSdk[[:space:]]*=[[:space:]]*[0-9]+/targetSdk = $TARGET_SDK/g" "$BUILD_GRADLE"
    ;;
  *)
    sed -i -E "s/compileSdk[[:space:]]+[0-9]+/compileSdk $TARGET_SDK/g" "$BUILD_GRADLE"
    sed -i -E "s/compileSdkVersion[[:space:]]+[0-9]+/compileSdk $TARGET_SDK/g" "$BUILD_GRADLE"
    sed -i -E "s/targetSdk[[:space:]]+[0-9]+/targetSdk $TARGET_SDK/g" "$BUILD_GRADLE"
    ;;
esac

echo "Updated compileSdk to $TARGET_SDK in $BUILD_GRADLE"
exit 0
`;
    const result = await ssh.execCommand(bashScriptCommand(script.trim()));
    if (result.code !== 0) {
      throw new Error(formatExecError(result, 'Gagal memperbaiki build.gradle'));
    }
    console.log(`[GradleCompat] ${result.stdout.trim()}`);
  } catch (e) {
    throw new Error(`Auto-fix Gradle gagal: ${e.message}`);
  }
}

const ICON_SPECS = [
  { dir: 'mipmap-mdpi', size: 48 },
  { dir: 'mipmap-hdpi', size: 72 },
  { dir: 'mipmap-xhdpi', size: 96 },
  { dir: 'mipmap-xxhdpi', size: 144 },
  { dir: 'mipmap-xxxhdpi', size: 192 }
];

async function applyCustomLauncherIcon(localProjectPath, sourceIconPath) {
  // Validate source icon exists
  if (!await fs.pathExists(sourceIconPath)) {
    console.warn('⚠️ Source icon not found, using default template icons');
    return;
  }

  // Validate source is valid image
  try {
    const metadata = await sharp(sourceIconPath).metadata();
    if (!metadata || !metadata.format) {
      console.warn('⚠️ Source icon is not a valid image, using default template icons');
      return;
    }
  } catch (e) {
    console.warn('⚠️ Failed to read source icon metadata, using default template icons:', e.message);
    return;
  }

  for (const spec of ICON_SPECS) {
    const baseDir = path.join(localProjectPath, 'app', 'src', 'main', 'res', spec.dir);
    const launcher = path.join(baseDir, 'ic_launcher.png');
    const round = path.join(baseDir, 'ic_launcher_round.png');

    await fs.ensureDir(baseDir);
    
    try {
      // Generate PNG with explicit settings for Android compatibility
      await sharp(sourceIconPath)
        .resize(spec.size, spec.size, {
          fit: 'cover',
          position: 'centre'
        })
        .png({
          compressionLevel: 9,
          adaptiveFiltering: true,
          force: true
        })
        .toFile(launcher);
      
      // Verify the generated file is valid
      const stats = await fs.stat(launcher);
      if (stats.size === 0) {
        throw new Error('Generated icon file is empty');
      }
      
      await fs.copy(launcher, round, { overwrite: true });
    } catch (e) {
      console.error(`❌ Failed to generate icon for ${spec.dir}:`, e.message);
      // Continue with other sizes, template will have default icons
    }
  }
}

function isValidHexColor(value) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(value || '').trim());
}

/** Darken a #RRGGBB hex color by a percentage (0-1), used to derive colorPrimaryDark from colorPrimary */
function darkenHex(hex, amount = 0.18) {
  const clean = String(hex).replace('#', '');
  const num = parseInt(clean, 16);
  const r = Math.max(0, Math.floor(((num >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.floor(((num >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.floor((num & 0xff) * (1 - amount)));
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * Ganti Warna APK: patch colorPrimary/colorPrimaryDark/colorAccent di
 * colors.xml (light & dark/values-night) sesuai warna hex yang diminta user.
 */
async function applyThemeColor(localProjectPath, themeColorHex) {
  if (!isValidHexColor(themeColorHex)) return false;

  const primary = String(themeColorHex).toUpperCase();
  const primaryDark = darkenHex(primary, 0.18);

  const colorFiles = [
    path.join(localProjectPath, 'app', 'src', 'main', 'res', 'values', 'colors.xml'),
    path.join(localProjectPath, 'app', 'src', 'main', 'res', 'values-night', 'colors.xml'),
  ];

  for (const filePath of colorFiles) {
    if (!await fs.pathExists(filePath)) continue;
    let xml = await fs.readFile(filePath, 'utf8');
    xml = xml.replace(/<color name="colorPrimary">.*?<\/color>/, `<color name="colorPrimary">${primary}</color>`);
    xml = xml.replace(/<color name="colorPrimaryDark">.*?<\/color>/, `<color name="colorPrimaryDark">${primaryDark}</color>`);
    xml = xml.replace(/<color name="colorAccent">.*?<\/color>/, `<color name="colorAccent">${primary}</color>`);
    await fs.writeFile(filePath, xml, 'utf8');
  }

  return true;
}

/**
 * Rename All Name: memastikan SEMUA kemunculan nama aplikasi di project
 * (strings.xml, AndroidManifest label, toolbar title jika hardcoded) ikut
 * berubah, bukan cuma app_name saja.
 */
async function applyRenameAll(localProjectPath, appName) {
  const safeName = escapeXml(appName || 'FxhlProject Web2Apk App');

  const manifestPath = path.join(localProjectPath, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (await fs.pathExists(manifestPath)) {
    let manifest = await fs.readFile(manifestPath, 'utf8');
    // Jika ada android:label hardcoded (bukan @string/app_name), arahkan ke app_name
    manifest = manifest.replace(/android:label="(?!@string\/app_name)[^"]*"/g, 'android:label="@string/app_name"');
    await fs.writeFile(manifestPath, manifest, 'utf8');
  }

  return safeName;
}

/**
 * Validasi format package name / applicationId Android.
 * Harus reverse-domain notation, contoh: com.namaapp.tokoku
 */
function isValidPackageName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(String(value || '').trim());
}

/**
 * Rename Package Name (applicationId) APK:
 * Patch nilai `applicationId` di app/build.gradle. Sengaja HANYA mengganti
 * applicationId (bukan `namespace` / folder source java), supaya proses
 * rebuild tetap ringan & tidak berisiko merusak compile (namespace/kode Java
 * boleh tetap com.web2apk.app, applicationId lah yang menentukan identitas
 * unik APK di Play Store / perangkat pengguna — ini mekanisme resmi AGP).
 */
async function applyPackageName(localProjectPath, packageName) {
  if (!isValidPackageName(packageName)) return false;

  const gradlePath = path.join(localProjectPath, 'app', 'build.gradle');
  if (!await fs.pathExists(gradlePath)) return false;

  let gradle = await fs.readFile(gradlePath, 'utf8');
  const safePackage = String(packageName).trim();

  if (!/applicationId\s+"[^"]*"/.test(gradle)) return false;

  gradle = gradle.replace(/applicationId\s+"[^"]*"/, `applicationId "${safePackage}"`);
  await fs.writeFile(gradlePath, gradle, 'utf8');

  return true;
}

async function prepareNativeUrlProjectFiles(localProjectPath, appName, targetUrl, options = {}) {
  const stringsPath = path.join(localProjectPath, 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  const mainActivityPath = path.join(localProjectPath, 'app', 'src', 'main', 'java', 'com', 'web2apk', 'app', 'MainActivity.java');

  const safeName = escapeXml(appName || 'FxhlProject Web2Apk App');
  const encodedUrl = encodeUrlForTemplate(targetUrl);
  const fallbackUrl = escapeJavaString(targetUrl || 'https://google.com');

  const stringsXml = await fs.readFile(stringsPath, 'utf8');
  const updatedStrings = stringsXml.replace(
    /<string name="app_name">.*<\/string>/,
    `<string name="app_name">${safeName}</string>`
  );
  await fs.writeFile(stringsPath, updatedStrings, 'utf8');

  const mainActivity = await fs.readFile(mainActivityPath, 'utf8');
  let updatedMainActivity = mainActivity.replace(/ENCODED_URL_PLACEHOLDER/g, encodedUrl);
  updatedMainActivity = updatedMainActivity.replace(
    /private static final String FALLBACK_URL = ".*";/,
    `private static final String FALLBACK_URL = "${fallbackUrl}";`
  );
  updatedMainActivity = updatedMainActivity.replace(/https:\/\/google\.com/g, fallbackUrl);
  await fs.writeFile(mainActivityPath, updatedMainActivity, 'utf8');

  // Ganti Warna APK (opsional)
  if (options.themeColor) {
    await applyThemeColor(localProjectPath, options.themeColor);
  }

  // Rename All Name (opsional, memastikan semua label ikut berubah)
  if (options.renameAll) {
    await applyRenameAll(localProjectPath, appName);
  }

  // Rename Package Name / applicationId (opsional)
  if (options.packageName) {
    await applyPackageName(localProjectPath, options.packageName);
  }
}

async function prepareUrlProject(ssh, worker, job, buildDir, projectPath, onProgress) {
  const appName = job?.payload?.appName || job.appName || 'FxhlProject Web2Apk App';
  const targetUrl = job?.url || 'https://google.com';
  const customIconFileId = job?.payload?.customIcon || null;
  const localJobDir = path.join(os.tmpdir(), 'web2apk-v2-jobs', job.jobId, 'url-native-project');
  const localProjectPath = path.join(localJobDir, 'project');
  const localIconPath = path.join(localJobDir, 'icon-source.bin');

  try {
    const hasTemplate = await fs.pathExists(NATIVE_URL_TEMPLATE_DIR);
    if (!hasTemplate) {
      return {
        success: false,
        error: `Template Android native tidak ditemukan di ${NATIVE_URL_TEMPLATE_DIR}`
      };
    }

    await onProgress(17, 'Generating native Android project...');
    await ensureBuildDir(ssh, buildDir);

    const resetScript = `
set -e
rm -rf ${sh(projectPath)}
mkdir -p ${sh(projectPath)}
    `.trim();
    const resetResult = await ssh.execCommand(bashScriptCommand(resetScript));

    if (resetResult.code !== 0) {
      return {
        success: false,
        error: formatExecError(resetResult, 'Gagal menyiapkan folder project native di VPS')
      };
    }

    await fs.ensureDir(localJobDir);
    await fs.copy(NATIVE_URL_TEMPLATE_DIR, localProjectPath, { overwrite: true });

    await onProgress(18, 'Configuring native project...');
    await prepareNativeUrlProjectFiles(localProjectPath, appName, targetUrl, {
      themeColor: job?.payload?.themeColor || null,
      renameAll: Boolean(job?.payload?.renameAll),
      packageName: job?.payload?.packageName || null,
    });

    if (customIconFileId) {
      await onProgress(19, 'Downloading custom icon...');
      const iconUrls = await getTelegramFileUrls(customIconFileId);
      await downloadFromAny(iconUrls, localIconPath);

      await onProgress(19, 'Applying custom icon...');
      await applyCustomLauncherIcon(localProjectPath, localIconPath);
    }

    await onProgress(19, 'Uploading native project...');
    const uploaded = await ssh.putDirectory(localProjectPath, projectPath, {
      recursive: true,
      concurrency: 5,
      validate: () => true
    });

    if (!uploaded) {
      return {
        success: false,
        error: 'Gagal upload project Android native ke VPS'
      };
    }

    await ssh.execCommand('chmod +x gradlew || true', { cwd: projectPath });

    return {
      success: true,
      projectType: 'android',
      projectPath
    };
  } catch (error) {
    return { success: false, error: `Native project generation failed: ${error.message}` };
  } finally {
    await fs.remove(localJobDir).catch(() => {});
  }
}

async function prepare(ssh, worker, job, onProgress = async () => {}) {
  const buildDir = worker.buildDir || config.workers.defaultBuildDir;
  const projectPath = `${buildDir}/${job.jobId}`;

  if (job.mode === 'zip') {
    return prepareZipProject(ssh, worker, job, buildDir, projectPath, onProgress);
  }

  if (job.mode === 'url') {
    return prepareUrlProject(ssh, worker, job, buildDir, projectPath, onProgress);
  }

  try {
    await ensureBuildDir(ssh, buildDir);
    const type = job.projectType || 'flutter';
    let flutterCmd = null;
    if (type === 'flutter') {
      flutterCmd = await resolveFlutterCommand(ssh, worker);
      if (!flutterCmd) {
        return {
          success: false,
          error: 'Flutter tidak ditemukan di VPS. Jalankan /installvps terlebih dahulu.'
        };
      }
    }
    return {
      success: true,
      projectType: type,
      projectPath,
      flutterCmd
    };
  } catch (error) {
    if (error instanceof CancelledError || (job.jobId && jobRegistry.isCancelled(job.jobId))) {
      throw error instanceof CancelledError ? error : new CancelledError();
    }
    return { success: false, error: `Preparation fallback failed: ${error.message}` };
  }
}

module.exports = {
  prepare,
  ensureGradleCompatibility,
  autoFixBuildGradle,
  isValidHexColor,
  applyThemeColor,
  applyRenameAll,
  isValidPackageName,
  applyPackageName,
  sh,
  sanitizeProjectName,
  escapeXml,
  escapeDart,
  formatExecError,
  ensureBuildDir,
  resolveFlutterCommand,
  getTelegramFileUrls,
  downloadFromAny,
  applyCustomLauncherIcon,
  ICON_SPECS,
};
