/**
 * jobRegistry.js
 * ─────────────────────────────────────────────────────────────────────────
 * In-memory registry of currently-running build jobs, keyed by jobId.
 *
 * Why this exists: vpsWorker.execute(worker, job) is fired "in the
 * background" (not awaited) by pool.dispatchJobToWorker(). By the time the
 * user presses "❌ Batal Build" in Telegram, the only way to actually stop
 * the in-progress work (not just stop updating the UI) is to reach back
 * into that specific execute() call's live SSH connection and kill the
 * remote build process. This registry is that bridge.
 *
 * Lifecycle:
 *   1. vpsWorker.execute() calls register(jobId, { ssh, worker, chatId,
 *      messageId }) as soon as the SSH connection is established.
 *   2. The pipeline periodically calls isCancelled(jobId) at safe checkpoints
 *      (between build stages) to bail out early and cleanly if a cancel was
 *      requested mid-flight.
 *   3. The Telegram callback handler for the cancel button calls
 *      requestCancel(jobId), which immediately SSH-kills the remote
 *      flutter/gradle process (best-effort, same technique already used by
 *      the existing build-timeout handler) and flips the cancelled flag.
 *   4. vpsWorker.execute() always calls unregister(jobId) in its `finally`
 *      block, whether the job succeeded, failed, timed out, or was
 *      cancelled — so this map can never leak entries.
 *
 * This is intentionally in-memory only (not persisted to database/*.json):
 * an SSH connection object cannot be serialized/restored across a process
 * restart anyway, so a job that was "running" before a restart has no live
 * connection to cancel — the existing worker reset/health-check logic
 * already handles that case separately.
 */

const activeJobs = new Map();

// Job IDs that have ever been cancelled, kept independently of activeJobs
// and NEVER removed by unregister(). This exists specifically so that
// isCancelled(jobId) keeps returning true even after vpsWorker.js's
// `finally` block has already called unregister() (which deletes the full
// entry — including the now-disposed SSH connection — to avoid leaking
// memory). Without this separate set, a timer tick or a lingering
// onProgress() call that fires in the small window AFTER unregister() but
// still logically "about" a job that was cancelled would see isCancelled()
// wrongly flip back to false (because activeJobs.get(jobId) is now
// undefined), and would resume publishing progress updates — which is
// exactly the bug where a cancelled build's progress message came back to
// life after "BUILD DIBATALKAN" had already been shown. This set is capped
// and pruned by prune() below so it can't grow unbounded over a long
// uptime; a cancelled job's id has no reason to be checked more than a few
// minutes after cancellation.
const cancelledJobIds = new Map(); // jobId -> cancelledAt timestamp (ms)
const CANCELLED_ID_RETENTION_MS = 30 * 60 * 1000; // 30 minutes is far longer than any realistic in-flight straggler call

function pruneCancelledIds() {
  const cutoff = Date.now() - CANCELLED_ID_RETENTION_MS;
  for (const [jobId, ts] of cancelledJobIds) {
    if (ts < cutoff) cancelledJobIds.delete(jobId);
  }
}

// Single shared CancelledError class. IMPORTANT: this must be the ONLY
// definition of this class in the whole codebase — every pipeline file
// (flutter.js, android.js, projectPrep.js, vpsWorker.js, githubWorker.js)
// imports THIS exact class rather than declaring its own local copy.
// `error instanceof CancelledError` only evaluates to true when the error
// was constructed from the identical class reference; two classes with the
// same name declared in two different files are NOT the same class as far
// as `instanceof` is concerned. Having per-file copies (an earlier version
// of this codebase did exactly that) meant a CancelledError thrown deep in
// flutter.js's retry chain would fail its `instanceof CancelledError` check
// once caught in vpsWorker.js's outer catch block, silently falling through
// to the "real build failure" branch — which is what let the auto-fix/retry
// logic keep going after a cancel button press instead of stopping.
class CancelledError extends Error {
  constructor() {
    super('Build dibatalkan oleh user.');
    this.name = 'CancelledError';
  }
}

function register(jobId, info) {
  if (!jobId) return;
  activeJobs.set(jobId, {
    ssh: info.ssh || null,
    worker: info.worker || null,
    chatId: info.chatId || null,
    messageId: info.messageId || null,
    userId: info.userId || null,
    appName: info.appName || null,
    cancelled: false,
    cancelRequestedAt: null,
  });
}

// Intentionally does NOT touch cancelledJobIds — see the comment on that
// map's declaration above for why a cancelled job's id must keep answering
// true from isCancelled() even after this call removes its full entry
// (including the now-useless disposed SSH connection) from activeJobs.
function unregister(jobId) {
  if (!jobId) return;
  activeJobs.delete(jobId);
}

function get(jobId) {
  return activeJobs.get(jobId) || null;
}

function isCancelled(jobId) {
  if (cancelledJobIds.has(jobId)) return true;
  const entry = activeJobs.get(jobId);
  return !!(entry && entry.cancelled);
}

