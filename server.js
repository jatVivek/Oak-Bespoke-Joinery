'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const db           = require('./db');

// ─── Environment ─────────────────────────────────────────────────────────────

const PORT          = parseInt(process.env.PORT || '3001', 10);
const JWT_SECRET    = process.env.JWT_SECRET;
const OWNER_PIN_HASH = process.env.OWNER_PIN_HASH;
const CORS_ORIGIN   = (process.env.CORS_ORIGIN || 'http://localhost:3000')
                        .split(',')
                        .map(o => o.trim());

if (!JWT_SECRET || JWT_SECRET === 'change_this_to_a_long_random_string') {
  console.error('[FATAL] JWT_SECRET is not set or is still the example value. Set it in .env');
  process.exit(1);
}

if (!OWNER_PIN_HASH) {
  console.error('[FATAL] OWNER_PIN_HASH is not set. Add a bcrypt hash to .env');
  process.exit(1);
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1); // needed for accurate IP behind reverse proxies

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet());

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (e.g. curl, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (CORS_ORIGIN.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin "${origin}" not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '32kb' }));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

const enquiryPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many enquiry submissions. Please wait 15 minutes before trying again.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitise a string input: trim, collapse internal whitespace, remove
 * characters that have no business in form fields (<, >, ", `, \x00, etc.).
 */
function sanitise(str) {
  if (typeof str !== 'string') return str;
  return str
    .trim()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // control chars
    .replace(/[<>"'`]/g, '');                            // html / template chars
}

/** Generate an OM-XXXX id. Checks the DB to avoid collisions. */
function generateId() {
  const digits = () => String(Math.floor(1000 + Math.random() * 9000));
  let id;
  let tries = 0;
  do {
    id = `OM-${digits()}`;
    tries++;
    if (tries > 50) throw new Error('Could not generate unique enquiry ID');
  } while (db.prepare('SELECT 1 FROM enquiries WHERE id = ?').get(id));
  return id;
}

/** Middleware: verify Bearer JWT, attach decoded payload to req.user */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/** Wrap async route handlers so thrown errors reach Express error handler */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Validation constants ─────────────────────────────────────────────────────

const VALID_STATUSES = new Set(['New Enquiry', 'Site Measure Booked', 'Quoted', 'Won', 'new', 'in-progress', 'quoted', 'closed']);

const VALID_SURVEY   = new Set(['yes', 'no', 'unsure']);

// Allowed project types — keep this in sync with the front-end options
const VALID_PROJECTS = new Set([
  'front-door', 'back-door', 'french-doors', 'garage-door',
  'staircase', 'stair-parts', 'gate', 'window', 'other',
]);

const VALID_FINISHES = new Set([
  'primed', 'painted', 'oiled', 'waxed', 'lacquered', 'bare', 'other',
]);

// ─── Routes ───────────────────────────────────────────────────────────────────

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Body: { pin: "XXXX" }
 * Returns: { token: "<jwt>" }
 */
app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { pin } = req.body;

  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin.trim())) {
    return res.status(400).json({ error: 'Invalid PIN format' });
  }

  const match = await bcrypt.compare(pin.trim(), OWNER_PIN_HASH);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  const token = jwt.sign({ role: 'owner' }, JWT_SECRET, { expiresIn: '8h' });
  return res.json({ token });
}));

// ── Enquiries ─────────────────────────────────────────────────────────────────

/**
 * GET /api/enquiries
 * Protected. Returns all enquiries ordered newest-first.
 * Optional query params: status, limit (default 200), offset (default 0)
 */
