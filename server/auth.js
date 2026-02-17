const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let CONFIG_FILE;
let JWT_SECRET;
const JWT_EXPIRES = '24h';

function init(configDir) {
  CONFIG_FILE = path.join(configDir, 'auth-config.json');
  // Persist JWT_SECRET so tokens survive server restarts
  const secretFile = path.join(configDir, '.jwt-secret');
  try {
    if (fs.existsSync(secretFile)) {
      JWT_SECRET = fs.readFileSync(secretFile, 'utf-8').trim();
    }
  } catch {}
  if (!JWT_SECRET) {
    JWT_SECRET = crypto.randomBytes(64).toString('hex');
    try {
      fs.writeFileSync(secretFile, JWT_SECRET, { mode: 0o600 });
    } catch {}
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function isSetupComplete() {
  return loadConfig() !== null;
}

async function createAdmin(password) {
  const hash = await bcrypt.hash(password, 12);
  const config = { passwordHash: hash, apiKeys: [] };
  saveConfig(config);
  return config;
}

async function verifyPassword(password) {
  const config = loadConfig();
  if (!config) return false;
  return bcrypt.compare(password, config.passwordHash);
}

function generateToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function generateApiKey(name) {
  const config = loadConfig();
  if (!config) return null;
  const key = 'wih_' + crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const entry = { id, name, key, createdAt: new Date().toISOString() };
  config.apiKeys.push(entry);
  saveConfig(config);
  return entry;
}

function listApiKeys() {
  const config = loadConfig();
  if (!config) return [];
  return config.apiKeys.map(k => ({
    id: k.id,
    name: k.name,
    keyPreview: k.key.slice(0, 8) + '...' + k.key.slice(-4),
    createdAt: k.createdAt,
  }));
}

function deleteApiKey(id) {
  const config = loadConfig();
  if (!config) return false;
  const before = config.apiKeys.length;
  config.apiKeys = config.apiKeys.filter(k => k.id !== id);
  if (config.apiKeys.length < before) {
    saveConfig(config);
    return true;
  }
  return false;
}

function verifyApiKey(key) {
  const config = loadConfig();
  if (!config) return false;
  return config.apiKeys.some(k => k.key === key);
}

function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && verifyApiKey(apiKey)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (verifyToken(token)) {
      return next();
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}

module.exports = {
  init,
  isSetupComplete,
  createAdmin,
  verifyPassword,
  generateToken,
  verifyToken,
  generateApiKey,
  listApiKeys,
  deleteApiKey,
  verifyApiKey,
  authMiddleware,
};
