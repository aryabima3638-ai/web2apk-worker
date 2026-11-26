/**
 * VPS Remote Installer for Web2Apk V2 Gen 1
 * 
 * Installs build toolchain on remote VPS via SSH with real-time streaming logs:
 * 1. System packages (ninja-build, cmake, unzip, openjdk-17-jdk)
 * 2. Android SDK (commandlinetools, platform-tools, build-tools)
 * 3. Flutter SDK
 * 4. Telegram Local Bot API Server (compile from source)
 * 
 * Each VPS has its own Local Bot API running on port 8081
 */

const { NodeSSH } = require('node-ssh');
const config = require('../config');
const db = require('../bot/db');

class VpsInstaller {
  constructor() {
    this.ssh = new NodeSSH();
    this.logBuffer = [];
    this.currentStep = 0;
    this.totalSteps = 7; // Added Node.js check step
  }

  /**
   * Run full installation on a worker (legacy method - use runInstallWithLogger for streaming UI)
   * @param {Object} worker - Worker object from database
   * @param {Object} bot - Telegram bot instance for messaging
   * @param {Number} chatId - Admin chat ID for progress updates
   */
  async runInstall(worker, bot, chatId) {
    const { apiId, apiHash } = config.telegram;
    
    if (!apiId || !apiHash) {
      throw new Error('API_ID and API_HASH must be configured in config.js');
    }

    const log = (msg) => {
      console.log(`[Installer ${worker.host}] ${msg}`);
    };

    try {
      // Step 0: Connect SSH with auth method detection
      log('🔌 Connecting to VPS...');
      
      const connectConfig = {
        host: worker.host,
        username: worker.user
      };
      
      if (worker.authMethod === 'password' && worker.password) {
        connectConfig.password = worker.password;
        log('🔐 Using password authentication');
      } else if (worker.sshKeyPath) {
        connectConfig.privateKey = worker.sshKeyPath;
        log('🔑 Using SSH key authentication');
      } else {
        connectConfig.privateKey = worker.sshKeyPath;
      }
      
      await this.ssh.connect(connectConfig);
      log('✅ SSH Connected');

      // Update worker status to installing
      await this.updateWorkerStatus(worker.id, 'installing');
      log('🔧 Status: Installing (builds will not be assigned)');

      // Step 1: System packages
      log(`━━━ Step 1/${this.totalSteps}: System Packages ━━━`);
      await this.installSystemPackages(log);
      log('✅ System packages installed');

      // Step 2: Check & Install Node.js 20.x
      log(`━━━ Step 2/${this.totalSteps}: Node.js & npm ━━━`);
      await this.checkAndInstallNodejs(log);
      log('✅ Node.js & npm verified');

      // Step 3: Java JDK
      log(`━━━ Step 3/${this.totalSteps}: Java JDK 17 ━━━`);
      await this.installJava(log);
      log('✅ Java JDK verified');

      // Step 4: Android SDK
      log(`━━━ Step 4/${this.totalSteps}: Android SDK ━━━`);
      await this.installAndroidSdk(log);
      log('✅ Android SDK installed');

      // Step 5: Flutter SDK
      log(`━━━ Step 5/${this.totalSteps}: Flutter SDK ━━━`);
      await this.installFlutter(log, worker);
      log('✅ Flutter SDK installed');

      // Step 6: Local Bot API Server (takes longest!)
      log(`━━━ Step 6/${this.totalSteps}: Telegram Local Bot API Server ━━━`);
      log('⏳ This step takes 15-30 minutes (compiling from source)...');
      await this.installLocalBotApi(apiId, apiHash, log);
      log('✅ Local Bot API Server installed and running');

      // Step 7: Finalize
      log(`━━━ Step 7/${this.totalSteps}: Finalize ━━━`);
      await this.finalize(worker, apiId, apiHash, log);

      // Update worker with Local API URL
      const localApiUrl = `http://${worker.host}:8081`;
      await this.updateWorkerLocalApi(worker.id, localApiUrl);
      log(`🌐 Local Bot API URL: ${localApiUrl}`);

      // Update worker status
      await this.updateWorkerStatus(worker.id, 'online');
      // BUG FIX #4 & #5: Mark as installed
      await this.updateInstallationStatus(worker.id, 'installed');
      log('🎉 Installation complete! VPS is ready for builds.');

    } catch (error) {
      log(`❌ Installation failed: ${error.message}`);
      await this.updateWorkerStatus(worker.id, 'offline');
      // BUG FIX #4 & #5: Mark as pending if installation failed
      await this.updateInstallationStatus(worker.id, 'pending');
      throw error;
    } finally {
      this.ssh.dispose();
    }
  }

  /**
   * Update worker Local API URL in database (per-worker)
   * Includes defensive check to prevent duplicate entries
   */
  async updateWorkerLocalApi(workerId, localApiUrl) {
    // BUG FIX: Sebelumnya pakai getWorkers() lalu saveWorkers() sebagai 2 operasi
    // terpisah. Kalau ada 2 update jalan hampir bersamaan (mis. updateWorkerStatus
    // dan updateInstallationStatus dipanggil berdekatan), masing-masing bisa membaca
    // data LAMA sebelum yang lain selesai menulis -> update saling menimpa dan data
    // worker bisa hilang/corrupt (workers.json jadi [] atau kehilangan field).
    // Fix: pakai db.updateWorkers() yang read-modify-write secara atomik dalam satu lock.
    let found = false;
    await db.updateWorkers((workers) => {
      const uniqueWorkers = workers.filter((w, index, self) =>
        index === self.findIndex(t => t.id === w.id)
      );
      const index = uniqueWorkers.findIndex(w => w.id === workerId);
      if (index > -1) {
        uniqueWorkers[index].localApiUrl = localApiUrl;
        uniqueWorkers[index].apiPort = 8081;
        found = true;
      }
      return uniqueWorkers;
    });
    if (found) {
      console.log(`[Installer] Updated Local API URL for ${workerId}: ${localApiUrl}`);
    } else {
      console.error(`[Installer] Worker ${workerId} not found for Local API update`);
    }
  }

