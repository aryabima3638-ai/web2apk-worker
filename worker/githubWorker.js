const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const config = require('../config');
const db = require('../bot/db');
const pool = require('./pool');
const { updateBuildProgress, sendBuildComplete } = require('../bot/utils/progressUI');
const { notifyBuildChannel } = require('../bot/utils/buildChannelNotify');
const jobRegistry = require('./jobRegistry');
const { CancelledError } = jobRegistry;

class GithubWorker {
  /**
   * Execute a build job on GitHub Actions
   * Full lifecycle: upload ZIP → dispatch → poll → download artifact → send to user → cleanup
   */
  async execute(worker, job) {
    const startedAtMs = Date.now();
    const chatId = job.chatId;
    const messageId = job.progressMessageId;
    const appName = job.payload?.appName || job.appName || 'My App';
    const workerAlias = worker.label || worker.id;

    let currentProgress = 0;
    let releaseTag = null; // Track for cleanup

    const onProgress = async (percent, status) => {
      currentProgress = Math.max(currentProgress, percent);
      if (chatId && messageId) {
        try {
          await updateBuildProgress(global.bot, chatId, messageId, currentProgress, status, appName, workerAlias, job.jobId);
        } catch (err) {
          console.error('[GithubWorker] Failed to update progress:', err.message);
        }
      }
      console.log(`[GithubWorker] Job ${job.jobId} - ${currentProgress}% - ${status}`);
    };

    try {
      // Register immediately (before runId is known) so the cancel button
      // works even while the workflow is still being dispatched/located;
      // runId is attached to the registry entry below once known.
      jobRegistry.register(job.jobId, { worker, chatId, messageId, userId: job.userId, appName });

      // Step 0: If ZIP mode, upload ZIP to GitHub as a Release asset
      if (job.mode === 'zip') {
        await onProgress(3, 'Uploading project ZIP to GitHub...');
        const uploadResult = await this.uploadZipToGithub(worker, job);
        releaseTag = uploadResult.tag;

        // Inject the asset URL into the payload so the workflow can download it
        job.payload = job.payload || {};
        job.payload.zipAssetUrl = uploadResult.assetApiUrl;
        job.payload.zipReleaseTag = uploadResult.tag;

        console.log(`[GithubWorker] ZIP uploaded as release ${uploadResult.tag}, asset URL: ${uploadResult.assetApiUrl}`);
        await onProgress(8, 'ZIP uploaded, triggering GitHub Actions...');
      } else {
        await onProgress(5, 'Triggering GitHub Actions...');
      }

      const workflow = job.projectType === 'flutter' ? worker.workflows.flutter : worker.workflows.android;

      // Step 1: Dispatch workflow
      const dispatchResponse = await axios.post(
        `https://api.github.com/repos/${worker.repo}/actions/workflows/${workflow}/dispatches`,
        {
          ref: 'main',
          inputs: {
            jobId: String(job.jobId),
            userId: String(job.userId),
            payload: JSON.stringify(job.payload || {})
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${worker.token}`,
            'Accept': 'application/vnd.github.v3+json'
          },
          timeout: (config.workers.githubTriggerTimeoutSeconds || 30) * 1000
        }
      );

      if (dispatchResponse.status !== 204) {
        throw new Error(`GitHub Actions dispatch failed with status ${dispatchResponse.status}`);
      }

      console.log(`[GithubWorker] Workflow dispatched for job ${job.jobId}`);
      await onProgress(10, 'GitHub Actions triggered, waiting for workflow to start...');

      // Step 2: Wait a moment for the workflow run to appear
      await this.sleep(5000);

      // Step 3: Find the workflow run
      await onProgress(15, 'Finding workflow run...');
      const runId = await this.findWorkflowRun(worker, job.jobId);

      if (!runId) {
        throw new Error('Could not find the workflow run on GitHub. The dispatch may have failed silently.');
      }

      console.log(`[GithubWorker] Found workflow run ID: ${runId}`);
      await onProgress(20, 'Workflow started, building on GitHub...');

      // Attach runId to the registry entry now that we have it, so a cancel
      // request arriving from this point on can call the GitHub "cancel run"
      // API (see requestCancel handling in menu.js) instead of only setting
      // the in-memory flag.
      const registryEntry = jobRegistry.get(job.jobId);
      if (registryEntry) registryEntry.runId = runId;

      if (jobRegistry.isCancelled(job.jobId)) {
        throw new CancelledError();
      }

      // Step 4: Poll until workflow completes
      const runResult = await this.pollWorkflowRun(worker, runId, job.jobId, onProgress);

      if (runResult.cancelled) {
        throw new CancelledError();
      }

      if (!runResult.success) {
        // Try to get failure logs
        const failureLogs = await this.getWorkflowLogs(worker, runId);
        const errorMsg = runResult.error || 'GitHub Actions build failed';
        throw new Error(failureLogs ? `${errorMsg}\n\nLog:\n${failureLogs}` : errorMsg);
      }

      await onProgress(85, 'Build complete! Downloading artifact...');

      // Step 5: Download the artifact
      const artifactUrl = await this.findArtifactDownloadUrl(worker, runId, job.jobId);

      if (!artifactUrl) {
        throw new Error('Build succeeded but no artifact found. Check your workflow upload-artifact step.');
      }

      await onProgress(90, 'Downloading APK from GitHub...');
      const localApkPath = await this.downloadArtifact(worker, artifactUrl, job.jobId, appName);

      if (!localApkPath) {
        throw new Error('Failed to download the built APK from GitHub.');
      }

      await onProgress(95, 'Sending APK to you...');

      // Step 6: Send APK to user
      const buildDuration = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));

      await db.upsertJob(job.userId, job.jobId, {
        status: 'success',
        finishedAt: new Date().toISOString(),
        buildDurationSeconds: buildDuration,
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
        durationSeconds: buildDuration,
      }).catch(() => {});

      if (chatId && global.bot) {
        try {
          await this.sendApkToUser(chatId, localApkPath, appName, job);
        } catch (sendErr) {
          console.error(`[GithubWorker] Failed to send APK: ${sendErr.message}`);
          await global.bot.sendMessage(chatId,
            `❌ Build berhasil tapi gagal mengirim APK.\n\nError: ${sendErr.message}`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }

      if (chatId && messageId) {
        await sendBuildComplete(global.bot, chatId, messageId, appName, job.url);
      }

      await onProgress(100, 'Build complete!');

      // Cleanup temp file
      await fs.remove(localApkPath).catch(() => {});

    } catch (error) {
      if (error instanceof CancelledError || jobRegistry.isCancelled(job.jobId)) {
        console.log(`Job ${job.jobId} was cancelled by user.`);
        const cancelledDuration = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
        await db.upsertJob(job.userId, job.jobId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          buildDurationSeconds: cancelledDuration,
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
          durationSeconds: cancelledDuration,
        }).catch(() => {});
      } else {
      const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
      console.error(`[GithubWorker] Job ${job.jobId} failed:`, error.message);
      console.error(`  → Detail: ${errDetail}`);

      const buildDuration = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));

      await db.upsertJob(job.userId, job.jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        buildDurationSeconds: buildDuration,
        error: `GitHub build failed: ${error.message}`,
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
        durationSeconds: buildDuration,
        error: `GitHub build failed: ${error.message}`,
      }).catch(() => {});

      // Notify user about the failure
      if (chatId && global.bot) {
        try {
          await global.bot.sendMessage(chatId,
            `❌ <b>Build Gagal</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
            `📱 <b>${this.escapeHtml(appName)}</b>\n` +
            `🖥️ Worker: ${this.escapeHtml(workerAlias)}\n\n` +
            `<b>Error:</b>\n<code>${this.escapeHtml(error.message.substring(0, 800))}</code>`,
            { parse_mode: 'HTML' }
          );
        } catch (_) {}
      }

      // Update progress message to show failure
      if (chatId && messageId) {
        try {
          await updateBuildProgress(global.bot, chatId, messageId, 0, `Build failed: ${error.message.substring(0, 200)}`, appName, workerAlias);
        } catch (_) {}
      }
      }
    } finally {
      // Always cleanup: delete temporary GitHub Release
      if (releaseTag) {
        await this.cleanupRelease(worker, releaseTag).catch(err => {
          console.warn(`[GithubWorker] Failed to cleanup release ${releaseTag}: ${err.message}`);
        });
      }
      jobRegistry.unregister(job.jobId);
      await pool.completeJob(worker.id, job.jobId).catch(() => {});
    }
  }

  // ─── ZIP Upload via GitHub Release ──────────────────────────────────────────

  /**
   * Upload ZIP file to GitHub as a temporary Release asset
   * Returns { tag, releaseId, assetApiUrl }
   */
  async uploadZipToGithub(worker, job) {
    // Find the ZIP file
    let zipPath = job.localFilePath;

    if (!zipPath || !await fs.pathExists(zipPath)) {
      // Try to download from Telegram using fileId
      if (job.fileId && global.bot) {
        console.log(`[GithubWorker] Downloading ZIP from Telegram (fileId: ${job.fileId})...`);
        const fileLink = await global.bot.getFileLink(job.fileId);
        zipPath = path.join(os.tmpdir(), `web2apk-gh-${job.jobId}.zip`);
        const response = await axios.get(fileLink, {
          responseType: 'arraybuffer',
          maxContentLength: 500 * 1024 * 1024,
          timeout: 120000
        });
        await fs.writeFile(zipPath, response.data);
        console.log(`[GithubWorker] Downloaded from Telegram: ${(response.data.length / 1024 / 1024).toFixed(2)}MB`);
      } else {
        throw new Error('No ZIP file available for upload to GitHub');
      }
    }

    const fileData = await fs.readFile(zipPath);
    const sizeMb = (fileData.length / 1024 / 1024).toFixed(2);
    console.log(`[GithubWorker] Uploading ZIP to GitHub: ${sizeMb}MB`);

    const tag = `build-${job.jobId}`;
    const headers = {
      'Authorization': `Bearer ${worker.token}`,
      'Accept': 'application/vnd.github.v3+json'
    };

    // Step 1: Create a lightweight tag (needed for release)
    try {
      await axios.post(`https://api.github.com/repos/${worker.repo}/git/refs`, {
        ref: `refs/tags/${tag}`,
        sha: await this.getLatestCommitSha(worker)
      }, { headers });
    } catch (tagErr) {
      // Tag might already exist, continue
      console.warn(`[GithubWorker] Tag creation warning: ${tagErr.message}`);
    }

    // Step 2: Create a draft release
    const releaseResponse = await axios.post(
      `https://api.github.com/repos/${worker.repo}/releases`,
      {
        tag_name: tag,
        name: `Temp Build ${job.jobId}`,
        body: `Temporary release for build ${job.jobId}. Will be cleaned up automatically.`,
        draft: false, // Non-draft so github.token can access it
        prerelease: true
      },
      { headers }
    );

    const releaseId = releaseResponse.data.id;
    console.log(`[GithubWorker] Created release: ${releaseId} (tag: ${tag})`);

    // Step 3: Upload ZIP as release asset
    const uploadUrl = releaseResponse.data.upload_url.replace('{?name,label}', '?name=project.zip');

    const assetResponse = await axios.post(uploadUrl, fileData, {
      headers: {
        'Authorization': `Bearer ${worker.token}`,
        'Content-Type': 'application/zip',
        'Accept': 'application/vnd.github.v3+json'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000 // 5 min timeout for upload
    });

    const assetApiUrl = assetResponse.data.url; // https://api.github.com/repos/.../releases/assets/{id}
    console.log(`[GithubWorker] Asset uploaded: ${assetApiUrl} (${sizeMb}MB)`);

    return { tag, releaseId, assetApiUrl };
  }

  /**
   * Get the latest commit SHA on main branch
   */
  async getLatestCommitSha(worker) {
    const response = await axios.get(
      `https://api.github.com/repos/${worker.repo}/git/ref/heads/main`,
      {
        headers: {
          'Authorization': `Bearer ${worker.token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    return response.data.object.sha;
  }

  /**
   * Delete the temporary release and tag after build
   */
  async cleanupRelease(worker, tag) {
    const headers = {
      'Authorization': `Bearer ${worker.token}`,
      'Accept': 'application/vnd.github.v3+json'
    };

    try {
      // Find release by tag
      const releaseResponse = await axios.get(
        `https://api.github.com/repos/${worker.repo}/releases/tags/${tag}`,
        { headers }
      );
      const releaseId = releaseResponse.data.id;

      // Delete release
      await axios.delete(
        `https://api.github.com/repos/${worker.repo}/releases/${releaseId}`,
        { headers }
      );
      console.log(`[GithubWorker] Deleted release: ${releaseId}`);
    } catch (err) {
      console.warn(`[GithubWorker] Failed to delete release for tag ${tag}: ${err.message}`);
    }

    try {
      // Delete tag
      await axios.delete(
        `https://api.github.com/repos/${worker.repo}/git/refs/tags/${tag}`,
        { headers }
      );
      console.log(`[GithubWorker] Deleted tag: ${tag}`);
    } catch (err) {
      console.warn(`[GithubWorker] Failed to delete tag ${tag}: ${err.message}`);
    }
  }

  // ─── Workflow Run Management ────────────────────────────────────────────────

  /**
   * Find the workflow run that was just dispatched for this job
   */
  async findWorkflowRun(worker, jobId, maxRetries = 10) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await axios.get(
          `https://api.github.com/repos/${worker.repo}/actions/runs?per_page=5&status=queued,in_progress`,
          {
            headers: {
              'Authorization': `Bearer ${worker.token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );

        const runs = response.data.workflow_runs || [];
        const now = Date.now();
        for (const run of runs) {
          const createdAt = new Date(run.created_at).getTime();
          if (now - createdAt < 120000) {
            console.log(`[GithubWorker] Found recent run: ${run.id} (status: ${run.status})`);
            return run.id;
          }
        }

        // Also check recently completed runs
        const completedResponse = await axios.get(
          `https://api.github.com/repos/${worker.repo}/actions/runs?per_page=5`,
          {
            headers: {
              'Authorization': `Bearer ${worker.token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );

        const allRuns = completedResponse.data.workflow_runs || [];
        for (const run of allRuns) {
          const createdAt = new Date(run.created_at).getTime();
          if (now - createdAt < 120000) {
            console.log(`[GithubWorker] Found recent run (any status): ${run.id} (status: ${run.status})`);
            return run.id;
          }
        }
      } catch (err) {
        console.warn(`[GithubWorker] Error finding workflow run (attempt ${attempt + 1}): ${err.message}`);
      }

      await this.sleep(5000);
    }

    return null;
  }

  /**
   * Poll a specific workflow run until it completes
   */
  async pollWorkflowRun(worker, runId, jobId, onProgress) {
    const MAX_POLL_MINUTES = 30;
    const POLL_INTERVAL_MS = 15000;
    const maxPolls = Math.ceil((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);

    for (let i = 0; i < maxPolls; i++) {
      if (jobRegistry.isCancelled(jobId)) {
        return { success: false, cancelled: true, error: 'Build dibatalkan oleh user.' };
      }
      try {
        const response = await axios.get(
          `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}`,
          {
            headers: {
              'Authorization': `Bearer ${worker.token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          }
        );

        const run = response.data;
        const status = run.status;
        const conclusion = run.conclusion;

        const elapsedMs = i * POLL_INTERVAL_MS;
        const estimatedTotalMs = 10 * 60 * 1000;
        const buildPercent = Math.min(80, 20 + Math.round((elapsedMs / estimatedTotalMs) * 60));

        if (status === 'completed') {
          if (conclusion === 'success') {
            console.log(`[GithubWorker] Workflow run ${runId} completed successfully`);
            return { success: true };
          } else {
            console.error(`[GithubWorker] Workflow run ${runId} failed with conclusion: ${conclusion}`);
            return { success: false, error: `GitHub Actions build ${conclusion}` };
          }
        }

        const statusText = status === 'queued'
          ? 'Menunggu runner GitHub tersedia...'
          : `Building on GitHub Actions... (${Math.round(elapsedMs / 1000)}s)`;

        await onProgress(buildPercent, statusText);

      } catch (err) {
        console.warn(`[GithubWorker] Poll error for run ${runId}: ${err.message}`);
      }

      await this.sleep(POLL_INTERVAL_MS);
    }

    return { success: false, error: `Build timeout after ${MAX_POLL_MINUTES} minutes` };
  }

  /**
   * Try to get failure logs from a workflow run (truncated)
   */
  async getWorkflowLogs(worker, runId) {
    try {
      // Get jobs for the run
      const response = await axios.get(
        `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}/jobs`,
        {
          headers: {
            'Authorization': `Bearer ${worker.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      const jobs = response.data.jobs || [];
      const failedJob = jobs.find(j => j.conclusion === 'failure');

      if (failedJob) {
        // Find the failed step
        const failedStep = failedJob.steps?.find(s => s.conclusion === 'failure');
        if (failedStep) {
          return `Step "${failedStep.name}" failed (status: ${failedStep.conclusion})`;
        }
        return `Job "${failedJob.name}" failed`;
      }

      return null;
    } catch (err) {
      console.warn(`[GithubWorker] Failed to get workflow logs: ${err.message}`);
      return null;
    }
  }

  // ─── Artifact Download ──────────────────────────────────────────────────────

  /**
   * Find and return the download URL for the build artifact
   */
  async findArtifactDownloadUrl(worker, runId, jobId) {
    await this.sleep(5000);

    try {
      const response = await axios.get(
        `https://api.github.com/repos/${worker.repo}/actions/runs/${runId}/artifacts`,
        {
          headers: {
            'Authorization': `Bearer ${worker.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      const artifacts = response.data.artifacts || [];
      console.log(`[GithubWorker] Found ${artifacts.length} artifact(s) for run ${runId}`);

      let artifact = artifacts.find(a => a.name === `apk-${jobId}`);

      if (!artifact && artifacts.length > 0) {
        artifact = artifacts.find(a => a.name.toLowerCase().includes('apk')) || artifacts[0];
        console.log(`[GithubWorker] Using fallback artifact: ${artifact.name}`);
      }

      if (artifact) {
        console.log(`[GithubWorker] Artifact found: ${artifact.name} (${(artifact.size_in_bytes / 1024 / 1024).toFixed(2)}MB)`);
        return artifact.archive_download_url;
      }

      return null;
    } catch (err) {
      console.error(`[GithubWorker] Error finding artifacts: ${err.message}`);
      return null;
    }
  }

  async downloadArtifact(worker, downloadUrl, jobId, appName) {
    // Menggunakan folder temp di dalam project (process.cwd()) alih-alih /tmp
    // karena panel VPS seperti Pterodactyl seringkali membatasi ukuran partisi /tmp
    const tempDir = path.join(process.cwd(), 'temp_gh_artifacts');
    const zipPath = path.join(tempDir, `${jobId}.zip`);

    try {
      await fs.ensureDir(tempDir);

      console.log(`[GithubWorker] Downloading artifact from: ${downloadUrl}`);

      const response = await axios.get(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${worker.token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        responseType: 'arraybuffer',
        maxContentLength: 500 * 1024 * 1024,
        timeout: 300000
      });

      await fs.writeFile(zipPath, response.data);
      console.log(`[GithubWorker] Artifact downloaded: ${(response.data.length / 1024 / 1024).toFixed(2)}MB`);

      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const zipEntries = zip.getEntries();
      
      let apkEntry = null;
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.entryName.endsWith('.apk')) {
          apkEntry = entry;
          break;
        }
      }

      if (!apkEntry) {
        throw new Error('No APK file found in the downloaded artifact');
      }

      const safeName = String(appName || 'app').replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalApkPath = path.join(tempDir, `${safeName}-${jobId}.apk`);
      
      // Ekstrak HANYA file APK langsung ke path tujuan (menghemat disk space)
      const apkBuffer = apkEntry.getData();
      await fs.writeFile(finalApkPath, apkBuffer);

      // Langsung hapus file ZIP untuk menghemat ruang penyimpanan server bot
      await fs.remove(zipPath).catch(() => {});

      console.log(`[GithubWorker] APK extracted: ${finalApkPath}`);
      return finalApkPath;
    } catch (err) {
      await fs.remove(zipPath).catch(() => {});
      throw err;
    }
  }

  // ─── Send APK to User ──────────────────────────────────────────────────────

  /**
   * Send APK file to user via Telegram
   */
  async sendApkToUser(chatId, apkPath, appName, job) {
    const stat = await fs.stat(apkPath);
    const sizeMb = (stat.size / 1024 / 1024).toFixed(2);
    const safeAppName = this.escapeHtml(appName);
    const safeUrl = job.url ? this.escapeHtml(job.url) : null;

    const caption = [
      `<tg-emoji emoji-id="6084551628461967966">✅</tg-emoji> <b>${safeAppName}</b>`,
      '',
      safeUrl ? `<tg-emoji emoji-id="5447410659077661506">🌐</tg-emoji> <code>${safeUrl}</code>` : null,
      `<tg-emoji emoji-id="5463172695132745432">📦</tg-emoji> <code>${sizeMb} MB</code>`,
      `⚡ <i>Built via GitHub Actions</i>`,
      '',
      '<i>Generated by FxhlProject Web2Apk Bot</i>'
    ].filter(Boolean).join('\n');

    const safeName = String(appName || 'app').replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${safeName}.apk`;

    // Check file size limit (50MB for public API)
    const MAX_PUBLIC_API_SIZE = 50 * 1024 * 1024;

    if (stat.size > MAX_PUBLIC_API_SIZE) {
      console.log(`[GithubWorker] APK > 50MB (${sizeMb}MB). Uploading to GitHub Release...`);
      // Update progress so user knows it's uploading
      if (job.progressMessageId) {
        try {
          const { updateBuildProgress } = require('../bot/utils/progressUI');
          await updateBuildProgress(global.bot, chatId, job.progressMessageId, 96, `APK terlalu besar (${sizeMb}MB), mengunggah ke GitHub...`, appName, job.workerAlias);
        } catch(e) {}
      }

      try {
        const tag = `apk-${job.jobId}`;
        const releaseName = `APK Build: ${safeAppName}`;
        const headers = {
          'Authorization': `Bearer ${worker.token}`,
          'Accept': 'application/vnd.github.v3+json'
        };

        // 1. Create a GitHub Release specifically for this APK
        const releaseRes = await axios.post(
          `https://api.github.com/repos/${worker.repo}/releases`,
          {
            tag_name: tag,
            name: releaseName,
            body: `Download APK for ${safeAppName} (Job: ${job.jobId})`,
            draft: false,
            prerelease: false
          },
          { headers }
        );

        // 2. Upload the APK as a release asset
        const uploadUrl = releaseRes.data.upload_url.replace('{?name,label}', `?name=${filename}`);
        const fileData = await fs.readFile(apkPath);

        const assetRes = await axios.post(uploadUrl, fileData, {
          headers: {
            'Authorization': `Bearer ${worker.token}`,
            'Content-Type': 'application/vnd.android.package-archive',
            'Accept': 'application/vnd.github.v3+json'
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 300000 // 5 mins
        });
        
        // This URL is publicly accessible if the repo is public
        const downloadUrl = assetRes.data.browser_download_url;
        
        const largeCaption = caption + `\n\n⚠️ <b>Catatan:</b> APK ini terlalu besar untuk dikirim langsung via Telegram (>50MB).\n🔗 <b>Link Download:</b> ${downloadUrl}`;
        
        await global.bot.sendMessage(chatId, largeCaption, { parse_mode: 'HTML', disable_web_page_preview: true });
        console.log(`[GithubWorker] Large APK link sent to user: ${downloadUrl}`);
        
      } catch (uploadErr) {
        const errDetail = uploadErr.response ? JSON.stringify(uploadErr.response.data) : uploadErr.message;
        throw new Error(`Gagal mengunggah APK ke GitHub Release: ${errDetail}`);
      }
    } else {
      await global.bot.sendDocument(
        chatId,
        apkPath,
        { caption, parse_mode: 'HTML' },
        { filename, contentType: 'application/vnd.android.package-archive' }
      );
      console.log(`[GithubWorker] APK sent to user: ${filename} (${sizeMb}MB)`);
    }

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
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new GithubWorker();