/**
 * Request cancellation of a running job. Best-effort kills the remote
 * build process over a FRESH SSH connection (see note below on why not
 * entry.ssh) and marks the job as cancelled so the pipeline's own
 * isCancelled() checkpoints bail out too. Returns the registry entry (for
 * chatId/messageId/appName lookups by the caller) or null if the job
 * wasn't found (already finished, or was never a VPS job in the first
 * place — e.g. a GitHub Actions job).
 */
async function requestCancel(jobId) {
  const entry = activeJobs.get(jobId);
  if (!entry) return null;

  entry.cancelled = true;
  entry.cancelRequestedAt = new Date().toISOString();

  // Record in the durable (survives unregister) cancelled-ids set FIRST,
  // before attempting the SSH kill below — so that even if the kill command
  // itself throws or hangs, isCancelled(jobId) is already correctly true
  // for any concurrent timer tick or onProgress() call checking it.
  cancelledJobIds.set(jobId, Date.now());
  pruneCancelledIds();

  if (entry.worker && entry.worker.host) {
    // IMPORTANT: this deliberately opens a BRAND NEW SSH connection rather
    // than reusing entry.ssh. entry.ssh is the SAME connection object the
    // long-running build pipeline is (or was) using for its own
    // ssh.execCommand() calls — node-ssh/ssh2 multiplexes multiple exec
    // "channels" over one connection, but if that connection's underlying
    // TCP session is itself wedged (which is exactly the state a build
    // that "won't die" can leave it in — e.g. a gradle/kotlin daemon still
    // holding the shell open and refusing to return control), a NEW exec
    // request on the SAME connection can queue behind it indefinitely.
    // Earlier versions of this function reused entry.ssh here, which is
    // the reason "Batal Build" could show success in Telegram while the
    // worker's status stayed stuck on "Sedang Build" for the underlying
    // job — the kill command itself was silently stuck waiting its turn on
    // a connection that was never going to free up on its own. A fresh
    // connection to the same host has no such dependency.
    const { NodeSSH } = require('node-ssh');
    const killSsh = new NodeSSH();
    try {
      const killConnectConfig = {
        host: entry.worker.host,
        username: entry.worker.user,
        timeout: 15000,
      };
      if (entry.worker.authMethod === 'password' && entry.worker.password) {
        killConnectConfig.password = entry.worker.password;
      } else if (entry.worker.sshKeyPath) {
        killConnectConfig.privateKey = entry.worker.sshKeyPath;
      }
      await killSsh.connect(killConnectConfig);

      // Kill everything plausibly tied to this build: the job's own build
      // directory (most precise — matches any process whose command line
      // references the job-specific path, catching wrapper scripts too),
      // the flutter/dart toolchain, and explicitly the JVM-based daemons
      // (gradle, kotlin compiler) that are BY DESIGN kept alive in the
      // background to speed up a next build and do NOT die just because
      // their parent (flutter/bash) was killed — this was the actual gap:
      // killing "flutter build" alone left orphaned java processes running
      // gradle/kotlin daemons that kept the build directory locked and kept
      // whatever ssh.execCommand() was awaiting them from ever resolving.
      // `gradle --stop` is Gradle's own official daemon shutdown command
      // and is tried first since it's the clean way to do it; the pkill
      // sweep after is the forceful fallback for anything --stop missed.
      const killScript = `
cd $(find /root /home -maxdepth 4 -type d -name "${jobId}" 2>/dev/null | head -1) 2>/dev/null && ./gradlew --stop >/dev/null 2>&1
cd $(find /root /home -maxdepth 4 -type d -name "${jobId}" 2>/dev/null | head -1) 2>/dev/null && ./android/gradlew --stop >/dev/null 2>&1
pkill -9 -f "${jobId}" 2>/dev/null
pkill -9 -f "flutter build" 2>/dev/null
pkill -9 -f "flutter_tools" 2>/dev/null
pkill -9 -f "GradleDaemon" 2>/dev/null
pkill -9 -f "KotlinCompileDaemon" 2>/dev/null
pkill -9 -f "gradle" 2>/dev/null
pkill -9 -f "org.gradle" 2>/dev/null
pkill -9 -f "dart.*snapshot" 2>/dev/null
true
      `.trim();

      // A hard timeout on the kill command itself: this must NEVER be
      // allowed to hang, since requestCancel() is on the critical path of
      // the user pressing the cancel button and seeing a response.
      await Promise.race([
        killSsh.execCommand(killScript),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    } catch (err) {
      console.warn(`[JobRegistry] Failed to kill remote process for ${jobId}: ${err.message}`);
    } finally {
      killSsh.dispose();
    }
  }

  return entry;
}

function isRegistered(jobId) {
  return activeJobs.has(jobId);
}

module.exports = {
  register,
  unregister,
  get,
  isCancelled,
  requestCancel,
  isRegistered,
  CancelledError,
};