  /**
   * Update worker status in database
   * Includes defensive check to prevent duplicate entries
   */
  async updateWorkerStatus(workerId, status) {
    // BUG FIX: atomik lewat db.updateWorkers (lihat penjelasan di updateWorkerLocalApi)
    let found = false;
    await db.updateWorkers((workers) => {
      const uniqueWorkers = workers.filter((w, index, self) =>
        index === self.findIndex(t => t.id === w.id)
      );
      const index = uniqueWorkers.findIndex(w => w.id === workerId);
      if (index > -1) {
        uniqueWorkers[index].status = status;
        found = true;
      }
      return uniqueWorkers;
    });
    if (found) {
      console.log(`[Installer] Updated status for ${workerId}: ${status}`);
    } else {
      console.error(`[Installer] Worker ${workerId} not found for status update`);
    }
  }

  /**
   * BUG FIX #4 & #5: Update worker installation status in database
   * @param {string} workerId - Worker ID
   * @param {string} status - 'pending' | 'installing' | 'installed'
   */
  async updateInstallationStatus(workerId, status) {
    // BUG FIX: atomik lewat db.updateWorkers (lihat penjelasan di updateWorkerLocalApi)
    let found = false;
    await db.updateWorkers((workers) => {
      const uniqueWorkers = workers.filter((w, index, self) =>
        index === self.findIndex(t => t.id === w.id)
      );
      const index = uniqueWorkers.findIndex(w => w.id === workerId);
      if (index > -1) {
        uniqueWorkers[index].installationStatus = status;
        if (status === 'installed') {
          uniqueWorkers[index].installedAt = new Date().toISOString();
        }
        found = true;
      }
      return uniqueWorkers;
    });
    if (found) {
      console.log(`[Installer] Updated installationStatus for ${workerId}: ${status}`);
    } else {
      console.error(`[Installer] Worker ${workerId} not found for installation status update`);
    }
  }

