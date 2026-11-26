const db = require('../bot/db');
const config = require('../config');
const ownerService = require('../bot/utils/ownerService');
const { NodeSSH } = require('node-ssh');
const axios = require('axios');
const http = require('http');
const https = require('https');

function normalizeWorkerStatus(status) {
  const raw = String(status || '').toLowerCase();
  if (raw.includes('offline')) return 'offline';
  if (raw.includes('install')) return 'installing';
  if (raw.includes('cooldown')) return 'cooldown';
  if (raw.includes('build')) return 'building';
  if (raw.includes('online') || raw.includes('ready')) return 'online';
  return 'unknown';
}

class HealthMonitor {
  constructor() {
    this.interval = null;
  }

  start(bot) {
    if (!config.healthMonitor.enabled) return;

    // Track consecutive failures per worker
    this.consecutiveFailures = new Map();

    this.interval = setInterval(async () => {
      try {
        // BUG FIX: sebelumnya baca semua worker di AWAL siklus, lalu ping satu-satu
        // (proses ini bisa makan waktu, apalagi kalau ada worker yang timeout),
        // dan baru menyimpan balik SEMUA worker di akhir siklus. Kalau di tengah
        // proses ini installer.js/admin.js menulis perubahan lain (mis. status
        // 'installing' -> 'online'), tulisan health monitor di akhir akan menimpa
        // balik dengan data LAMA (stale) -> data worker bisa salah/hilang.
        // Fix: kumpulkan hasil ping dulu (read-only), baru terapkan perubahan status
        // via db.updateWorkers() yang membaca ULANG data terbaru sebelum menulis
        // secara atomik dalam satu lock, jadi tidak menimpa perubahan lain.
        const workers = await db.getWorkers();
        const statusChanges = new Map(); // workerId -> { newStatus, lastPingAt }

        for (const worker of workers) {
          if (worker.enabled === false) continue;

          // Wrap each worker check in try-catch to prevent one failure from breaking all
          let isAlive = false;
          try {
            isAlive = await this.pingWorker(worker);
          } catch (pingError) {
            // Handle ETIMEDOUT and other connection errors gracefully
            if (pingError.code === 'ETIMEDOUT' || pingError.code === 'ECONNRESET') {
              console.warn(`[HealthMonitor] ${worker.id} ping error (connection timeout)`);
            } else {
              console.warn(`[HealthMonitor] ${worker.id} ping error: ${pingError.message}`);
            }
            isAlive = false;
          }

          const lastStatus = worker.status;
          const statusKind = normalizeWorkerStatus(worker.status);
          let newStatus = worker.status;

          // Track failures with grace period
          const failures = this.consecutiveFailures.get(worker.id) || 0;

          if (!isAlive) {
            this.consecutiveFailures.set(worker.id, failures + 1);

            // Only mark as offline after 2 consecutive failures (grace period)
            if (failures + 1 >= 2) {
              newStatus = 'offline';
            } else {
              console.log(`[HealthMonitor] ${worker.id} ping failed (attempt ${failures + 1}/2), keeping current status`);
              // Keep current status for now
              newStatus = lastStatus;
            }
          } else {
            // Reset failures on success
            this.consecutiveFailures.set(worker.id, 0);

            if (statusKind === 'installing') {
              newStatus = 'installing';
            } else if (statusKind === 'cooldown' && worker.cooldownUntil && Date.now() < worker.cooldownUntil) {
              newStatus = 'cooldown';
            } else if (statusKind === 'building') {
              // Keep building status if currently building
              newStatus = 'building';
            } else {
              newStatus = 'online';
            }
          }

          if (String(lastStatus || '') !== String(newStatus || '')) {
            statusChanges.set(worker.id, { newStatus, lastPingAt: new Date().toISOString() });

            if (newStatus === 'offline' && config.healthMonitor.alertAdminOnOffline) {
              this.alertAdmins(bot, `⚠️ Worker ${worker.label} (${worker.id}) is OFFLINE!`);
            } else if (newStatus === 'online' && lastStatus === 'offline') {
              console.log(`[HealthMonitor] ${worker.id} recovered to ONLINE`);
            }
          }
        }

        if (statusChanges.size > 0) {
          // Terapkan perubahan ke data TERBARU (dibaca ulang di dalam lock),
          // bukan ke snapshot lama, supaya tidak menimpa update dari proses lain.
          await db.updateWorkers((freshWorkers) => {
            for (const w of freshWorkers) {
              const change = statusChanges.get(w.id);
              if (change) {
                w.status = change.newStatus;
                w.lastPingAt = change.lastPingAt;
              }
            }
            return freshWorkers;
          });
        }
      } catch (intervalError) {
        // Global error handler to prevent health monitor from crashing
        console.error('[HealthMonitor] Error during health check cycle:', intervalError.message);
        if (intervalError.code === 'ETIMEDOUT') {
          console.warn('[HealthMonitor] Connection timeout detected - network issue or blocked event loop');
        }
      }
    }, config.healthMonitor.intervalSeconds * 1000);
  }

