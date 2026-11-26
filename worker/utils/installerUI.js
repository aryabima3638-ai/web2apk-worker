/**
 * Installer UI - Real-time streaming UI for VPS installation
 * Gen 4 Style with live progress updates via editMessageText
 */

/**
 * Run installation on single VPS with real-time streaming updates
 * @param {Object} bot - Telegram bot instance
 * @param {Number} chatId - Chat ID
 * @param {Number} messageId - Message ID to edit
 * @param {Object} worker - Worker object
 * @param {Object} installer - Installer instance
 */
async function runInstallationWithStreaming(bot, chatId, messageId, worker, installer) {
  const progressLines = [];
  const MAX_DISPLAY_LINES = 12;
  let lastUpdate = 0;
  let currentPhase = '🔄 Connecting...';
  const startTime = Date.now();

  const updateTelegram = async () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    const displayLines = progressLines.slice(-MAX_DISPLAY_LINES);
    const logBlock = displayLines.map(l => {
      const safe = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return safe.length > 60 ? safe.substring(0, 57) + '...' : safe;
    }).join('\n');

    const message = `
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji> <b>VPS WORKER INSTALLATION</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Elapsed: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Phase: ${currentPhase}
<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <b>Target:</b> <code>${worker.label}</code>
━━━━━━━━━━━━━━━━━━

<code>${logBlock || '...'}</code>

<i>📡 Live streaming output</i>
    `.trim();

    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });
  };

  try {
    // Create a wrapper for the installer that captures logs
    const streamingInstaller = {
      runInstall: async (worker, bot, chatId) => {
        const log = (msg) => {
          progressLines.push(msg);
          console.log(`[Installer ${worker.host}] ${msg}`);
          
          // Detect phase from message
          if (msg.includes('System Packages')) currentPhase = '📦 System Packages';
          else if (msg.includes('Node.js')) currentPhase = '⬇️ Node.js 20.x';
          else if (msg.includes('Java JDK')) currentPhase = '☕ Java JDK 17';
          else if (msg.includes('Android SDK')) currentPhase = '📱 Android SDK';
          else if (msg.includes('Flutter')) currentPhase = '🐦 Flutter SDK';
          else if (msg.includes('Bot API')) currentPhase = '🔧 Bot API Server';
          else if (msg.includes('complete')) currentPhase = '✅ Done!';
          else if (msg.includes('failed')) currentPhase = '❌ Error';
          
          // Throttle updates to every 3 seconds
          const now = Date.now();
          if (now - lastUpdate > 3000) {
            lastUpdate = now;
            updateTelegram();
          }
        };

        // Run the actual installer with custom logger
        await installer.runInstallWithLogger(worker, bot, chatId, log);
      }
    };

    await streamingInstaller.runInstall(worker, bot, chatId);

    // Final success update
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const summaryLines = progressLines.slice(-8).map(l => {
      const safe = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return safe.length > 60 ? safe.substring(0, 57) + '...' : safe;
    }).join('\n');

    bot.editMessageText(`
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>VPS WORKER INSTALLED!</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Total: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status: <code>READY</code>
<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <b>Worker:</b> <code>${worker.label}</code>
━━━━━━━━━━━━━━━━━━

<code>${summaryLines}</code>

<tg-emoji emoji-id="5429368540849260641">🎉</tg-emoji> <i>Worker siap menerima build!</i>
    `.trim(), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });

  } catch (error) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const errorLines = progressLines.slice(-10).map(l => {
      const safe = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return safe.length > 60 ? safe.substring(0, 57) + '...' : safe;
    }).join('\n');

    bot.editMessageText(`
<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>INSTALASI GAGAL</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Total: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Error: <code>${(error.message || 'Unknown').substring(0, 100)}</code>
<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <b>Worker:</b> <code>${worker.label}</code>
━━━━━━━━━━━━━━━━━━

<code>${errorLines}</code>

<i>Periksa log di atas untuk detail error</i>
    `.trim(), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });
  }
}