app.get('/api/enquiries', requireAuth, wrap(async (req, res) => {
  let { status, limit = '200', offset = '0' } = req.query;

  limit  = Math.min(Math.max(parseInt(limit,  10) || 200, 1), 500);
  offset = Math.max(parseInt(offset, 10) || 0, 0);

  let rows;
  if (status && VALID_STATUSES.has(status)) {
    rows = db.prepare(
      'SELECT * FROM enquiries WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(status, limit, offset);
  } else {
    rows = db.prepare(
      'SELECT * FROM enquiries ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset);
  }

  return res.json({ enquiries: rows, count: rows.length });
}));

/**
 * POST /api/enquiries
 * Public (rate-limited). Creates a new enquiry.
 * Required body fields: name, postcode, property, survey, project, width, finish
 * Optional: notes, estimate
 */
app.post('/api/enquiries', enquiryPostLimiter, wrap(async (req, res) => {
  const {
    name, postcode, property, survey,
    project, width, finish, notes, estimate,
  } = req.body;

  // --- Required field presence ---
  const missing = [];
  if (!name)     missing.push('name');
  if (!postcode) missing.push('postcode');
  if (!property) missing.push('property');
  if (!survey)   missing.push('survey');
  if (!project)  missing.push('project');
  if (!width)    missing.push('width');
  if (!finish)   missing.push('finish');

  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  // --- Length caps to prevent huge payloads ---
  const sanitisedName     = sanitise(String(name));
  const sanitisedPostcode = sanitise(String(postcode)).toUpperCase();
  const sanitisedProperty = sanitise(String(property));
  const sanitisedSurvey   = sanitise(String(survey));
  const sanitisedProject  = sanitise(String(project));
  const sanitisedWidth    = sanitise(String(width));
  const sanitisedFinish   = sanitise(String(finish));
  const sanitisedNotes    = notes    ? sanitise(String(notes)).slice(0, 2000)    : null;
  const sanitisedEstimate = estimate ? sanitise(String(estimate)).slice(0, 200)  : null;

  if (sanitisedName.length     < 2  || sanitisedName.length     > 120) return res.status(400).json({ error: 'name must be 2–120 characters' });
  if (sanitisedPostcode.length < 3  || sanitisedPostcode.length > 10)  return res.status(400).json({ error: 'postcode must be 3–10 characters' });
  if (sanitisedProperty.length < 2  || sanitisedProperty.length > 200) return res.status(400).json({ error: 'property must be 2–200 characters' });

  const id = req.body.id && /^OM-\d{4,6}$/.test(req.body.id) ? req.body.id : generateId();

  db.prepare(`
    INSERT OR REPLACE INTO enquiries (id, name, postcode, property, survey, project, width, finish, estimate, notes, status)
    VALUES (@id, @name, @postcode, @property, @survey, @project, @width, @finish, @estimate, @notes, @status)
  `).run({
    id,
    name:     sanitisedName,
    postcode: sanitisedPostcode,
    property: sanitisedProperty,
    survey:   sanitisedSurvey,
    project:  sanitisedProject,
    width:    sanitisedWidth,
    finish:   sanitisedFinish,
    estimate: sanitisedEstimate,
    notes:    sanitisedNotes,
    status:   req.body.status && VALID_STATUSES.has(req.body.status) ? req.body.status : 'New Enquiry',
  });

  const row = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  return res.status(201).json({ enquiry: row });
}));

/**
 * PATCH /api/enquiries/:id/status
 * Protected. Updates the status of an enquiry.
 * Body: { status: "new"|"in-progress"|"quoted"|"closed" }
 */
app.patch('/api/enquiries/:id/status', requireAuth, wrap(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
  }

  const existing = db.prepare('SELECT id FROM enquiries WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  db.prepare('UPDATE enquiries SET status = ? WHERE id = ?').run(status, id);
  const updated = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
  return res.json({ enquiry: updated });
}));

/**
 * DELETE /api/enquiries/:id
 * Protected. Permanently deletes an enquiry.
 */
app.delete('/api/enquiries/:id', requireAuth, wrap(async (req, res) => {
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM enquiries WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Enquiry not found' });

  db.prepare('DELETE FROM enquiries WHERE id = ?').run(id);
  return res.status(200).json({ message: `Enquiry ${id} deleted` });
}));

// ── Brand Config ──────────────────────────────────────────────────────────────

/**
 * GET /api/brand
 * Public. Returns the current brand configuration object.
 */
app.get('/api/brand', wrap(async (_req, res) => {
  const row = db.prepare('SELECT config_json FROM brand_config WHERE id = 1').get();
  let config = {};
  try { config = JSON.parse(row?.config_json || '{}'); } catch (_) { /* ignore */ }
  return res.json({ brand: config });
}));

/**
 * PUT /api/brand
 * Protected. Replaces the brand configuration.
 * Body: any valid JSON object (max 64 KB).
 */
app.put('/api/brand', requireAuth, wrap(async (req, res) => {
  const body = req.body;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) {
    return res.status(413).json({ error: 'Brand config exceeds 64 KB limit' });
  }

  db.prepare('UPDATE brand_config SET config_json = ? WHERE id = 1').run(json);
  return res.json({ brand: body });
}));

// ─── 404 catch-all ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Log the full error server-side
  console.error(`[ERROR] ${req.method} ${req.url} —`, err.message || err);

  // CORS errors should bubble up with their own status
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ error: err.message });
  }

  // Never expose internal details
  if (res.headersSent) return;
  return res.status(500).json({ error: 'An unexpected error occurred' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Oak & Mortise API] Listening on http://localhost:${PORT}`);
  console.log(`[Oak & Mortise API] CORS allowed origins: ${CORS_ORIGIN.join(', ')}`);
});

module.exports = app; // for testing
