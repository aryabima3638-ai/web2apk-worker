const db = require('../bot/db');
const config = require('../config');

function normalizeWorkerStatus(status) {
  const raw = String(status || '').toLowerCase();
  if (raw.includes('offline')) return 'offline';
  if (raw.includes('install')) return 'installing';
  if (raw.includes('cooldown')) return 'cooldown';
  if (raw.includes('build')) return 'building';
  if (raw.includes('online') || raw.includes('ready')) return 'online';
  return 'unknown';
}

function isWorkerAvailable(worker) {
  const statusKind = normalizeWorkerStatus(worker?.status);
  // BUG FIX #4: Check installation status
  // Workers without installationStatus field are assumed installed (backward compat)
  // Only block workers explicitly set to a non-installed value (e.g. 'installing', 'pending')
  const installStatus = worker?.installationStatus;
  const isInstalled = !installStatus || installStatus === 'installed';
  // Worker is available only when online/ready, not building, AND installed
  return (statusKind === 'online' || statusKind === 'ready') && isInstalled;
}

class WorkerPool {
  constructor() {
    this.roundRobinCursor = {
      vps: 0,
      github: 0
    };
  }

  pickWorkerRoundRobin(candidates, type) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const cursor = Number(this.roundRobinCursor[type] || 0);
    const index = cursor % candidates.length;
    const selected = candidates[index];

