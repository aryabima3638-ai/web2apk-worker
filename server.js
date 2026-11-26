/**
 * Web Server with Key-only Login API
 * Express server for web dashboard with access key authentication
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const accessKeyService = require('./bot/utils/accessKeyService');

const app = express();

// Pterodactyl support: read port from environment variable
// Pterodactyl sets SERVER_PORT or APP_PORT, fallback to 3000
const PORT = process.env.SERVER_PORT || process.env.APP_PORT || process.env.PORT || 3000;

// Bind to 0.0.0.0 for container support (required by Pterodactyl)
const HOST = process.env.SERVER_IP || '0.0.0.0';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'web')));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ========== AUTH API ==========

/**
 * POST /api/auth/login
 * Key-only login - no username needed
 * Body: { key, deviceId }
 */
app.post('/api/auth/login', (req, res) => {
  const { key, deviceId } = req.body;

  if (!key || !deviceId) {
    return res.status(400).json({
      success: false,
      error: 'Key dan Device ID diperlukan'
    });
  }

  const result = accessKeyService.validateLogin(key, deviceId);

  if (result.success) {
    res.json({
      success: true,
      member: result.member,
      message: 'Login berhasil'
    });
  } else {
    res.status(401).json({
      success: false,
      error: result.error
    });
  }
});

/**
 * GET /api/auth/verify
 * Verify session validity
 * Query: ?key=XXX&deviceId=YYY
 */
app.get('/api/auth/verify', (req, res) => {
  const { key, deviceId } = req.query;

  if (!key || !deviceId) {
    return res.status(400).json({
      valid: false,
      error: 'Key dan Device ID diperlukan'
    });
  }

  const result = accessKeyService.verifySession(key, deviceId);

  if (result.valid) {
    res.json({
      valid: true,
      member: result.member
    });
  } else {
    res.status(401).json({
      valid: false,
      error: result.error
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout - clear device binding
 * Body: { key, deviceId }
 */
app.post('/api/auth/logout', (req, res) => {
  const { key, deviceId } = req.body;

  if (!key || !deviceId) {
    return res.status(400).json({
      success: false,
      error: 'Key dan Device ID diperlukan'
    });
  }

  const result = accessKeyService.logout(key, deviceId);

  if (result.success) {
    res.json({
      success: true,
      message: 'Logout berhasil'
    });
  } else {
    res.status(400).json({
      success: false,
      error: result.error
    });
  }
});

// ========== MEMBER API (Admin Only) ==========

/**
 * GET /api/members
 * List all members with access keys
 */
app.get('/api/members', (req, res) => {
  // In production, add admin authentication here
  const members = accessKeyService.listMembers();
  res.json({
    success: true,
    count: members.length,
    members
  });
});

/**
 * POST /api/members/extend
 * Extend key expiration
 * Body: { key, days }
 */
app.post('/api/members/extend', (req, res) => {
  const { key, days } = req.body;

  if (!key || !days) {
    return res.status(400).json({
      success: false,
      error: 'Key dan days diperlukan'
    });
  }

  const result = accessKeyService.extendKey(key, days);

  if (result.success) {
    res.json({
      success: true,
      newExpiresAt: result.newExpiresAt,
      addedDays: result.addedDays
    });
  } else {
    res.status(400).json({
      success: false,
      error: result.error
    });
  }
});

/**
 * DELETE /api/members
 * Delete access key
 * Body: { key }
 */
app.delete('/api/members', (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({
      success: false,
      error: 'Key diperlukan'
    });
  }

  const result = accessKeyService.deleteKey(key);

  if (result.success) {
    res.json({
      success: true,
      message: 'Key berhasil dihapus'
    });
  } else {
    res.status(400).json({
      success: false,
      error: result.error
    });
  }
});

// ========== WEB DASHBOARD ==========

// Redirect root to login
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'login.html'));
});

// Serve dashboard (protected by key validation in frontend)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'dashboard.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server with Pterodactyl support
app.listen(PORT, HOST, () => {
  console.log(`🌐 Web server running on ${HOST}:${PORT}`);
  console.log(`📊 Dashboard: http://${HOST}:${PORT}/login`);
});

module.exports = app;
