const fs = require('fs-extra');
const path = require('path');
const config = require('../config');

const buildStatsFile = path.join(config.database?.dir || './database', 'build_stats.json');

function getDefaultBuildStatsConfig() {
  return {
    mode: 'auto',
    displaySuccess: null,
    displayFailed: null,
    avgDurationSeconds: null,
    updatedAt: null,
    updatedBy: null
  };
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

class Database {
  constructor() {
    this.ensureDirs();
    this.initFiles();
    this._locks = {};
  }

  ensureDirs() {
    fs.ensureDirSync(config.database.dir);
  }

  async _withLock(key, fn) {
    if (!this._locks[key]) {
      this._locks[key] = Promise.resolve();
    }
    const currentLock = this._locks[key];
    
    let release;
    const nextLock = new Promise(resolve => { release = resolve; });
    this._locks[key] = currentLock.then(() => nextLock);

    try {
      await currentLock;
      return await fn();
    } finally {
      release();
    }
  }

  initFiles() {
    if (!fs.existsSync(config.database.usersFile)) fs.writeJsonSync(config.database.usersFile, []);
    if (!fs.existsSync(config.database.membersFile)) fs.writeJsonSync(config.database.membersFile, []);
    if (!fs.existsSync(config.database.workersFile)) fs.writeJsonSync(config.database.workersFile, []);
    if (!fs.existsSync(config.database.queueFile)) fs.writeJsonSync(config.database.queueFile, []);
    if (!fs.existsSync(config.database.resellersFile)) fs.writeJsonSync(config.database.resellersFile, []);
    if (!fs.existsSync(config.database.approvalsFile)) fs.writeJsonSync(config.database.approvalsFile, []);
    if (!fs.existsSync(config.database.buildsFile)) fs.writeJsonSync(config.database.buildsFile, []);
    if (!fs.existsSync(buildStatsFile)) fs.writeJsonSync(buildStatsFile, getDefaultBuildStatsConfig(), { spaces: 2 });
    if (!fs.existsSync(config.database.paymentsFile)) fs.writeJsonSync(config.database.paymentsFile, {});
    if (!fs.existsSync(config.database.pricesFile)) fs.writeJsonSync(config.database.pricesFile, {});
    if (!fs.existsSync(config.database.ordersFile)) fs.writeJsonSync(config.database.ordersFile, []);
    if (config.database.reportsFile && !fs.existsSync(config.database.reportsFile)) fs.writeJsonSync(config.database.reportsFile, []);
  }

  // Generic JSON read/write
  async read(file) {
    try {
      return await fs.readJson(file);
    } catch (error) {
      console.error(`Error reading ${file}:`, error);
      return [];
    }
  }

  async write(file, data) {
    try {
      await fs.writeJson(file, data, { spaces: 2 });
    } catch (error) {
      console.error(`Error writing ${file}:`, error);
    }
  }

  // Users
  async getUsers() {
    return this.read(config.database.usersFile);
  }

  async addUser(userId) {
    const users = await this.getUsers();
    if (!users.includes(userId)) {
      users.push(userId);
      await this.write(config.database.usersFile, users);
    }
  }

  // Members
  async getMembers() {
    return this.read(config.database.membersFile);
  }

  async isMember(userId, accessScope = 'bot') {
    const members = await this.getMembers();
    const uid = String(userId);
    const now = new Date();
    const member = members.find(m => {
      const memberId = m.telegramId ?? m.userId;
      if (String(memberId) !== uid) return false;

      const expiresAt = m.expiresAt ?? m.expiredAt;
      if (expiresAt !== null && expiresAt !== undefined && new Date(expiresAt) <= now) return false;

      const accessType = String(m.accessType || 'all').toLowerCase();
      if (accessScope === 'bot' && accessType === 'web') return false;
      if (accessScope === 'web' && accessType === 'bot') return false;
      return true;
    });

    return Boolean(member);
  }

  async addMember(userId, username, expiredAt, addedBy) {
    const members = await this.getMembers();
    const index = members.findIndex(m => String(m.userId ?? m.telegramId) === String(userId));
    const memberData = {
      userId,
      username,
      expiredAt,
      addedBy,
      addedAt: new Date().toISOString()
    };
    if (index > -1) {
      members[index] = memberData;
    } else {
      members.push(memberData);
    }
    await this.write(config.database.membersFile, members);
  }

  async removeMember(userId) {
    const members = await this.getMembers();
    const uid = String(userId);
    const filtered = members.filter(m => String(m.userId ?? m.telegramId) !== uid);
    await this.write(config.database.membersFile, filtered);
  }

  async extendMember(userId, username, days, addedBy) {
    const members = await this.getMembers();
    const index = members.findIndex(m => String(m.userId ?? m.telegramId) === String(userId));

    const now = new Date();
    const isPermanent = days === null;
    let nextExpiredAt = null;

    if (!isPermanent) {
      const daysInt = Number(days);
      if (!Number.isFinite(daysInt) || daysInt < 1) throw new Error('Durasi tidak valid');
      const base = index >= 0 && members[index].expiredAt ? new Date(members[index].expiredAt) : now;
      const baseTime = base > now ? base : now;
      const next = new Date(baseTime);
      next.setDate(next.getDate() + daysInt);
      nextExpiredAt = next.toISOString();
    }

    const next = {
      userId,
      username,
      expiredAt: isPermanent ? null : nextExpiredAt,
      addedBy,
      addedAt: new Date().toISOString()
    };

    if (index >= 0) members[index] = next;
    else members.push(next);
    await this.write(config.database.membersFile, members);
    return next;
  }

  // Workers
  async getWorkers() {
    return this._withLock('workers', async () => {
      return this.read(config.database.workersFile);
    });
  }

  async saveWorkers(workers) {
    return this._withLock('workers', async () => {
      await this.write(config.database.workersFile, workers);
    });
  }

  async updateWorkers(updaterFn) {
    return this._withLock('workers', async () => {
      const workers = await this.read(config.database.workersFile);
      const modified = await updaterFn(workers);
      if (modified !== false && modified !== undefined) {
        await this.write(config.database.workersFile, modified);
      }
      return modified || workers;
    });
  }

  // Queue
  async getQueue() {
    return this._withLock('queue', async () => {
      return this.read(config.database.queueFile);
    });
  }

  async saveQueue(queue) {
    return this._withLock('queue', async () => {
      await this.write(config.database.queueFile, queue);
    });
  }

  async updateQueue(updaterFn) {
    return this._withLock('queue', async () => {
      const queue = await this.read(config.database.queueFile);
      const modified = await updaterFn(queue);
      if (modified !== false && modified !== undefined) {
        await this.write(config.database.queueFile, modified);
      }
      return modified || queue;
    });
  }

  // Resellers
  async getResellers() {
    return this.read(config.database.resellersFile);
  }

  async saveResellers(resellers) {
    await this.write(config.database.resellersFile, resellers);
  }

  async isReseller(userId) {
    const resellers = await this.getResellers();
    return resellers.some(r => String(r.userId) === String(userId) && r.enabled !== false);
  }

  async addReseller(userId, username, addedBy, label = null) {
    const resellers = await this.getResellers();
    const index = resellers.findIndex(r => String(r.userId) === String(userId));
    const next = {
      userId,
      username,
      label,
      enabled: true,
      addedBy,
      addedAt: new Date().toISOString()
    };
    if (index >= 0) resellers[index] = { ...resellers[index], ...next };
    else resellers.push(next);
    await this.saveResellers(resellers);
    return next;
  }

  async removeReseller(userId) {
    const resellers = await this.getResellers();
    const filtered = resellers.filter(r => String(r.userId) !== String(userId));
    await this.saveResellers(filtered);
  }

  // Approvals
  async getApprovals() {
    return this.read(config.database.approvalsFile);
  }

  async saveApprovals(approvals) {
    await this.write(config.database.approvalsFile, approvals);
  }

  async addApproval(approval) {
    const approvals = await this.getApprovals();
    approvals.push(approval);
    await this.saveApprovals(approvals);
    return approval;
  }

  async getApprovalById(id) {
    const approvals = await this.getApprovals();
    return approvals.find(a => a.id === id) || null;
  }

  async updateApproval(id, patch) {
    const approvals = await this.getApprovals();
    const index = approvals.findIndex(a => a.id === id);
    if (index < 0) return null;
    approvals[index] = { ...approvals[index], ...patch };
    await this.saveApprovals(approvals);
    return approvals[index];
  }

  // Builds (unified in single file)
  async getBuilds() {
    return this.read(config.database.buildsFile);
  }

  async saveBuilds(builds) {
    await this.write(config.database.buildsFile, builds);
  }

  normalizeBuildStatsConfig(raw) {
    const cfg = { ...getDefaultBuildStatsConfig(), ...(raw && !Array.isArray(raw) ? raw : {}) };
    cfg.mode = cfg.mode === 'manual' ? 'manual' : 'auto';
    cfg.displaySuccess = cfg.displaySuccess === null || cfg.displaySuccess === undefined ? null : toNonNegativeInt(cfg.displaySuccess, 0);
    cfg.displayFailed = cfg.displayFailed === null || cfg.displayFailed === undefined ? null : toNonNegativeInt(cfg.displayFailed, 0);
    cfg.avgDurationSeconds = cfg.avgDurationSeconds === null || cfg.avgDurationSeconds === undefined ? null : toNonNegativeInt(cfg.avgDurationSeconds, 420);
    return cfg;
  }

  async getBuildStatsConfig() {
    try {
      const raw = await fs.readJson(buildStatsFile);
      return this.normalizeBuildStatsConfig(raw);
    } catch (_) {
      const cfg = getDefaultBuildStatsConfig();
      await this.write(buildStatsFile, cfg);
      return cfg;
    }
  }

  async saveBuildStatsConfig(configData) {
    const cfg = this.normalizeBuildStatsConfig(configData);
    await this.write(buildStatsFile, cfg);
    return cfg;
  }

  async getActualBuildStats() {
    const builds = await this.getBuilds();
    const completed = Array.isArray(builds) ? builds.filter(b => b && (b.status === 'success' || b.status === 'failed')) : [];
    const success = completed.filter(b => b.status === 'success').length;
    const failed = completed.filter(b => b.status === 'failed').length;
    const durations = completed
      .filter(b => b.status === 'success' && Number.isFinite(Number(b.buildDurationSeconds)))
      .map(b => Number(b.buildDurationSeconds));
    const avgDurationSeconds = durations.length === 0
      ? 420
      : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    return { success, failed, avgDurationSeconds, total: completed.length };
  }

  async getDisplayBuildStats() {
    const [actual, cfg] = await Promise.all([this.getActualBuildStats(), this.getBuildStatsConfig()]);
    const manual = cfg.mode === 'manual';
    return {
      success: manual ? toNonNegativeInt(cfg.displaySuccess, actual.success) : actual.success,
      failed: manual ? toNonNegativeInt(cfg.displayFailed, actual.failed) : actual.failed,
      avgDurationSeconds: cfg.avgDurationSeconds !== null ? cfg.avgDurationSeconds : actual.avgDurationSeconds,
      mode: cfg.mode,
      actual,
      updatedAt: cfg.updatedAt || null,
      updatedBy: cfg.updatedBy || null
    };
  }

  async setDisplayBuildStats(success, failed, updatedBy = null) {
    const currentCfg = await this.getBuildStatsConfig();
    const cfg = {
      ...currentCfg,
      mode: 'manual',
      displaySuccess: toNonNegativeInt(success, 0),
      displayFailed: toNonNegativeInt(failed, 0),
      updatedAt: new Date().toISOString(),
      updatedBy
    };
    await this.saveBuildStatsConfig(cfg);
    return this.getDisplayBuildStats();
  }

  async addDisplayBuildStats(addSuccess = 0, addFailed = 0, updatedBy = null) {
    const current = await this.getDisplayBuildStats();
    const nextSuccess = toNonNegativeInt(current.success + Number(addSuccess || 0), 0);
    const nextFailed = toNonNegativeInt(current.failed + Number(addFailed || 0), 0);
    return this.setDisplayBuildStats(nextSuccess, nextFailed, updatedBy);
  }

  async resetDisplayBuildStats(updatedBy = null) {
    const currentCfg = await this.getBuildStatsConfig();
    const cfg = {
      ...currentCfg,
      mode: 'auto',
      displaySuccess: null,
      displayFailed: null,
      updatedAt: new Date().toISOString(),
      updatedBy
    };
    await this.saveBuildStatsConfig(cfg);
    return this.getDisplayBuildStats();
  }

  async setBuildAvgDuration(secondsOrNull, updatedBy = null) {
    const currentCfg = await this.getBuildStatsConfig();
    const cfg = {
      ...currentCfg,
      avgDurationSeconds: secondsOrNull === null ? null : toNonNegativeInt(secondsOrNull, 420),
      updatedAt: new Date().toISOString(),
      updatedBy
    };
    await this.saveBuildStatsConfig(cfg);
    return this.getDisplayBuildStats();
  }

  async incrementManualBuildStat(status) {
    if (status !== 'success' && status !== 'failed') return;

    await this._withLock('build_stats', async () => {
      const cfg = await this.getBuildStatsConfig();
      if (cfg.mode !== 'manual') return;

      const actual = await this.getActualBuildStats();
      const displaySuccess = cfg.displaySuccess === null ? actual.success : toNonNegativeInt(cfg.displaySuccess, actual.success);
      const displayFailed = cfg.displayFailed === null ? actual.failed : toNonNegativeInt(cfg.displayFailed, actual.failed);

      if (status === 'success') cfg.displaySuccess = displaySuccess + 1;
      if (status === 'failed') cfg.displayFailed = displayFailed + 1;
      cfg.updatedAt = new Date().toISOString();
      await this.saveBuildStatsConfig(cfg);
    });
  }

  async getUserJobs(userId) {
    const builds = await this.getBuilds();
    return builds.filter(b => b.userId === userId);
  }

  async addJob(userId, job) {
    const builds = await this.getBuilds();
    const next = { ...job, userId };
    builds.push(next);
    await this.saveBuilds(builds);
    if (next.status === 'success' || next.status === 'failed') {
      await this.incrementManualBuildStat(next.status);
    }
  }

  async upsertJob(userId, jobId, patch) {
    const builds = await this.getBuilds();
    const index = builds.findIndex(b => b.jobId === jobId);
    const previous = index >= 0 ? builds[index] : null;
    const next = index >= 0 ? { ...builds[index], ...patch } : { jobId, userId, ...patch };
    const previousStatus = previous?.status;
    const nextStatus = next?.status;
    if (index >= 0) {
      builds[index] = next;
    } else {
      builds.push(next);
    }
    await this.saveBuilds(builds);

    const wasComplete = previousStatus === 'success' || previousStatus === 'failed';
    const isComplete = nextStatus === 'success' || nextStatus === 'failed';
    if (!wasComplete && isComplete) {
      await this.incrementManualBuildStat(nextStatus);
    }

    return next;
  }

  async getAllJobs() {
    return this.getBuilds();
  }

  // Payments
  async getPayments() {
    return this.read(config.database.paymentsFile);
  }

  async savePayments(payments) {
    await this.write(config.database.paymentsFile, payments);
  }

  async getPayment(id) {
    const payments = await this.getPayments();
    return payments[id] || null;
  }

  async updatePayment(id, data) {
    const payments = await this.getPayments();
    payments[id] = { ...payments[id], ...data };
    await this.savePayments(payments);
    return payments[id];
  }

  // Prices
  async getPrices() {
    return this.read(config.database.pricesFile);
  }

  async savePrices(prices) {
    await this.write(config.database.pricesFile, prices);
  }

  async getPrice(id) {
    const prices = await this.getPrices();
    return prices[id] || null;
  }

  async updatePrice(id, data) {
    const prices = await this.getPrices();
    prices[id] = { ...prices[id], ...data };
    await this.savePrices(prices);
    return prices[id];
  }

  // Orders
  async getOrders() {
    return this.read(config.database.ordersFile);
  }

  async saveOrders(orders) {
    await this.write(config.database.ordersFile, orders);
  }

  async addOrder(order) {
    const orders = await this.getOrders();
    const newOrder = {
      ...order,
      id: `ORD${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`,
      createdAt: new Date().toISOString()
    };
    orders.push(newOrder);
    await this.saveOrders(orders);
    return newOrder;
  }

  async getOrderById(id) {
    const orders = await this.getOrders();
    return orders.find(o => o.id === id) || null;
  }

  async updateOrder(id, patch) {
    const orders = await this.getOrders();
    const index = orders.findIndex(o => o.id === id);
    if (index < 0) return null;
    orders[index] = { ...orders[index], ...patch };
    await this.saveOrders(orders);
    return orders[index];
  }

  async deleteOrder(id) {
    const orders = await this.getOrders();
    const filtered = orders.filter(o => o.id !== id);
    await this.saveOrders(filtered);
  }

  async getPendingOrdersByUser(userId) {
    const orders = await this.getOrders();
    return orders.filter(o => o.userId === userId && o.status === 'pending');
  }

  // Laporan / Report (fitur "Hubungi Owner")
  async getReports() {
    return this._withLock('reports', async () => {
      if (!config.database.reportsFile) return [];
      if (!fs.existsSync(config.database.reportsFile)) return [];
      return this.read(config.database.reportsFile);
    });
  }

  async saveReports(reports) {
    return this._withLock('reports', async () => {
      await this.write(config.database.reportsFile, reports);
    });
  }

  async addReport(report) {
    const reports = await this.getReports();
    reports.push(report);
    await this.saveReports(reports);
    return report;
  }

  async getReportById(id) {
    const reports = await this.getReports();
    return reports.find(r => r.id === id) || null;
  }

  async updateReport(id, patch) {
    return this._withLock('reports', async () => {
      const reports = fs.existsSync(config.database.reportsFile)
        ? await this.read(config.database.reportsFile)
        : [];
      const index = reports.findIndex(r => r.id === id);
      if (index < 0) return null;
      reports[index] = { ...reports[index], ...patch };
      await this.write(config.database.reportsFile, reports);
      return reports[index];
    });
  }
}

module.exports = new Database();