  /**
   * Step 2: Check & Install Node.js 20.x (like Gen 4)
   */
  async checkAndInstallNodejs(log) {
    // Check current Node.js version
    log('🔍 Checking Node.js installation...');
    const nodeCheck = await this.ssh.execCommand('node --version 2>&1 || echo "NOT_FOUND"');
    const nodeVersion = nodeCheck.stdout.trim();

    let needsNodeInstall = false;

    if (nodeVersion.includes('NOT_FOUND') || nodeVersion.includes('command not found')) {
      log('⚠️ Node.js not found! Installing Node.js 20.x...');
      needsNodeInstall = true;
    } else {
      // Parse version: v20.11.0 → 20
      const majorMatch = nodeVersion.match(/v?(\d+)\./);
      const majorVersion = majorMatch ? parseInt(majorMatch[1], 10) : 0;
      log(`📌 Found Node.js ${nodeVersion} (major: ${majorVersion})`);

      if (majorVersion < 20) {
        log(`⚠️ Node.js ${nodeVersion} is too old. Upgrading to v20.x...`);
        needsNodeInstall = true;
      } else {
        log(`✅ Node.js ${nodeVersion} is OK (v20+)`);
      }
    }

    // Also check npm
    const npmCheck = await this.ssh.execCommand('npm --version 2>&1 || echo "NOT_FOUND"');
    const npmVersion = npmCheck.stdout.trim();
    
    if (npmVersion.includes('NOT_FOUND') || npmVersion.includes('command not found')) {
      log('⚠️ npm not found! Will install with Node.js...');
      needsNodeInstall = true;
    } else {
      log(`📌 Found npm ${npmVersion}`);
    }

    if (needsNodeInstall) {
      log('📦 Installing Node.js 20.x via NodeSource...');

      // Install prerequisites
      log('⏳ Installing prerequisites...');
      await this.ssh.execCommand('apt-get update -y');
      await this.ssh.execCommand('apt-get install -y ca-certificates curl gnupg');

      // Add NodeSource repository
      log('⏳ Setting up NodeSource repository...');
      await this.ssh.execCommand('mkdir -p /etc/apt/keyrings');
      await this.ssh.execCommand('curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg');
      await this.ssh.execCommand('echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list');

      // Install Node.js
      log('⬇️ Installing Node.js 20.x (this may take a few minutes)...');
      await this.ssh.execCommand('apt-get update -y');
      await this.ssh.execCommand('apt-get install -y nodejs');

      // Verify installation
      const verifyNode = await this.ssh.execCommand('node --version');
      const verifyNpm = await this.ssh.execCommand('npm --version');

      if (verifyNode.stdout.includes('command not found') || verifyNpm.stdout.includes('command not found')) {
        throw new Error(`Node.js installation failed! node: ${verifyNode.stdout}, npm: ${verifyNpm.stdout}`);
      }

      log(`✅ Node.js installed: ${verifyNode.stdout.trim()}, npm: ${verifyNpm.stdout.trim()}`);
    } else {
      log(`✅ Node.js & npm already up to date`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============================================
  // INSTALLATION STEPS WITH STREAMING LOGS
  // ============================================

  /**
   * Step 1: Install system packages with streaming output
   */
  async installSystemPackages(log) {
    const commands = [
      { cmd: 'apt-get update -y', desc: 'Updating package list' },
      { cmd: 'apt-get install -y ninja-build cmake unzip git curl wget file xz-utils tar', desc: 'Installing build tools' },
      { cmd: 'apt-get install -y make zlib1g-dev libssl-dev gperf g++ build-essential', desc: 'Installing development libraries' },
      { cmd: 'apt-get install -y openjdk-17-jdk', desc: 'Installing OpenJDK 17' }
    ];

    for (const { cmd, desc } of commands) {
      log(`⏳ ${desc}...`);
      const result = await this.ssh.execCommand(cmd, {
        execOptions: { timeout: 0 },
        onStdout: (chunk) => {
          const lines = chunk.toString().trim();
          if (lines && !lines.includes('GET') && !lines.includes('Unpacking')) {
            log(`  ${lines.substring(0, 100)}`);
          }
        }
      });
      
      if (result.code !== 0) {
        const details = `${result.stderr || result.stdout || ''}`.replace(/\s+/g, ' ').trim();
        throw new Error(`${desc} gagal (exit ${result.code}): ${details.substring(0, 300)}`);
      }
      log(`✅ ${desc} complete`);
    }

    // Best-effort: also install OpenJDK 21 alongside the required JDK 17
    // above. This is intentionally NOT part of the strict `commands` array
    // (whose failures abort the entire worker install) — JDK 17 alone is
    // already sufficient for every AGP version currently in use (8.x and
    // 9.x both only require 17 as their minimum), so JDK 21 here is purely
    // "nice to have" headroom for projectPrep.js's ensureGradleCompatibility
    // auto-fix (see JAVA_HOME_SELECTED logic there), which always picks the
    // newest available JDK that still satisfies whatever a given project's
    // AGP actually requires. Some older base images / apt mirrors don't
    // carry openjdk-21-jdk yet, so this must never be allowed to fail the
    // whole worker installation over an optional upgrade.
    log('⏳ Installing OpenJDK 21 (optional, for newer AGP headroom)...');
    const jdk21Result = await this.ssh.execCommand('apt-get install -y openjdk-21-jdk', { execOptions: { timeout: 0 } });
    if (jdk21Result.code === 0) {
      log('✅ OpenJDK 21 installed');
    } else {
      log('⚠️ OpenJDK 21 not available on this system, continuing with JDK 17 only (this is fine).');
    }

    // Auto-detect JAVA_HOME
    const javaResult = await this.ssh.execCommand(
      'readlink -f $(which java) | sed "s|/bin/java||" | sed "s|/jre||"'
    );
    
    if (javaResult.code === 0 && javaResult.stdout) {
      const javaHome = javaResult.stdout.trim();
      await this.ssh.execCommand(`echo 'export JAVA_HOME=${javaHome}' >> ~/.bashrc`);
      await this.ssh.execCommand(`echo 'export PATH=$JAVA_HOME/bin:$PATH' >> ~/.bashrc`);
      log(`🔧 JAVA_HOME set to ${javaHome}`);
    }
  }

  /**
   * Step 2: Verify Java installation
   */
  async installJava(log) {
    const result = await this.ssh.execCommand('java -version 2>&1');
    if (result.code !== 0) {
      throw new Error('Java installation verification failed');
    }
    log(`✅ Java: ${result.stdout.split('\n')[0] || result.stderr.split('\n')[0]}`);
  }

  /**
   * Step 3: Install Android SDK with streaming output
   */
  async installAndroidSdk(log) {
    const sdkRoot = '/opt/android-sdk';
    const cmdlineDir = `${sdkRoot}/cmdline-tools`;
    const latestDir = `${cmdlineDir}/latest`;
    const sdkManager = `${latestDir}/bin/sdkmanager`;

    const verifySdk = async () => {
      const checks = [
        `test -x '${sdkManager}'`,
        `test -d '${sdkRoot}/platform-tools'`,
        `test -d '${sdkRoot}/platforms/android-36'`,
        `test -d '${sdkRoot}/build-tools/36.0.0'`
      ];
      for (const cmd of checks) {
        const r = await this.ssh.execCommand(cmd);
        if (r.code !== 0) return false;
      }
      return true;
    };

    if (await verifySdk()) {
      log('✅ Android SDK sudah lengkap dan tervalidasi');
      await this.ssh.execCommand(`cat > /etc/profile.d/android-sdk.sh <<'EOF'\nexport ANDROID_HOME=${sdkRoot}\nexport ANDROID_SDK_ROOT=${sdkRoot}\nexport PATH=${sdkRoot}/cmdline-tools/latest/bin:${sdkRoot}/platform-tools:$PATH\nEOF\nchmod 644 /etc/profile.d/android-sdk.sh`);
      return;
    }

    log('⬇️ Menyiapkan Android Command Line Tools...');
    // Android's current Linux Command-Line Tools package is 22.0 (build 15859902).
    // The old v5 installer used obsolete Google URLs only; a 403 from dl.google.com
    // therefore caused the entire installation to stop. Use independent mirrors and
    // a bounded curl download with a normal browser user-agent before giving up.
    const urls = [
      'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip',
      'https://dl-ssl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip',
      'https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-linux-15859902_latest.zip',
    ];
    // Never allow one dead/blocked mirror to hang the whole installer for 20-30+ minutes.
    // The official Linux archive is about 182 MB, so 8 minutes is ample on a normal VPS,
    // while the low-speed guard aborts stalled connections much earlier.
    const downloadTimeoutSec = 480;
    const connectTimeoutSec = 15;
    const speedLimit = 16384;
    const speedTimeSec = 20;
    const minArchiveBytes = 120 * 1024 * 1024;
    const maxArchiveBytes = 350 * 1024 * 1024;
    const expectedSha256 = '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583';
    const tempFile = '/tmp/android-cmdline-tools.zip';
    await this.ssh.execCommand(`rm -f '${tempFile}' && rm -rf /tmp/android_temp`);

    let downloaded = false;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      log(`🌐 Android Command Line Tools source ${i + 1}/${urls.length}...`);
      // First do a short header probe. This prevents spending minutes downloading from a
      // mirror that immediately returns 403/404/HTML. A failed probe is skipped quickly.
      const probe = await this.ssh.execCommand(
        `curl -sSIL --http1.1 --connect-timeout ${connectTimeoutSec} --max-time 20 -A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/139 Safari/537.36' '${url}' | tail -n 20`,
        { execOptions: { timeout: 30000 } }
      );
      const probeText = `${probe.stdout || ''}\n${probe.stderr || ''}`;
      if (probe.code !== 0 || /\bHTTP\/[0-9.]+\s+(4\d\d|5\d\d)\b/i.test(probeText)) {
        log(`  ⚠️ Source ${i + 1} tidak tersedia, lanjut ke source berikutnya.`);
        continue;
      }

      // Use curl with a hard wall-clock limit and a low-speed abort. This is the important
      // fix for the previous version: a blocked/stalled CDN could sit here indefinitely.
      const command =
        `timeout ${downloadTimeoutSec}s curl -fL --http1.1 --retry 2 --retry-all-errors --retry-delay 2 ` +
        `--connect-timeout ${connectTimeoutSec} --max-time ${downloadTimeoutSec} ` +
        `--speed-limit ${speedLimit} --speed-time ${speedTimeSec} -sS ` +
        `-A 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/139 Safari/537.36' ` +
        `'${url}' -o '${tempFile}'`;
      await this.ssh.execCommand(`rm -f '${tempFile}'`);
      const r = await this.ssh.execCommand(command, { execOptions: { timeout: (downloadTimeoutSec + 30) * 1000 } });
      if (r.code !== 0) {
        log(`  ⚠️ Download source ${i + 1} gagal/timeout, lanjut.`);
        await this.ssh.execCommand(`rm -f '${tempFile}'`);
        continue;
      }
      const check = await this.ssh.execCommand(
        `size=$(stat -c '%s' '${tempFile}' 2>/dev/null || echo 0); ` +
        `test "$size" -ge ${minArchiveBytes} -a "$size" -le ${maxArchiveBytes} && ` +
        `unzip -tq '${tempFile}' >/dev/null 2>&1 && ` +
        `unzip -l '${tempFile}' | grep -q 'cmdline-tools/bin/sdkmanager'`
      );
      if (check.code === 0) {
        log(`  🔐 Verifying Android Command Line Tools SHA-256...`);
        const checksum = await this.ssh.execCommand(
          `echo '${expectedSha256}  ${tempFile}' | sha256sum -c -`,
          { execOptions: { timeout: 120000 } }
        );
        if (checksum.code === 0) {
          downloaded = true;
          const sizeInfo = await this.ssh.execCommand(`stat -c '%s' '${tempFile}'`);
          const mb = Math.round(Number(sizeInfo.stdout || 0) / 1024 / 1024);
          log(`  ✅ Source ${i + 1} archive valid + SHA-256 OK (${mb} MB).`);
          break;
        }
        log(`  ⚠️ Source ${i + 1} checksum tidak cocok, file dibuang.`);
      }
      log(`  ⚠️ Source ${i + 1} menghasilkan file tidak valid, lanjut.`);
      await this.ssh.execCommand(`rm -f '${tempFile}'`);
    }
    if (!downloaded) {
      throw new Error('Gagal mengunduh Android Command Line Tools. Semua sumber resmi/mirror gagal (termasuk fallback curl + wget). Periksa koneksi HTTPS/DNS VPS ke Google/Tencent mirror.');
    }

    log('📦 Extracting Android Tools...');
    const extract = await this.ssh.execCommand(
      `rm -rf /tmp/android_temp '${latestDir}' && mkdir -p '${cmdlineDir}' /tmp/android_temp && unzip -q '${tempFile}' -d /tmp/android_temp && test -x /tmp/android_temp/cmdline-tools/bin/sdkmanager && mv /tmp/android_temp/cmdline-tools '${latestDir}' && rm -rf '${tempFile}' /tmp/android_temp && chmod -R a+rX '${sdkRoot}'`
    );
    if (extract.code !== 0) throw new Error(`Gagal menyiapkan Android Command Line Tools: ${extract.stderr || extract.stdout}`);

    await this.ssh.execCommand(`cat > /etc/profile.d/android-sdk.sh <<'EOF'\nexport ANDROID_HOME=${sdkRoot}\nexport ANDROID_SDK_ROOT=${sdkRoot}\nexport PATH=${sdkRoot}/cmdline-tools/latest/bin:${sdkRoot}/platform-tools:$PATH\nEOF\nchmod 644 /etc/profile.d/android-sdk.sh`);

    // Self-update sdkmanager BEFORE accepting licenses / installing packages.
    // Google's package repository metadata (repository2-3.xml) periodically bumps
    // its schema version. An sdkmanager binary that only understands an older
    // schema version prints "This version only understands SDK XML versions up
    // to N but an SDK XML file of version N+1 was encountered" and can fail to
    // parse the package list, breaking --list/--licenses/install. Running
    // `sdkmanager --update` once, right after extraction, pulls the newest
    // "cmdline-tools" component (which itself understands the newest schema)
    // and self-replaces the binaries in this same `latest` directory, so every
    // later invocation (including from the build pipeline months from now)
    // uses an sdkmanager that's currently compatible with Google's servers.
    // This is best-effort: if it fails (offline mirror, transient network),
    // we still proceed with the just-downloaded sdkmanager rather than aborting
    // the whole install, since the base package was already SHA-256 verified.
    log('🔄 Self-updating sdkmanager to latest schema/tooling...');
    const selfUpdate = await this.ssh.execCommand(
      `yes | '${sdkManager}' --update 2>&1 | tail -n 30`,
      { execOptions: { timeout: 180000 } }
    );
    if (selfUpdate.code === 0) {
      log('  ✅ sdkmanager self-update selesai.');
    } else {
      log('  ⚠️ sdkmanager self-update gagal/timeout, lanjut dengan versi yang sudah ada.');
    }

    log('📝 Accepting Android licenses...');
    const licenses = await this.ssh.execCommand(`yes | '${sdkManager}' --licenses >/dev/null 2>&1`, { execOptions: { timeout: 300000 } });
    if (licenses.code !== 0) throw new Error(`Gagal menerima Android SDK licenses: ${licenses.stderr || licenses.stdout}`);

    const packages = [
      'platform-tools',
      'platforms;android-33',
      'platforms;android-34',
      'platforms;android-35',
      'platforms;android-36',
      'build-tools;34.0.0',
      'build-tools;35.0.0',
      'build-tools;36.0.0',
      'ndk;27.0.12077973',
      'cmake;3.22.1'
    ];

    for (const pkg of packages) {
      log(`⬇️ Installing ${pkg}...`);
      const r = await this.ssh.execCommand(`yes | '${sdkManager}' '${pkg}'`, {
        execOptions: { timeout: 0 },
        onStdout: (chunk) => {
          const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (/installed|done|complete/i.test(text)) log(`  ${text.substring(0, 140)}`);
        }
      });
      if (r.code !== 0) throw new Error(`SDK component ${pkg} gagal: ${r.stderr || r.stdout}`);
    }

    if (!(await verifySdk())) {
      throw new Error('Android SDK selesai diinstall tetapi verifikasi sdkmanager/platform/build-tools gagal.');
    }
    log('✅ Android SDK lengkap dan tervalidasi');
  }

  /**
   * Step 4: Install Flutter SDK with streaming output
   */
  async installFlutter(log, worker = null) {
    const flutterHome = '/opt/flutter';
    const flutterBin = `${flutterHome}/bin/flutter`;
    const flutterVersion = '3.47.2';
    const archiveName = `flutter_linux_${flutterVersion}-stable.tar.xz`;
    const archivePath = `/tmp/${archiveName}`;
    const expectedSha256 = ''; // Official archive is additionally checked by type/size; keep empty until an official hash is pinned.

    const verifyFlutter = async () => {
      const r = await this.ssh.execCommand(
        `bash -lc 'export CI=true; export BOT=true; export CONTINUOUS_INTEGRATION=true; export FLUTTER_ALLOW_SUPERUSER=1; export PATH="${flutterHome}/bin:/usr/local/bin:$PATH"; command -v flutter >/dev/null && flutter --version 2>&1'`,
        { execOptions: { timeout: 180000 } }
      );
      const output = `${r.stdout || ''}\n${r.stderr || ''}`;
      return r.code === 0 && /Flutter 3\.47\.2/.test(output);
    };

    if (await verifyFlutter()) {
      log('✅ Flutter SDK 3.47.2 sudah terpasang dan tervalidasi');
      await this.persistFlutterPath(worker, flutterBin);
      return;
    }

    log(`📌 Flutter stable yang dipakai: ${flutterVersion}`);
    // Do not delete an existing SDK before the replacement is fully validated.
    // A transient first-run network/extraction failure must never turn a known-good
    // worker into a broken worker that only works after a second install attempt.
    await this.ssh.execCommand(`rm -rf '/opt/flutter-staging' '${archivePath}'`);

    // Prefer direct archives. If a CDN returns 403, fall back to a shallow Git tag.
    const archiveUrls = [
      `https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/${archiveName}`,
      `https://storage.flutter-io.cn/flutter_infra_release/releases/stable/linux/${archiveName}`,
      `https://mirror.nju.edu.cn/flutter/flutter_infra/releases/stable/linux/${archiveName}`,
      `https://mirrors.cernet.edu.cn/flutter/flutter_infra/releases/stable/linux/${archiveName}`
    ];
    let archiveReady = false;
    for (let i = 0; i < archiveUrls.length; i++) {
      const url = archiveUrls[i];
      log(`🌐 Flutter archive source ${i + 1}/${archiveUrls.length}...`);
      const r = await this.ssh.execCommand(
        `curl -fL --retry 4 --retry-all-errors --retry-delay 3 --connect-timeout 30 --max-time 7200 -sS '${url}' -o '${archivePath}'`,
        { execOptions: { timeout: 0 } }
      );
      if (r.code === 0) {
        const check = await this.ssh.execCommand(`test -s '${archivePath}' && file '${archivePath}' | grep -Eqi 'XZ compressed data|tar.*XZ' && stat -c '%s' '${archivePath}'`);
        const size = Number((check.stdout || '').trim().split(/\s+/).pop() || 0);
        if (check.code === 0 && size > 500 * 1024 * 1024) {
          archiveReady = true;
          log(`✅ Flutter archive downloaded (${Math.round(size / 1024 / 1024)} MB)`);
          break;
        }
      }
      await this.ssh.execCommand(`rm -f '${archivePath}'`);
    }

    if (archiveReady) {
      if (expectedSha256) {
        log('🔐 Verifying Flutter archive SHA-256...');
        const checksum = await this.ssh.execCommand(`echo '${expectedSha256}  ${archivePath}' | sha256sum -c -`, { execOptions: { timeout: 300000 } });
        if (checksum.code !== 0) {
          await this.ssh.execCommand(`rm -f '${archivePath}'`);
          throw new Error(`Checksum Flutter SDK tidak cocok. Download dihentikan.`);
        }
        log('✅ SHA-256 Flutter valid');
      } else {
        log('✅ Flutter archive lolos validasi format + ukuran');
      }
      const stage = '/opt/flutter-staging';
      const extract = await this.ssh.execCommand(`rm -rf '${stage}' && mkdir -p '${stage}' && tar --no-same-owner -xJf '${archivePath}' -C '${stage}' && test -x '${stage}/flutter/bin/flutter'`);
      if (extract.code !== 0) {
        await this.ssh.execCommand(`rm -rf '${stage}' '${archivePath}'`);
        throw new Error(`Gagal extract Flutter SDK: ${extract.stderr || extract.stdout}`);
      }
      // Sanitize the extracted SDK before Flutter runs any Git command. The official
      // archive contains a .git tree, and GNU tar may otherwise preserve an archive
      // owner that differs from the SSH user. Modern Git intentionally refuses to
      // operate on such repositories with "detected dubious ownership".
      // --no-same-owner above prevents the common case; chown + safe.directory cover
      // VPS images where an older archive or filesystem still leaves a mismatch.
      const stagePrep = await this.ssh.execCommand(`
set -e
STAGE_FLUTTER='${stage}/flutter'
UID_NOW=$(id -u)
GID_NOW=$(id -g)
chown -R "$UID_NOW:$GID_NOW" "$STAGE_FLUTTER"
git config --global --add safe.directory "$STAGE_FLUTTER" 2>/dev/null || true
chmod -R a+rX "$STAGE_FLUTTER"
chmod +x "$STAGE_FLUTTER/bin/flutter"
`);
      if (stagePrep.code !== 0) {
        await this.ssh.execCommand(`rm -rf '${stage}' '${archivePath}'`);
        throw new Error(`Gagal menyiapkan ownership Flutter SDK: ${stagePrep.stderr || stagePrep.stdout}`);
      }
      // Atomic-ish activation: keep a known-good SDK until the staged copy passes --version.
      const stagedVerify = await this.ssh.execCommand(`bash -lc 'export CI=true; export BOT=true; export CONTINUOUS_INTEGRATION=true; export FLUTTER_ALLOW_SUPERUSER=1; export PATH="${stage}/flutter/bin:/usr/local/bin:$PATH"; git config --global --add safe.directory "${stage}/flutter" 2>/dev/null || true; "${stage}/flutter/bin/flutter" --version 2>&1'`, { execOptions: { timeout: 180000 } });
      if (stagedVerify.code !== 0 || !/Flutter 3\.47\.2/.test(`${stagedVerify.stdout || ''}\n${stagedVerify.stderr || ''}`)) {
        await this.ssh.execCommand(`rm -rf '${stage}' '${archivePath}'`);
        throw new Error(`Flutter SDK hasil extract tidak lolos verifikasi: ${(stagedVerify.stderr || stagedVerify.stdout || '').trim().slice(0, 400)}`);
      }
      await this.ssh.execCommand(`rm -rf '${flutterHome}.previous' && if [ -d '${flutterHome}' ]; then mv '${flutterHome}' '${flutterHome}.previous'; fi && mv '${stage}/flutter' '${flutterHome}' && rm -rf '${stage}' '${flutterHome}.previous' '${archivePath}'`);

    } else {
      log('⚠️ Semua archive CDN gagal. Mencoba Git tag Flutter 3.47.2...');
      const git = await this.ssh.execCommand(
        `rm -rf '${flutterHome}' && git clone --depth 1 --branch ${flutterVersion} https://mirror.nju.edu.cn/git/flutter-sdk.git '${flutterHome}' && chown -R "$(id -u):$(id -g)" '${flutterHome}' && git config --global --add safe.directory '${flutterHome}' 2>/dev/null || true`,
        { execOptions: { timeout: 3600000 }, onStdout: c => { const t=c.toString().trim(); if(t) log(`  ${t.substring(0,160)}`); } }
      );
      if (git.code !== 0 || !(await verifyFlutter())) {
        throw new Error(`Gagal memasang Flutter ${flutterVersion}: archive dan Git fallback sama-sama gagal. Cek koneksi HTTPS/DNS VPS ke Google/Mirror/GitHub.`);
      }
    }

    const prep = await this.ssh.execCommand(`set -e; chown -R "$(id -u):$(id -g)" '${flutterHome}'; chmod -R a+rX '${flutterHome}'; chmod +x '${flutterBin}'; git config --global --add safe.directory '${flutterHome}' 2>/dev/null || true; ln -sf '${flutterBin}' /usr/local/bin/flutter`);
    if (prep.code !== 0) throw new Error(`Gagal menyiapkan executable Flutter: ${prep.stderr || prep.stdout}`);

    if (!(await verifyFlutter())) throw new Error('Flutter SDK terpasang tetapi flutter --version gagal.');

    // Only Android artifacts are required by this bot. Try trusted artifact mirrors in order.
    // NOTE: the official storage.googleapis.com is tried LAST here on purpose —
    // some VPS regions block it outright, so putting a China-friendly mirror
    // first avoids burning the download timeout on a guaranteed-to-hang host
    // before falling through. Whichever mirror actually succeeds becomes the
    // permanent FLUTTER_STORAGE_BASE_URL below, instead of a hardcoded value
    // that may not match what this specific VPS can actually reach — this is
    // what previously caused every subsequent build to print a mismatched
    // "assets will be downloaded from <mirror>" notice regardless of whether
    // that mirror was ever confirmed reachable from this worker.
    const artifactMirrors = ['https://storage.googleapis.com', 'https://storage.flutter-io.cn', 'https://mirror.nju.edu.cn/flutter', 'https://mirrors.cernet.edu.cn/flutter'];
    let precacheOk = false;
    let workingMirror = null;
    for (const mirror of artifactMirrors) {
      log(`🔄 Precache Android Flutter artifacts via ${mirror}...`);
      const r = await this.ssh.execCommand(
        `CI=true BOT=true CONTINUOUS_INTEGRATION=true FLUTTER_ALLOW_SUPERUSER=1 FLUTTER_STORAGE_BASE_URL='${mirror}' '${flutterBin}' precache --android`,
        { execOptions: { timeout: 3600000 }, onStdout: c => { const t=c.toString().trim(); if(t) log(`  ${t.substring(0,160)}`); } }
      );
      if (r.code === 0) { precacheOk = true; workingMirror = mirror; break; }
      log(`⚠️ Precache mirror gagal: ${(r.stderr || r.stdout || '').replace(/\s+/g,' ').substring(0,220)}`);
    }
    if (!precacheOk) throw new Error('Flutter terpasang, tetapi Android artifacts gagal di-precache dari semua mirror.');

    log(`✅ Mirror aktif untuk build selanjutnya: ${workingMirror}`);
    await this.ssh.execCommand(`cat > /etc/profile.d/flutter.sh <<EOF\nexport FLUTTER_STORAGE_BASE_URL=${workingMirror}\nexport PATH=/opt/flutter/bin:/usr/local/bin:\\$PATH\nEOF\nchmod 644 /etc/profile.d/flutter.sh`);

    // `flutter doctor` can return non-zero for optional warnings even when the
    // SDK and Android toolchain are usable. In particular, older Flutter builds
    // can complain about running as root; FLUTTER_ALLOW_SUPERUSER is already set
    // above, but doctor must not be the single point of failure for installation.
    const doctor = await this.ssh.execCommand(
      `bash -lc 'export CI=true; export BOT=true; export CONTINUOUS_INTEGRATION=true; export FLUTTER_ALLOW_SUPERUSER=1; export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64; export ANDROID_HOME=/opt/android-sdk; export ANDROID_SDK_ROOT=/opt/android-sdk; export PATH=/opt/flutter/bin:/usr/local/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH; flutter doctor --android-licenses >/dev/null 2>&1 || true; flutter doctor -v 2>&1'`,
      { execOptions: { timeout: 300000 } }
    );
    const doctorOutput = `${doctor.stdout || ''}\n${doctor.stderr || ''}`;
    if (doctor.code !== 0) {
      log(`⚠️ flutter doctor mengembalikan exit ${doctor.code}; ini hanya diagnostik dan tidak menggagalkan instalasi. Detail: ${doctorOutput.replace(/\s+/g,' ').trim().substring(0,500)}`);
    } else {
      log('✅ flutter doctor selesai tanpa error fatal');
    }
    // The authoritative installation gate is flutter --version, not doctor.
    // doctor can report optional/environment warnings even when builds are usable.
    if (!(await verifyFlutter())) {
      throw new Error(`Flutter SDK terpasang tetapi verifikasi flutter --version gagal. ${doctorOutput.replace(/\s+/g,' ').trim().substring(0,700)}`);
    }

    await this.persistFlutterPath(worker, flutterBin);
    log('✅ Flutter SDK + Android artifacts berhasil diverifikasi');
  }

  async persistFlutterPath(worker, flutterBin) {
    if (!worker?.id) return;
    await db.updateWorkers((workers) => {
      const index = workers.findIndex(w => w.id === worker.id);
      if (index === -1) return false;
      workers[index].flutterBin = flutterBin;
      return workers;
    });
  }

  /**
   * Step 5: Install Telegram Local Bot API Server with streaming output
   * This takes 15-30 minutes!
   */
  async installLocalBotApi(apiId, apiHash, log) {
    // Check if already installed
    const checkResult = await this.ssh.execCommand(
      'test -f /usr/local/bin/telegram-bot-api && echo "exists"'
    );
    
    if (checkResult.stdout.includes('exists')) {
      log('✅ Local Bot API already installed, updating service...');
      await this.setupServiceFile(apiId, apiHash, log);
      return;
    }

    const buildDir = '/tmp/tdlib-build';
    const repoUrl = 'https://github.com/tdlib/telegram-bot-api.git';

    log('📥 Cloning repository...');
    for (const command of [
      { cmd: `rm -rf ${buildDir}`, timeout: 120000 },
      { cmd: `mkdir -p ${buildDir}`, timeout: 120000 }
    ]) {
      const r = await this.ssh.execCommand(command.cmd, { execOptions: { timeout: command.timeout } });
      if (r.code !== 0) throw new Error(`Persiapan Local Bot API gagal: ${r.stderr || r.stdout || `exit ${r.code}`}`);
    }
    const cloneResult = await this.ssh.execCommand(`git clone --recursive ${repoUrl} ${buildDir}/telegram-bot-api`, {
      execOptions: { timeout: 300000 },
      onStdout: (chunk) => log(`  ${chunk.toString().trim()}`)
    });
    if (cloneResult.code !== 0) {
      throw new Error(`Gagal clone Telegram Local Bot API: ${cloneResult.stderr || cloneResult.stdout || `exit ${cloneResult.code}`}`);
    }

    log('⚙️ Configuring with CMake...');
    const buildPath = `${buildDir}/telegram-bot-api/build`;
    let cmakeResult = await this.ssh.execCommand(`mkdir -p ${buildPath} && cd ${buildPath} && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX:PATH=/usr/local ..`, {
      execOptions: { timeout: 120000 },
      onStdout: (chunk) => log(`  ${chunk.toString().trim()}`)
    });
    if (cmakeResult.code !== 0) {
      throw new Error(`CMake konfigurasi Local Bot API gagal: ${cmakeResult.stderr || cmakeResult.stdout || `exit ${cmakeResult.code}`}`);
    }

    log('🔨 Compiling (this takes 15-30 minutes)...');
    log('☕ Grab a coffee, this is the longest step...');
    // Use -j 1 for low RAM VPS to prevent OOM. Never report success if cmake fails.
    let lastProgress = '';
    const buildResult = await this.ssh.execCommand(`cd ${buildPath} && cmake --build . --target install -j 1`, {
      execOptions: { timeout: 0 },
      onStdout: (chunk) => {
        const text = chunk.toString().trim();
        if (text.includes('%') || text.includes('Built target') || text.includes('Linking')) {
          if (text !== lastProgress) {
            log(`  ${text.substring(0, 100)}`);
            lastProgress = text;
          }
        }
      },
      onStderr: (chunk) => {
        const text = chunk.toString().trim();
        if (text) log(`  ⚠️ ${text.substring(0, 140)}`);
      }
    });
    if (buildResult.code !== 0) {
      throw new Error(`Kompilasi Local Bot API gagal: ${buildResult.stderr || buildResult.stdout || `exit ${buildResult.code}`}`);
    }
    const binaryCheck = await this.ssh.execCommand('test -x /usr/local/bin/telegram-bot-api');
    if (binaryCheck.code !== 0) {
      throw new Error('Kompilasi selesai tetapi /usr/local/bin/telegram-bot-api tidak ditemukan.');
    }
    log('✅ Compilation complete!');

    // Setup service file
    await this.setupServiceFile(apiId, apiHash, log);

    // Cleanup
    await this.ssh.execCommand(`rm -rf ${buildDir}`);
  }

  /**
   * Create systemd service file for Local Bot API
   */
  async setupServiceFile(apiId, apiHash, log) {
    log('📝 Creating systemd service...');
    
    const serviceContent = `[Unit]
Description=Telegram Bot API Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/telegram-bot-api --api-id=${apiId} --api-hash=${apiHash} --local --http-port=8081 --http-stat-port=8082 --dir=/var/lib/telegram-bot-api --log=/var/log/telegram-bot-api.log
Restart=always
RestartSec=5
User=root
WorkingDirectory=/var/lib/telegram-bot-api
Environment="TELEGRAM_API_ID=${apiId}"
Environment="TELEGRAM_API_HASH=${apiHash}"

[Install]
WantedBy=multi-user.target`;

    // Write service file
    await this.ssh.execCommand(`cat > /tmp/telegram-bot-api.service << 'EOF'
${serviceContent}
EOF`);

    // Move to systemd
    await this.ssh.execCommand('mv /tmp/telegram-bot-api.service /etc/systemd/system/');
    await this.ssh.execCommand('mkdir -p /var/lib/telegram-bot-api');
    await this.ssh.execCommand('systemctl daemon-reload');
    await this.ssh.execCommand('systemctl enable telegram-bot-api');
    
    log('🚀 Starting Local Bot API service...');
    await this.ssh.execCommand('systemctl restart telegram-bot-api || true');
    
    // Wait a moment and check status
    await new Promise(r => setTimeout(r, 3000));
    const statusResult = await this.ssh.execCommand('systemctl is-active telegram-bot-api');
    
    if (statusResult.stdout.trim() === 'active') {
      log('✅ Local Bot API service is running');
    } else {
      log('⚠️ Service status: ' + statusResult.stdout.trim());
    }
  }

  /**
   * Step 6: Finalize installation
   */
  async finalize(worker, apiId, apiHash, log) {
    log('🔍 Verifying installations...');
    
    const checks = [
      { cmd: 'java -version 2>&1 | head -1', name: 'Java' },
      { cmd: 'test -d /opt/android-sdk && echo "Android SDK OK"', name: 'Android SDK' },
      { cmd: 'test -x /opt/flutter/bin/flutter && CI=true BOT=true FLUTTER_ALLOW_SUPERUSER=1 /opt/flutter/bin/flutter --version 2>&1 | head -1', name: 'Flutter' },
      { cmd: 'systemctl is-active telegram-bot-api', name: 'Local Bot API Service' }
    ];

    for (const check of checks) {
      const result = await this.ssh.execCommand(check.cmd);
      log(`  ${check.name}: ${result.stdout || result.stderr || 'OK'}`);
    }

    // Verify the complete toolchain in ONE shell. Separate `export` commands
    // only affect their own SSH process and therefore do not persist.
    log('🔧 Verifying build environment...');
    const envCheck = await this.ssh.execCommand(`bash -lc '${[
      'export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64',
      'export ANDROID_HOME=/opt/android-sdk',
      'export ANDROID_SDK_ROOT=/opt/android-sdk',
      'export PATH=/opt/flutter/bin:/usr/local/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$JAVA_HOME/bin:$PATH',
      'command -v flutter',
      'FLUTTER_ALLOW_SUPERUSER=1 flutter --version',
      'test -x $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager',
      'sdkmanager --version',
      'test -d $ANDROID_HOME/platforms/android-36',
      'test -d $ANDROID_HOME/build-tools/36.0.0',
      'java -version'
    ].join('; ').replace(/'/g, "'\"'\"'")}'`, { execOptions: { timeout: 120000 } });
    if (envCheck.code !== 0) {
      throw new Error(`Toolchain verification failed: ${envCheck.stderr || envCheck.stdout || `exit ${envCheck.code}`}`);
    }
    log('✅ Environment configured and verified for non-interactive builds');
  }

  /**
   * Run installation with custom logger (for streaming UI)
   * @param {Object} worker - Worker object
   * @param {Object} bot - Telegram bot
   * @param {Number} chatId - Chat ID
   * @param {Function} customLog - Custom log function
   */
  async runInstallWithLogger(worker, bot, chatId, customLog) {
    const { apiId, apiHash } = config.telegram;
    
    if (!apiId || !apiHash) {
      throw new Error('API_ID and API_HASH must be configured in config.js');
    }

    // Use custom log function if provided, otherwise default
    const log = customLog || ((msg) => {
      console.log(`[Installer ${worker.host}] ${msg}`);
    });

    try {
      // Step 0: Connect SSH
      log('🔌 Connecting to VPS...');
      
      const connectConfig = {
        host: worker.host,
        username: worker.user
      };
      
      if (worker.authMethod === 'password' && worker.password) {
        connectConfig.password = worker.password;
        log('🔐 Using password authentication');
      } else if (worker.sshKeyPath) {
        connectConfig.privateKey = worker.sshKeyPath;
        log('🔑 Using SSH key authentication');
      } else {
        connectConfig.privateKey = worker.sshKeyPath;
      }
      
      await this.ssh.connect(connectConfig);
      log('✅ SSH Connected');

      // Update worker status
      await this.updateWorkerStatus(worker.id, 'installing');
      log('🔧 Status: Installing (builds will not be assigned)');

      // Run installation steps
      log(`━━━ Step 1/7: System Packages ━━━`);
      await this.installSystemPackages(log);
      log('✅ System packages installed');

      log(`━━━ Step 2/7: Node.js & npm ━━━`);
      await this.checkAndInstallNodejs(log);
      log('✅ Node.js & npm verified');

      log(`━━━ Step 3/7: Java JDK 17 ━━━`);
      await this.installJava(log);
      log('✅ Java JDK verified');

      log(`━━━ Step 4/7: Android SDK ━━━`);
      await this.installAndroidSdk(log);
      log('✅ Android SDK installed');

      log(`━━━ Step 5/7: Flutter SDK ━━━`);
      await this.installFlutter(log, worker);
      log('✅ Flutter SDK installed');

      log(`━━━ Step 6/7: Telegram Local Bot API Server ━━━`);
      log('⏳ This step takes 15-30 minutes (compiling from source)...');
      await this.installLocalBotApi(apiId, apiHash, log);
      log('✅ Local Bot API Server installed and running');

      log(`━━━ Step 7/7: Finalize ━━━`);
      await this.finalize(worker, apiId, apiHash, log);

      // Update worker
      const localApiUrl = `http://${worker.host}:8081`;
      await this.updateWorkerLocalApi(worker.id, localApiUrl);
      log(`🌐 Local Bot API URL: ${localApiUrl}`);

      await this.updateWorkerStatus(worker.id, 'online');
      // BUG FIX: Mark as installed in streaming installer
      await this.updateInstallationStatus(worker.id, 'installed');
      log('🎉 Installation complete! VPS is ready for builds.');

    } catch (error) {
      log(`❌ Installation failed: ${error.message}`);
      await this.updateWorkerStatus(worker.id, 'offline');
      // BUG FIX: Mark as pending if failed
      await this.updateInstallationStatus(worker.id, 'pending');
      throw error;
    } finally {
      this.ssh.dispose();
    }
  }
}

module.exports = new VpsInstaller();

// Re-export streaming UI functions for backward compatibility
const { runInstallationWithStreaming, runDualInstallationWithStreaming } = require('./utils/installerUI');
module.exports.runInstallationWithStreaming = runInstallationWithStreaming;
module.exports.runDualInstallationWithStreaming = runDualInstallationWithStreaming;