/**
 * Run installation on dual VPS with real-time streaming updates
 * @param {Object} bot - Telegram bot instance
 * @param {Number} chatId - Chat ID
 * @param {Number} messageId - Message ID to edit
 * @param {Array} workers - Array of worker objects
 * @param {Object} installer - Installer instance
 */
async function runDualInstallationWithStreaming(bot, chatId, messageId, workers, installer) {
  const workerLogs = workers.map(() => []);
  const MAX_DISPLAY_LINES = 8;
  let lastUpdate = 0;
  const startTime = Date.now();
  let completedCount = 0;
  let hasError = false;

  const updateTelegram = async () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    let message = `
<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji> <b>VPS WORKER INSTALLATION (DUAL)</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Elapsed: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Progress: <code>${completedCount}/2</code> completed
━━━━━━━━━━━━━━━━━━
    `.trim();

    workers.forEach((worker, idx) => {
      const logs = workerLogs[idx];
      const displayLines = logs.slice(-MAX_DISPLAY_LINES);
      const logBlock = displayLines.map(l => {
        const safe = String(l).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return safe.length > 50 ? safe.substring(0, 47) + '...' : safe;
      }).join('\n');
      
      message += `\n\n<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji> <b>${worker.label}</b>\n<code>${logBlock || '...'}</code>`;
    });

    message += '\n\n<i><tg-emoji emoji-id="5256134032852278918">📡</tg-emoji> Live streaming output</i>';

    bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });
  };

  // Run both installations in parallel
  const installPromises = workers.map((worker, idx) => {
    return new Promise(async (resolve) => {
      try {
        const log = (msg) => {
          workerLogs[idx].push(msg);
          console.log(`[Installer ${worker.host}] ${msg}`);
          
          const now = Date.now();
          if (now - lastUpdate > 3000) {
            lastUpdate = now;
            updateTelegram();
          }
        };

        await installer.runInstallWithLogger(worker, bot, chatId, log);
        completedCount++;
        resolve({ success: true, worker });
      } catch (error) {
        hasError = true;
        workerLogs[idx].push(`❌ Error: ${error.message}`);
        resolve({ success: false, worker, error });
      }
    });
  });

  await Promise.all(installPromises);

  // Final update
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  if (!hasError) {
    bot.editMessageText(`
<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>DUAL VPS WORKER INSTALLED!</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Total: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status: <code>ALL READY</code>
━━━━━━━━━━━━━━━━━━

${workers.map(w => `🖥️ <b>${w.label}</b> - ✅ Ready`).join('\n')}

<tg-emoji emoji-id="5429368540849260641">🎉</tg-emoji> <i>Semua worker siap menerima build!</i>
    `.trim(), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });
  } else {
    bot.editMessageText(`
<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> <b>DUAL VPS INSTALLATION COMPLETED WITH ERRORS</b>
━━━━━━━━━━━━━━━━━━
<tg-emoji emoji-id="5382194935057372936">⏱</tg-emoji> Total: <code>${mins}m ${secs}s</code>
<tg-emoji emoji-id="5231200819986047254">📊</tg-emoji> Status: <code>CHECK REQUIRED</code>
━━━━━━━━━━━━━━━━━━

${workers.map((w, idx) => {
      const hasErr = workerLogs[idx].some(l => l.includes('❌ Error'));
      return `<tg-emoji emoji-id="5406901223326495466">🖥</tg-emoji> <b>${w.label}</b> - ${hasErr ? '<tg-emoji emoji-id="5210952531676504517">❌</tg-emoji> Failed' : '<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> Ready'}`;
    }).join('\n')}

<i>Periksa log di atas untuk detail error</i>
    `.trim(), {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }).catch(() => { });
  }
}

module.exports = {
  runInstallationWithStreaming,
  runDualInstallationWithStreaming
};