    this.roundRobinCursor[type] = (index + 1) % candidates.length;
    return selected;
  }

  async dispatchJobToWorker(worker, job) {
    await db.updateWorkers((workers) => {
      const index = workers.findIndex(w => w.id === worker.id);
      if (index > -1) {
        workers[index].status = 'building';
        workers[index].currentJobId = job.jobId;
        workers[index].currentUserId = job.userId;
        workers[index].currentUserUsername = job.userUsername || null;
        workers[index].currentUserFirstName = job.userFirstName || null;
        workers[index].currentUserLastName = job.userLastName || null;
        workers[index].buildStartedAt = new Date().toISOString();
      }
      return workers;
    });

    const startedAt = new Date().toISOString();

    await db.upsertJob(job.userId, job.jobId, {
      jobId: job.jobId,
      userId: job.userId,
      userUsername: job.userUsername || null,
      userFirstName: job.userFirstName || null,
      userLastName: job.userLastName || null,
      projectType: job.projectType,
      mode: job.mode,
      status: 'running',
      workerId: worker.id,
      createdAt: job.createdAt || new Date().toISOString(),
      startedAt
    });

    console.log(`[WorkerPool] Job ${job.jobId} assigned to worker ${worker.id}, executing...`);

    if (worker.type === 'vps') {
      const vpsWorker = require('./vpsWorker');
      vpsWorker.execute(worker, job);
    } else {
      const githubWorker = require('./githubWorker');
      githubWorker.execute(worker, job);
    }

    return { assigned: true, workerId: worker.id };
  }

  async findSlot() {
    let workers = await db.getWorkers();
    console.log(`[WorkerPool] Checking ${workers.length} workers for available slot...`);

    // ⭐ Check max concurrent builds limit
    const maxConcurrent = config.workers.maxConcurrentBuilds || 1;
    const buildingWorkers = workers.filter(w => normalizeWorkerStatus(w.status) === 'building');
    if (buildingWorkers.length >= maxConcurrent) {
      console.log(`[WorkerPool] Max concurrent builds (${maxConcurrent}) reached. ${buildingWorkers.length} already building.`);
      return null;
    }

    // Update expired cooldowns first atomically
    await db.updateWorkers((currentWorkers) => {
      const now = Date.now();
      let updated = false;

      for (const worker of currentWorkers) {
        const statusKind = normalizeWorkerStatus(worker.status);
        if (statusKind === 'cooldown' && worker.cooldownUntil && now >= worker.cooldownUntil) {
          worker.status = 'online';
          delete worker.cooldownUntil;
          updated = true;
          console.log(`[WorkerPool] Worker ${worker.id} cooldown expired, set to online`);
        }
      }

      return updated ? currentWorkers : false;
    });

    // Re-fetch after potential updates
    workers = await db.getWorkers();

    // VPS first
    const vpsWorkers = workers.filter(w => w.type === 'vps' && w.enabled !== false);
    console.log(`[WorkerPool] VPS workers registered: ${vpsWorkers.length}`);
    for (const worker of vpsWorkers) {
      console.log(`[WorkerPool] VPS Worker ${worker.id}: status=${normalizeWorkerStatus(worker.status)}`);
    }

    const vpsCandidates = vpsWorkers.filter(isWorkerAvailable);
    const selectedVps = this.pickWorkerRoundRobin(vpsCandidates, 'vps');
    if (selectedVps) {
      console.log(`[WorkerPool] Found available VPS worker: ${selectedVps.id}`);
      return selectedVps;
    }

    // Then GitHub workers
    const ghWorkers = workers.filter(w => w.type === 'github' && w.enabled !== false);
    console.log(`[WorkerPool] GitHub workers registered: ${ghWorkers.length}`);
    for (const worker of ghWorkers) {
      console.log(`[WorkerPool] GitHub Worker ${worker.id}: status=${normalizeWorkerStatus(worker.status)}`);
    }

    const ghCandidates = ghWorkers.filter(isWorkerAvailable);
    const selectedGh = this.pickWorkerRoundRobin(ghCandidates, 'github');
    if (selectedGh) {
      console.log(`[WorkerPool] Found available GitHub worker: ${selectedGh.id}`);
      return selectedGh;
    }

    const cooldownWorkers = workers.filter(w => normalizeWorkerStatus(w.status) === 'cooldown').length;
    if (cooldownWorkers > 0) {
      console.log(`[WorkerPool] ${cooldownWorkers} worker(s) in cooldown`);
    }

    console.log('[WorkerPool] All workers are at capacity or unavailable');
    return null;
  }

  async getUserActiveJob(userId) {
    const workers = await db.getWorkers();
    const queue = await db.getQueue();
    const builds = await db.getBuilds();

    // Check if user has a job running on any worker
    const buildingWorker = workers.find(w => 
      w.status === 'building' && w.currentUserId === userId
    );
    if (buildingWorker) {
      return {
        jobId: buildingWorker.currentJobId,
        status: 'running',
        workerId: buildingWorker.id
      };
    }

    // Check if user has a job in queue
    const queuedJob = queue.find(j => j.userId === userId);
    if (queuedJob) {
      return {
        jobId: queuedJob.jobId,
        status: 'queued',
        position: queuedJob.position
      };
    }

    // Check if user has a job in builds with running/queued status
    const activeBuild = builds.find(b => 
      b.userId === userId && (b.status === 'running' || b.status === 'queued')
    );
    if (activeBuild) {
      return {
        jobId: activeBuild.jobId,
        status: activeBuild.status
      };
    }

    return null;
  }

  async assignJob(job) {
    console.log(`[WorkerPool] Assigning job ${job.jobId} for user ${job.userId}...`);

    // BUG FIX #2: Check if user already has an active or queued build
    const existingJob = await this.getUserActiveJob(job.userId);
    if (existingJob) {
      console.log(`[WorkerPool] User ${job.userId} already has a ${existingJob.status} job ${existingJob.jobId}`);
      return {
        assigned: false,
        error: existingJob.status === 'running'
          ? 'Anda sudah memiliki build yang sedang berjalan. Tunggu sampai selesai.'
          : `Anda sudah dalam antrian #${existingJob.position}. Tunggu giliran Anda.`
      };
    }

    const worker = await this.findSlot();
    if (worker) {
      console.log(`[WorkerPool] Assigning to worker ${worker.id} (${worker.type})`);
      return this.dispatchJobToWorker(worker, job);
    }

    console.log(`[WorkerPool] No available workers, adding job ${job.jobId} to queue`);
    
    // Atomically check and add to queue
    const queuedJob = await db.updateQueue((queue) => {
      if (queue.length >= config.queue.maxQueueSize) {
        return false;
      }
      job.position = queue.length + 1;
      queue.push(job);
      return queue;
    });

    if (!queuedJob) {
      console.log('[WorkerPool] Queue is full');
      return { assigned: false, error: 'Queue full' };
    }

    await db.upsertJob(job.userId, job.jobId, {
      jobId: job.jobId,
      userId: job.userId,
      projectType: job.projectType,
      mode: job.mode,
      status: 'queued',
      position: job.position,
      createdAt: job.createdAt || new Date().toISOString()
    });

    console.log(`[WorkerPool] Job ${job.jobId} queued at position #${job.position}`);
    return { assigned: false, inQueue: true, position: job.position };
  }

  async completeJob(workerId, jobId) {
    let wasBuilding = false;
    await db.updateWorkers((workers) => {
      const index = workers.findIndex(w => w.id === workerId);
      if (index > -1) {
        wasBuilding = true;
        
        workers[index].status = 'cooldown';
        workers[index].cooldownUntil = Date.now() + (config.workers.cooldownMs || 30000);
        // Clear current job tracking securely
        delete workers[index].currentJobId;
        delete workers[index].currentUserId;
        delete workers[index].buildStartedAt;
        delete workers[index].currentUserUsername;
        delete workers[index].currentUserFirstName;
        delete workers[index].currentUserLastName;
        return workers;
      }
      return false;
    });

    if (wasBuilding) {
      console.log(`[WorkerPool] Worker ${workerId} entering cooldown for ${config.workers.cooldownMs || 30000}ms`);

      setTimeout(async () => {
        try {
          await db.updateWorkers((currentWorkers) => {
            const workerIndex = currentWorkers.findIndex(w => w.id === workerId);
            if (workerIndex > -1 && normalizeWorkerStatus(currentWorkers[workerIndex].status) === 'cooldown') {
              currentWorkers[workerIndex].status = 'online';
              delete currentWorkers[workerIndex].cooldownUntil;
              return currentWorkers;
            }
            return false;
          });
          console.log(`[WorkerPool] Worker ${workerId} cooldown complete, now online`);
          await this.processNextInQueue();
        } catch (err) {
          console.error(`[WorkerPool] Error ending cooldown for ${workerId}:`, err.message);
        }
      }, config.workers.cooldownMs || 30000);

      setTimeout(() => this.processNextInQueue(), 1000);
    }
  }

  async processNextInQueue() {
    let guard = 0;

    while (guard < 100) {
      guard += 1;

      const worker = await this.findSlot();
      if (!worker) return;

      let nextJob = null;
      await db.updateQueue((queue) => {
        if (queue.length === 0) return false;
        nextJob = queue.shift();
        queue.forEach((item, i) => {
          item.position = i + 1;
        });
        return queue;
      });

      if (!nextJob) return;

      const result = await this.dispatchJobToWorker(worker, nextJob);
      if (!result.assigned) {
        await db.updateQueue((queue) => {
          queue.unshift(nextJob);
          queue.forEach((item, i) => {
            item.position = i + 1;
          });
          return queue;
        });
        return;
      }
    }
  }
}

module.exports = new WorkerPool();