  async pingWorker(worker) {
    if (worker.type === 'vps') {
      // Method 1: Try SSH connection with retry - shorter timeout for health check
      const sshAttempts = 2;
      const healthCheckTimeout = 5000; // 5 seconds max for health check SSH

      for (let attempt = 1; attempt <= sshAttempts; attempt++) {
        try {
          const ssh = new NodeSSH();
          const connectConfig = {
            host: worker.host,
            username: worker.user,
            readyTimeout: healthCheckTimeout, // SSH handshake timeout
            timeout: healthCheckTimeout // Connection timeout
          };

          if (worker.authMethod === 'password' && worker.password) {
            connectConfig.password = worker.password;
          } else if (worker.sshKeyPath) {
            connectConfig.privateKey = worker.sshKeyPath;
          } else if (worker.sshKey) {
            connectConfig.privateKey = worker.sshKey;
          }

          await ssh.connect(connectConfig);
          ssh.dispose();
          console.log(`[HealthMonitor] ${worker.id} SSH ping successful (attempt ${attempt}/${sshAttempts})`);
          return true;
        } catch (error) {
          console.warn(`[HealthMonitor] ${worker.id} SSH ping attempt ${attempt}/${sshAttempts} failed: ${error.message}`);
          if (attempt < sshAttempts) {
            await new Promise(r => setTimeout(r, 1000)); // Wait 1s before retry
          }
        }
      }

      // Method 2: Fallback - Try ping Local Bot API via HTTP with AbortController
      const apiPort = Number(worker.apiPort) > 0 ? worker.apiPort : 8081;
      try {
        const botToken = config.telegram.botToken;
        const apiUrl = `http://${worker.host}:${apiPort}/bot${botToken}/getMe`;
        console.log(`[HealthMonitor] ${worker.id} SSH failed, trying HTTP fallback`);

        // Use AbortController for true cancellation
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second hard timeout

        try {
          const response = await axios.get(apiUrl, {
            signal: controller.signal,
            timeout: 3000, // 3 second timeout
            // Prevent connection pooling issues
            httpAgent: new http.Agent({ keepAlive: false }),
            httpsAgent: new https.Agent({ keepAlive: false }),
            // Fail fast on connection errors
            validateStatus: () => true // Accept any status code, we just want to know if host is reachable
          });

          clearTimeout(timeoutId);

          if (response.status === 200 && response.data?.ok) {
            console.log(`[HealthMonitor] ${worker.id} HTTP fallback successful`);
            return true;
          }
          // Even if getMe fails (e.g., wrong token), if we got a response, host is up
          if (response.status !== 0) {
            console.log(`[HealthMonitor] ${worker.id} HTTP reachable (status ${response.status})`);
            return true;
          }
        } catch (axiosError) {
          clearTimeout(timeoutId);
          if (axiosError.name === 'AbortError' || axiosError.code === 'ECONNABORTED') {
            console.warn(`[HealthMonitor] ${worker.id} HTTP fallback timed out`);
          } else if (axiosError.code === 'ETIMEDOUT' || axiosError.code === 'ECONNREFUSED') {
            console.warn(`[HealthMonitor] ${worker.id} HTTP fallback connection failed: ${axiosError.code}`);
          } else {
            console.warn(`[HealthMonitor] ${worker.id} HTTP fallback failed: ${axiosError.message}`);
          }
        }
      } catch (httpError) {
        console.warn(`[HealthMonitor] ${worker.id} HTTP fallback error: ${httpError.message}`);
      }

      // All methods failed
      console.error(`[HealthMonitor] ${worker.id} All ping methods failed (SSH x${sshAttempts}, HTTP fallback)`);
      return false;
    }

    if (worker.type === 'github') {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await axios.get(`https://api.github.com/repos/${worker.repo}`, {
          headers: {
            Authorization: `Bearer ${worker.token}`,
            Accept: 'application/vnd.github.v3+json'
          },
          signal: controller.signal,
          timeout: 10000
        });

        clearTimeout(timeoutId);
        return response.status === 200;
      } catch (error) {
        console.error(`Ping GH Actions ${worker.id} failed:`, error.message);
        return false;
      }
    }

    return false;
  }

  alertAdmins(bot, message) {
    const adminIds = ownerService.getAllAdminIds();
    adminIds.forEach(id => {
      bot.sendMessage(id, message).catch(console.error);
    });
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }
}

module.exports = new HealthMonitor();
