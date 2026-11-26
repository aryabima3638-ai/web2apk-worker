const db = require('../db');
const config = require('../../config');
const session = require('../session/state');
const installer = require('../../worker/installer');
const { runInstallationWithStreaming, runDualInstallationWithStreaming } = installer;
const maintenance = require('../utils/maintenance');

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function adminHandler(bot, msg, isReply = false) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Multi-step logic - REMOVED for /addvps and /addghaction
  // Now only one-liner format:
  // /addvps label|host|user|password
  // /addghaction label|token|repo
  if (isReply) {
    const state = session.get(userId);
    if (!state) return;
    // No more wizard steps - all one-liner now
    return;
  }

  const command = text.split(' ')[0];
  const argsRaw = text.trim().split(/\s+/);

  // /maintenance [on|off] [alasan...] - Toggle maintenance mode dengan alasan opsional
  // Contoh pemakaian:
  //   /maintenance on                     -> maintenance ON tanpa alasan custom
  //   /maintenance on update sistem       -> maintenance ON dengan alasan "update sistem"
  //   /maintenance off                    -> maintenance OFF
  if (command === '/maintenance') {
    const action = String(argsRaw[1] || '').toLowerCase();
    // Ambil semua kata setelah "on"/"off" sebagai alasan (biar bisa multi-kata & bebas)
    const reasonText = text.trim().split(/\s+/).slice(2).join(' ').trim();

    if (!action || !['on', 'off'].includes(action)) {
      const status = maintenance.isEnabled() ? '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> ON' : '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> OFF';
      const currentReason = maintenance.getReason();
      const reasonLine = maintenance.isEnabled() && currentReason
        ? `\n<tg-emoji emoji-id="5258500400918587241">✍️</tg-emoji> Alasan saat ini: <i>${escapeHtml(currentReason)}</i>\n`
        : '';
      return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6206077285720659346">⚠️</tg-emoji> <b>MAINTENANCE MODE</b>
━━━━━━━━━━━━━━━━━━

Status: ${status}
${reasonLine}
<b>Penggunaan:</b>
<code>/maintenance on</code> - Aktifkan tanpa alasan
<code>/maintenance on &lt;alasan&gt;</code> - Aktifkan dengan alasan custom
<code>/maintenance off</code> - Matikan mode maintenance

<i>Contoh: /maintenance on update tipis-tipis</i>
<i>Saat ON, hanya admin yang bisa mengakses bot.</i>
      `.trim(), { parse_mode: 'HTML' });
    }

    const enabled = action === 'on';
    const ok = maintenance.set(enabled, reasonText);

    if (!ok) {
      return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Gagal mengubah status maintenance.', { parse_mode: 'HTML' });
    }

    const reasonBlock = enabled && reasonText
      ? `\n<tg-emoji emoji-id="5258500400918587241">✍️</tg-emoji> <b>Alasan:</b> ${escapeHtml(reasonText)}\n`
      : '';

    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="${enabled ? '6206077285720659346' : '6084551628461967966'}">${enabled ? '⚠️' : '✅'}</tg-emoji> <b>MAINTENANCE ${enabled ? 'AKTIF' : 'NONAKTIF'}</b>
━━━━━━━━━━━━━━━━━━
${reasonBlock}
${enabled ? 'User non-admin akan ditolak sementara.' : 'Semua user bisa menggunakan bot kembali.'}
    `.trim(), { parse_mode: 'HTML' });
  }

  // /stat, /setstat, /addstat, /resetstat, /setavg - kontrol statistik tampilan
  if (['/stat', '/setstat', '/addstat', '/resetstat', '/setavg'].includes(command)) {
    const formatTime = (totalSec) => {
      const sec = Math.max(0, Math.floor(Number(totalSec) || 0));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (m <= 0) return `${s}s`;
      return `${m}m ${s}s`;
    };

    const renderStats = async (title = '<tg-emoji emoji-id="5244837092042750681">📈</tg-emoji> <b>Statistik Build</b>') => {
      const stats = await db.getDisplayBuildStats();
      const modeText = stats.mode === 'manual' ? 'Manual + auto naik' : 'Auto database';
      return `${title}\n━━━━━━━━━━━━━━━━━━\n\n` +
        `<b>Tampilan bot:</b>\n` +
        `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <code>${stats.success}</code> berhasil\n` +
        `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <code>${stats.failed}</code> gagal\n` +
        `<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> <code>~${formatTime(stats.avgDurationSeconds)}</code> rata-rata\n\n` +
        `<b>Asli dari database:</b>\n` +
        `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <code>${stats.actual.success}</code> berhasil\n` +
        `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <code>${stats.actual.failed}</code> gagal\n\n` +
        `<b>Mode:</b> <code>${modeText}</code>\n\n` +
        `<b>Command:</b>\n` +
        `<code>/setstat 1000 600</code> — set angka tampilan\n` +
        `<code>/addstat 10 0</code> — tambah berhasil 10\n` +
        `<code>/addstat -5 -2</code> — kurangi statistik\n` +
        `<code>/resetstat</code> — pakai database asli\n` +
        `<code>/setavg 163</code> / <code>/setavg auto</code>`;
    };

    if (command === '/stat') {
      return bot.sendMessage(chatId, await renderStats(), { parse_mode: 'HTML' });
    }

    if (command === '/setstat') {
      const success = Number(argsRaw[1]);
      const failed = Number(argsRaw[2]);
      if (!Number.isFinite(success) || !Number.isFinite(failed) || success < 0 || failed < 0) {
        return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: <code>/setstat &lt;berhasil&gt; &lt;gagal&gt;</code>\nContoh: <code>/setstat 1000 600</code>', { parse_mode: 'HTML' });
      }
      await db.setDisplayBuildStats(success, failed, userId);
      return bot.sendMessage(chatId, await renderStats('<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Statistik tampilan berhasil diatur</b>'), { parse_mode: 'HTML' });
    }

    if (command === '/addstat') {
      const addSuccess = Number(argsRaw[1]);
      const addFailed = Number(argsRaw[2]);
      if (!Number.isFinite(addSuccess) || !Number.isFinite(addFailed)) {
        return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: <code>/addstat &lt;tambah_berhasil&gt; &lt;tambah_gagal&gt;</code>\nContoh: <code>/addstat 1000 0</code>', { parse_mode: 'HTML' });
      }
      await db.addDisplayBuildStats(addSuccess, addFailed, userId);
      return bot.sendMessage(chatId, await renderStats('<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Statistik tampilan berhasil diubah</b>'), { parse_mode: 'HTML' });
    }

    if (command === '/resetstat') {
      await db.resetDisplayBuildStats(userId);
      return bot.sendMessage(chatId, await renderStats('<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Statistik balik ke database asli</b>'), { parse_mode: 'HTML' });
    }

    if (command === '/setavg') {
      const value = String(argsRaw[1] || '').toLowerCase();
      if (!value) {
        return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: <code>/setavg &lt;detik|auto&gt;</code>\nContoh: <code>/setavg 163</code>', { parse_mode: 'HTML' });
      }
      if (value === 'auto') {
        await db.setBuildAvgDuration(null, userId);
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 1) {
          return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Detik harus angka minimal 1, atau pakai <code>auto</code>.', { parse_mode: 'HTML' });
        }
        await db.setBuildAvgDuration(seconds, userId);
      }
      return bot.sendMessage(chatId, await renderStats('<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>Rata-rata waktu berhasil diatur</b>'), { parse_mode: 'HTML' });
    }
  }

  // /workers - Show worker management menu
  if (command === '/workers') {
    const workersText = `<tg-emoji emoji-id="5350830704450086993">👷</tg-emoji> Fxhl Worker Management
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ VPS Management:
/addvps      - Tambah VPS Worker
/listvps     - Daftar VPS Worker
/delvps      - Hapus VPS Worker
/installvps  - Install deps di VPS
/cekvps      - Monitor & detail VPS Worker

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="6086843234032552712">⚡</tg-emoji> GitHub Actions Management:
/addghaction       - Tambah GitHub Actions Worker
/listghaction      - Daftar GitHub Actions Worker
/delghaction       - Hapus GitHub Actions Worker
/cekghaction       - Monitor & detail GitHub Actions Worker

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    return bot.sendMessage(chatId, workersText, { parse_mode: 'HTML' });
  }

  // /addvps - Format: /addvps label|host|user|password
  if (command === '/addvps') {
    const input = text.replace('/addvps', '').trim();
    
    if (!input) {
      return bot.sendMessage(chatId, `
<b><tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ TAMBAH VPS WORKER</b>
━━━━━━━━━━━━━━━━━━

<b>Format:</b>
<code>/addvps nama|ip|username|password</code>

<b>Keterangan:</b>
• <b>nama</b> — Nama VPS (contoh: Jakarta-01)
• <b>ip</b> — IP address VPS
• <b>username</b> — User SSH (contoh: root, ubuntu)
• <b>password</b> — Password SSH

<b>Contoh:</b>
<code>/addvps workervps-1|143.198.214.180|root|lorddzik</code>

<i><tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ 1 VPS = 1 build (tidak ada slot paralel)</i>
      `.trim(), { parse_mode: 'HTML' });
    }

    const parts = input.split('|').map(p => p.trim());
    if (parts.length < 4) {
      return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah! Gunakan: <code>/addvps nama|ip|user|password</code>', { parse_mode: 'HTML' });
    }

    const [label, host, user, password] = parts;
    
    // Generate unique ID
    const id = 'vps_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);

    const newWorker = {
      id,
      type: 'vps',
      label: label || `VPS ${host}`,
      enabled: true,
      host,
      user,
      password,
      authMethod: 'password',
      status: 'offline',
      lastPingAt: null,
      // BUG FIX #4: Add installation status tracking
      installationStatus: 'pending', // 'pending' | 'installing' | 'installed'
      installedAt: null
    };

    const workers = await db.getWorkers();
    
    // Check for duplicate worker by host
    const existingWorker = workers.find(w => w.host === host);
    if (existingWorker) {
      return bot.sendMessage(chatId, 
        `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>VPS dengan host ${host} sudah ada!</b>\n\n` +
        `<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> ID: <code>${existingWorker.id}</code>\n` +
        `<tg-emoji emoji-id="5298877105000439431">🏷</tg-emoji>️ Label: ${existingWorker.label}\n\n` +
        `Gunakan <code>/delvps ${existingWorker.id}</code> untuk menghapus yang lama jika ingin menambah ulang.`,
        { parse_mode: 'HTML' }
      );
    }
    
    workers.push(newWorker);
    await db.saveWorkers(workers);

    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>VPS WORKER ADDED</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> ID: <code>${id}</code>
<tg-emoji emoji-id="5298877105000439431">🏷</tg-emoji>️ Label: ${newWorker.label}
<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> Host: <code>${host}</code>
<tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> User: <code>${user}</code>
<tg-emoji emoji-id="5296369303661067030">🔒</tg-emoji> Password: <code>${'*'.repeat(password.length)}</code>

<i>Gunakan /installvps untuk install dependencies</i>
    `.trim(), { parse_mode: 'HTML' });
  }

  // /addghaction - Format: /addghaction label|token|repo
  if (command === '/addghaction') {
    const input = text.replace('/addghaction', '').trim();
    
    if (!input) {
      return bot.sendMessage(chatId, `
<b><tg-emoji emoji-id="6086843234032552712">⚡</tg-emoji> TAMBAH GITHUB ACTIONS WORKER</b>
━━━━━━━━━━━━━━━━━━

<b>Format:</b>
<code>/addghaction label|token|repo</code>

<b>Keterangan:</b>
• <b>label</b> — Nama worker (contoh: GH-Worker-1)
• <b>token</b> — GitHub Personal Access Token
• <b>repo</b> — Nama repo (format: username/repo)

<b>Contoh:</b>
<code>/addghaction GH-Worker-1|ghp_xxxxxxxxxxxx|user/web2apk-worker</code>

<i><tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ 1 Worker = 1 build (tidak ada slot paralel)</i>
      `.trim(), { parse_mode: 'HTML' });
    }

    const parts = input.split('|').map(p => p.trim());
    if (parts.length < 3) {
      return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah! Gunakan: <code>/addghaction label|token|repo</code>', { parse_mode: 'HTML' });
    }

    const [label, token, repo] = parts;
    
    // Generate unique ID
    const id = 'gh_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);

    const newWorker = {
      id,
      type: 'github',
      label: label || `GH ${repo}`,
      enabled: true,
      token,
      repo,
      workflows: {
        flutter: 'build-flutter.yml',
        android: 'build-android.yml'
      },
      status: '<tg-emoji emoji-id="5416081784641168838">🟢</tg-emoji> online',
      lastPingAt: null
    };

    const workers = await db.getWorkers();
    
    // Check for duplicate worker by repo
    const existingWorker = workers.find(w => w.type === 'github' && w.repo === repo);
    if (existingWorker) {
      return bot.sendMessage(chatId, 
        `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>GitHub Actions dengan repo ${repo} sudah ada!</b>\n\n` +
        `<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> ID: <code>${existingWorker.id}</code>\n` +
        `<tg-emoji emoji-id="5298877105000439431">🏷</tg-emoji>️ Label: ${existingWorker.label}\n\n` +
        `Gunakan <code>/delghaction ${existingWorker.id}</code> untuk menghapus yang lama jika ingin menambah ulang.`,
        { parse_mode: 'HTML' }
      );
    }
    
    workers.push(newWorker);
    await db.saveWorkers(workers);

    return bot.sendMessage(chatId, `
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>GITHUB ACTIONS WORKER ADDED</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5445353829304387411">🆔</tg-emoji> ID: <code>${id}</code>
<tg-emoji emoji-id="5298877105000439431">🏷</tg-emoji>️ Label: ${newWorker.label}
<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> Repo: <code>${repo}</code>
<tg-emoji emoji-id="5296369303661067030">🔒</tg-emoji> Token: <code>${'*'.repeat(token.length)}</code>

<i>Worker siap digunakan sebagai fallback.</i>
    `.trim(), { parse_mode: 'HTML' });
  }

  // /listvps
  if (command === '/listvps') {
    const workers = await db.getWorkers();
    const vps = workers.filter(w => w.type === 'vps');
    if (vps.length === 0) return bot.sendMessage(chatId, 'ℹ️ Tidak ada VPS worker.');
    let vpsText = '<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ Daftar VPS Worker\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    vps.forEach(w => {
      // Map status to emoji like Gen 4: offline, installing, online/ready, building, cooldown
      const statusIcon = w.status === 'building' ? '<tg-emoji emoji-id="5361734213370396027">🔨</tg-emoji>' : 
                         w.status === 'online' || w.status === 'ready' ? '<tg-emoji emoji-id="5416081784641168838">🟢</tg-emoji>' : 
                         w.status === 'offline' ? '<tg-emoji emoji-id="5411225014148014586">🔴</tg-emoji>' : 
                         w.status === 'installing' ? '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️' : 
                         w.status === 'cooldown' ? '<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji>' : '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️';
      vpsText += `${statusIcon} [${w.id}] ${w.label}\n   <tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> Host: ${w.host}\n   <tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status: ${w.status}\n\n`;
    });
    return bot.sendMessage(chatId, vpsText, { parse_mode: 'HTML' });
  }

  // /listghaction
  if (command === '/listghaction') {
    const workers = await db.getWorkers();
    const gh = workers.filter(w => w.type === 'github');
    if (gh.length === 0) return bot.sendMessage(chatId, 'ℹ️ Tidak ada GitHub Actions worker.');
    let ghText = '<tg-emoji emoji-id="6086843234032552712">⚡</tg-emoji> Daftar GitHub Actions Worker\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
    gh.forEach(w => {
      // Map status to emoji: offline, installing, online, building, cooldown
      const statusIcon = w.status === 'building' ? '<tg-emoji emoji-id="5361734213370396027">🔨</tg-emoji>' : 
                         w.status === 'online' || w.status === 'ready' ? '<tg-emoji emoji-id="5416081784641168838">🟢</tg-emoji>' : 
                         w.status === 'offline' ? '<tg-emoji emoji-id="5411225014148014586">🔴</tg-emoji>' : 
                         w.status === 'installing' ? '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️' : 
                         w.status === 'cooldown' ? '<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji>' : '<tg-emoji emoji-id="5341715473882955310">⚙</tg-emoji>️';
      ghText += `${statusIcon} [${w.id}] ${w.label}\n   <tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> Repo: ${w.repo}\n   <tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status: ${w.status}\n\n`;
    });
    return bot.sendMessage(chatId, ghText, { parse_mode: 'HTML' });
  }

  // /delvps & /delghaction (Basic ID implementation)
  if (command === '/delvps' || command === '/delghaction') {
    const args = text.split(' ');
    if (args.length < 2) return bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: ${command} &lt;workerId&gt;`, { parse_mode: 'HTML' });
    const workerId = args[1];
    const workers = await db.getWorkers();
    const filtered = workers.filter(w => w.id !== workerId);
    if (workers.length === filtered.length) return bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Worker ID ${workerId} tidak ditemukan.`, { parse_mode: 'HTML' });
    await db.saveWorkers(filtered);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Worker ${workerId} berhasil dihapus.`, { parse_mode: 'HTML' });
  }

  // /cekvps & /cekghaction
  if (command === '/cekvps' || command === '/cekghaction') {
    const args = text.split(' ');
    if (args.length < 2) return bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: ${command} &lt;workerId&gt;`, { parse_mode: 'HTML' });
    const workerId = args[1];
    const workers = await db.getWorkers();
    const worker = workers.find(w => w.id === workerId);
    if (!worker) return bot.sendMessage(chatId, `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Worker ID ${workerId} tidak ditemukan.`, { parse_mode: 'HTML' });
    
    // Get current build info if any
    const isBuilding = worker.status === 'building';
    const currentJob = isBuilding ? (worker.currentJobId || '-') : '-';
    
    let detail = `<tg-emoji emoji-id="5231012545799666522">🔍</tg-emoji> ${worker.label} — Detail\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    detail += `<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status    : ${worker.status}\n`;
    detail += `<tg-emoji emoji-id="5361734213370396027">🔨</tg-emoji> Build     : ${isBuilding ? 'Sedang build (' + currentJob + ')' : 'Idle'}\n`;
    detail += `<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Last ping : ${worker.lastPingAt || 'Belum pernah'}\n`;
    if (worker.type === 'vps') detail += `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> Host      : ${worker.host}\n`;
    if (worker.type === 'github') detail += `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> Repo      : ${worker.repo}\n`;
    
    return bot.sendMessage(chatId, detail, { parse_mode: 'HTML' });
  }

  if (command === '/addreseller') {
    const args = text.split(' ');
    if (args.length < 2) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: /addreseller &lt;userId&gt; [label]', { parse_mode: 'HTML' });
    const resellerId = parseInt(args[1], 10);
    if (!Number.isFinite(resellerId)) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> userId harus angka.', { parse_mode: 'HTML' });
    const label = args.slice(2).join(' ') || null;
    await db.addReseller(resellerId, 'user', userId, label);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Reseller berhasil ditambahkan: ${resellerId}${label ? ` (${label})` : ''}`, { parse_mode: 'HTML' });
  }

  if (command === '/delreseller') {
    const args = text.split(' ');
    if (args.length < 2) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: /delreseller &lt;userId&gt;', { parse_mode: 'HTML' });
    const resellerId = parseInt(args[1], 10);
    if (!Number.isFinite(resellerId)) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> userId harus angka.', { parse_mode: 'HTML' });
    await db.removeReseller(resellerId);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Reseller berhasil dihapus: ${resellerId}`, { parse_mode: 'HTML' });
  }

  if (command === '/listreseller') {
    const resellers = await db.getResellers();
    if (!Array.isArray(resellers) || resellers.length === 0) return bot.sendMessage(chatId, 'ℹ️ Tidak ada reseller.');
    let out = `<tg-emoji emoji-id="5445221832074483553">💼</tg-emoji> Daftar Reseller\n━━━━━━━━━━━━━━━━━━\n\n`;
    resellers.forEach((r, i) => {
      out += `${i + 1}. ${r.userId}${r.label ? ` — ${r.label}` : ''}${r.enabled === false ? ' (disabled)' : ''}\n`;
    });
    return bot.sendMessage(chatId, out, { parse_mode: 'HTML' });
  }

  // Handle other commands (addakses, delakses, listakses, broadcast) from the previous version
  // ... (I'll keep them here for completeness)
  if (command === '/addakses') {
    const args = text.split(' ');
    if (args.length < 3) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: /addakses &lt;userId&gt; &lt;hari/permanent&gt;', { parse_mode: 'HTML' });
    const targetUserId = parseInt(args[1]);
    const duration = args[2];
    
    let expiredAt = null;
    if (duration !== 'permanent') {
      const days = parseInt(duration);
      if (isNaN(days)) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Durasi harus angka atau "permanent".', { parse_mode: 'HTML' });
      const date = new Date();
      date.setDate(date.getDate() + days);
      expiredAt = date.toISOString();
    }
    
    await db.addMember(targetUserId, 'user', expiredAt, userId);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Akses member berhasil ditambahkan untuk user ${targetUserId}.`, { parse_mode: 'HTML' });
  }

  if (command === '/delakses') {
    const args = text.split(' ');
    if (args.length < 2) return bot.sendMessage(chatId, '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Format salah. Gunakan: /delakses &lt;userId&gt;', { parse_mode: 'HTML' });
    const targetUserId = parseInt(args[1]);
    await db.removeMember(targetUserId);
    return bot.sendMessage(chatId, `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Akses member berhasil dihapus untuk user ${targetUserId}.`, { parse_mode: 'HTML' });
  }

  if (command === '/listakses') {
    // Use accessKeyService for listing members from new system
    const accessKeyService = require('../utils/accessKeyService');
    const members = accessKeyService.listMembers();

    if (members.length === 0) return bot.sendMessage(chatId, 'ℹ️ Tidak ada member aktif.');

    // Parse page number from command (e.g., /listakses 2)
    const args = text.split(' ');
    let currentPage = 1;
    if (args.length >= 2) {
      const parsedPage = parseInt(args[1], 10);
      if (!isNaN(parsedPage) && parsedPage > 0) {
        currentPage = parsedPage;
      }
    }

    const itemsPerPage = 10;
    const totalPages = Math.ceil(members.length / itemsPerPage);

    // Ensure current page is within bounds
    if (currentPage > totalPages) currentPage = totalPages;

    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, members.length);
    const pageMembers = members.slice(startIndex, endIndex);

    // Fetch user info from Telegram API to get usernames
    const enrichMemberData = async (member) => {
      try {
        // Try to get user info from bot's chat with this user
        const chat = await bot.getChat(member.telegramId);
        return {
          ...member,
          username: chat.username || member.username,
          firstName: chat.first_name,
          lastName: chat.last_name
        };
      } catch (err) {
        // If failed (user blocked bot or never interacted), return original data
        return member;
      }
    };

    // Enrich all page members with user data
    const enrichedMembers = await Promise.all(pageMembers.map(enrichMemberData));

    let listText = `<tg-emoji emoji-id="5197269100878907942">📋</tg-emoji> <b>Daftar Member Aktif</b>\n`;
    listText += `━━━━━━━━━━━━━━━━━━\n`;
    listText += `<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Total: ${members.length} member | Halaman ${currentPage}/${totalPages}\n\n`;

    enrichedMembers.forEach((m, i) => {
      const globalIndex = startIndex + i + 1;
      const expired = m.expiresAt ? new Date(m.expiresAt).toLocaleDateString() : 'Permanent';
      // Show user with clickable link - prioritize username from Telegram
      let userDisplay;
      if (m.username) {
        userDisplay = `<a href="tg://user?id=${m.telegramId}">@${m.username}</a>`;
      } else if (m.firstName) {
        const fullName = `${m.firstName}${m.lastName ? ' ' + m.lastName : ''}`;
        userDisplay = `<a href="tg://user?id=${m.telegramId}">${fullName}</a>`;
      } else {
        userDisplay = `<a href="tg://user?id=${m.telegramId}">User ${m.telegramId}</a>`;
      }
      listText += `${globalIndex}. <tg-emoji emoji-id="5373012449597335010">👤</tg-emoji> ${userDisplay}\n   <tg-emoji emoji-id="5413879192267805083">📅</tg-emoji> Expired: ${expired}\n\n`;
    });

    // Build navigation keyboard if needed
    const keyboard = { inline_keyboard: [] };
    if (totalPages > 1) {
      const navButtons = [];
      if (currentPage > 1) {
        navButtons.push({ text: 'Prev', icon_custom_emoji_id: "6084901676886526521", callback_data: `listakses_page_${currentPage - 1}` });
      }
      navButtons.push({ text: `${currentPage}/${totalPages}`, icon_custom_emoji_id: "5433982607035474385", callback_data: 'listakses_current' });
      if (currentPage < totalPages) {
        navButtons.push({ text: 'Next', icon_custom_emoji_id: "6084704202880191624", callback_data: `listakses_page_${currentPage + 1}` });
      }
      keyboard.inline_keyboard.push(navButtons);
    }
    keyboard.inline_keyboard.push([{ text: 'Kembali ke Menu', icon_custom_emoji_id: "6084901676886526521", callback_data: 'main_menu' }]);

    return bot.sendMessage(chatId, listText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard
    });
  }

  if (command === '/broadcast') {
    const rawText = String(text || '');
    const broadcastText = rawText.replace(/^\/broadcast(?:@\w+)?\s*/i, '').trim();
    const replyMessage = msg.reply_to_message || null;
    const isReplyBroadcast = Boolean(replyMessage);

    if (!isReplyBroadcast && !broadcastText) {
      const users = await db.getUsers();
      return bot.sendMessage(chatId, `
<tg-emoji emoji-id="5370599459661045441">📢</tg-emoji> <b>BROADCAST CENTER</b>
━━━━━━━━━━━━━━━━━━

<b>Cara penggunaan:</b>
1. <b>Text Broadcast:</b>
<code>/broadcast &lt;pesan anda&gt;</code>

2. <b>Forward Message:</b>
Reply pesan apa pun lalu kirim <code>/broadcast</code>

3. <b>HTML Format:</b>
<code>/broadcast &lt;b&gt;Bold&lt;/b&gt; &lt;i&gt;Italic&lt;/i&gt;</code>

<tg-emoji emoji-id="5453957997418004470">👥</tg-emoji> Total users: <code>${Array.isArray(users) ? users.length : 0}</code>
      `.trim(), { parse_mode: 'HTML' });
    }

    const users = await db.getUsers();
    if (!Array.isArray(users) || users.length === 0) {
      return bot.sendMessage(chatId, 'ℹ️ Belum ada user untuk broadcast.');
    }

    const estimatedTime = Math.ceil(users.length * 0.05);
    const preview = isReplyBroadcast
      ? '<tg-emoji emoji-id="5305265301917549162">📎</tg-emoji> <i>(Forward dari pesan yang di-reply)</i>'
      : escapeHtml(broadcastText.slice(0, 200) + (broadcastText.length > 200 ? '...' : ''));

    const confirmMsg = await bot.sendMessage(chatId, `
<tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ <b>KONFIRMASI BROADCAST</b>
━━━━━━━━━━━━━━━━━━

<tg-emoji emoji-id="5453957997418004470">👥</tg-emoji> Target: <code>${users.length}</code> user
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Estimasi: <code>~${estimatedTime}</code> detik
<tg-emoji emoji-id="5253742260054409879">📨</tg-emoji> Tipe: ${isReplyBroadcast ? 'Forward Message' : 'Text Message'}

<tg-emoji emoji-id="5258500400918587241">📝</tg-emoji> <b>Preview:</b>
${preview}

Klik tombol untuk lanjut.
    `.trim(), {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Mulai Broadcast', icon_custom_emoji_id: "5321131452274847846", callback_data: 'bc_confirm' },
            { text: 'Batal', icon_custom_emoji_id: "5210952531676504517", callback_data: 'bc_cancel' }
          ]
        ]
      }
    });

    global.pendingBroadcast = {
      adminUserId: userId,
      adminChatId: chatId,
      confirmMsgId: confirmMsg.message_id,
      isReply: isReplyBroadcast,
      textContent: broadcastText,
      replyMsgId: isReplyBroadcast ? replyMessage.message_id : null,
      users,
      createdAt: Date.now(),
      processing: false
    };

    return;
  }

  // /installvps [id1] [id2] - Install dependencies on VPS worker(s)
  // Supports: /installvps (show list), /installvps <id>, /installvps <id1> <id2>
  if (command === '/installvps') {
    const args = text.split(' ').slice(1).filter(arg => arg.trim());
    
    // Check if API_ID and API_HASH are configured
    if (!config.telegram.apiId || !config.telegram.apiHash) {
      return bot.sendMessage(chatId, 
        '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>API_ID dan API_HASH belum dikonfigurasi!</b>\n\n' +
        'Tambahkan ke config.js:\n' +
        '<code>apiId: "your_api_id",</code>\n' +
        '<code>apiHash: "your_api_hash",</code>\n\n' +
        'Dapatkan dari https://my.telegram.org',
        { parse_mode: 'HTML' }
      );
    }

    const workers = await db.getWorkers();
    
    // If no args, show VPS list with usage hint
    if (args.length === 0) {
      const vpsWorkers = workers.filter(w => w.type === 'vps');
      
      if (vpsWorkers.length === 0) {
        return bot.sendMessage(chatId, 
          'ℹ️ Tidak ada VPS worker.\n\n' +
          'Tambahkan dengan <code>/addvps</code> terlebih dahulu.\n\n' +
          '<b>Cara penggunaan:</b>\n' +
          '<code>/installvps</code> - Tampilkan list VPS\n' +
          '<code>/installvps &lt;id&gt;</code> - Install 1 VPS\n' +
          '<code>/installvps &lt;id1&gt; &lt;id2&gt;</code> - Install 2 VPS',
          { parse_mode: 'HTML' }
        );
      }

      // BUG FIX #5: Build inline keyboard - only show installvps for non-installed workers
      const keyboard = vpsWorkers.map(w => {
        const isInstalled = w.installationStatus === 'installed';
        const installIndicator = isInstalled ? '✅' : '⏳';
        const statusText = isInstalled ? 'Installed' : (w.status || 'pending');
        return [{
          text: `${installIndicator} ${w.label} (${statusText})`,
          callback_data: isInstalled ? `vps_info_${w.id}` : `installvps_${w.id}`
        }];
      });

      return bot.sendMessage(chatId, 
        '<tg-emoji emoji-id="5462921117423384478">🛠</tg-emoji>️ <b>Pilih VPS untuk Install Toolchain</b>\n\n' +
        'Ini akan menginstall:\n' +
        '• System packages (ninja-build, cmake, unzip)\n' +
        '• Java JDK 17\n' +
        '• Android SDK (commandlinetools, platform-tools)\n' +
        '• Flutter SDK\n' +
        '• Telegram Local Bot API Server\n\n' +
        '<b><tg-emoji emoji-id="5411369574157286161">📖</tg-emoji> Cara Penggunaan:</b>\n' +
        '<code>/installvps</code> - Tampilkan list ini\n' +
        '<code>/installvps vps_xxx</code> - Install 1 VPS\n' +
        '<code>/installvps vps_xxx vps_yyy</code> - Install 2 VPS sekaligus\n\n' +
        '<i><tg-emoji emoji-id="5447644880824181073">⚠</tg-emoji>️ Proses membutuhkan waktu 15-20 menit</i>',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: keyboard
          }
        }
      );
    }

    // Validate VPS IDs
    const vpsIds = args.slice(0, 2); // Max 2 VPS
    const validWorkers = [];
    const invalidIds = [];

    for (const id of vpsIds) {
      const worker = workers.find(w => w.id === id && w.type === 'vps');
      if (worker) {
        validWorkers.push(worker);
      } else {
        invalidIds.push(id);
      }
    }

    if (invalidIds.length > 0) {
      return bot.sendMessage(chatId, 
        `<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>VPS ID tidak ditemukan:</b> <code>${invalidIds.join(', ')}</code>\n\n` +
        `Gunakan <code>/listvps</code> untuk melihat daftar VPS.`,
        { parse_mode: 'HTML' }
      );
    }

    if (validWorkers.length === 1) {
      // Single VPS installation
      const worker = validWorkers[0];
      const statusMsg = await bot.sendMessage(chatId, `
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>VPS WORKER INSTALLATION</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Memulai instalasi remote...
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>Target:</b> <code>${worker.label}</code> (${worker.host})
<i>Ini bisa memakan waktu 15-30 menit</i>
      `.trim(), { parse_mode: 'HTML' });

      // Run installation with streaming updates
      runInstallationWithStreaming(bot, chatId, statusMsg.message_id, worker, installer);
      
    } else {
      // Dual VPS installation
      const statusMsg = await bot.sendMessage(chatId, `
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>VPS WORKER INSTALLATION (DUAL)</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="6084396322444544568">⏳</tg-emoji> Memulai instalasi parallel...
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>Target 1:</b> <code>${validWorkers[0].label}</code>
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji>️ <b>Target 2:</b> <code>${validWorkers[1].label}</code>
<i>Ini bisa memakan waktu 15-30 menit</i>
      `.trim(), { parse_mode: 'HTML' });

      // Run both installations in parallel
      runDualInstallationWithStreaming(bot, chatId, statusMsg.message_id, validWorkers, installer);
    }

    return;
  }

    bot.sendMessage(chatId, `ℹ️ Perintah ${command} dalam tahap pengembangan.`);
}

module.exports = adminHandler;

