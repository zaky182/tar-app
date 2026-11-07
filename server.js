/**
 * =====================================================================
 *  TECHNICAL ANALYSIS REPORT (TAR) SYSTEM — PT Riung Mitra Lestari
 *  Backend: Node.js (Express) + PostgreSQL
 *
 *  - Login berbasis cookie httpOnly (JWT), password di-hash bcrypt
 *  - Hak akses berjenjang per role (Mekanik / Planner / Supervisor /
 *    Lead Engineer / Site Manager), dicek di SERVER pada setiap endpoint
 *  - Workflow: Draft -> Submitted -> Under Review -> Approved / Rejected
 *  - Setiap perubahan status tercatat di tabel approval_log (audit trail)
 *  - Foto kerusakan disimpan di volume server (UPLOAD_DIR), disajikan
 *    lewat /files/<nama> hanya untuk user yang sudah login
 *  - Notifikasi: webhook (n8n/WAHA) dan/atau Telegram
 * =====================================================================
 */
'use strict';

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/* ------------------------------ KONFIGURASI ------------------------------ */
const env = process.env;
const CFG = {
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL,
  jwtSecret: env.JWT_SECRET || '',
  tz: env.APP_TZ || 'Asia/Makassar',
  company: env.COMPANY_NAME || 'PT Riung Mitra Lestari',
  logoUrl: env.LOGO_URL || '',                       // contoh: /logo.png (taruh file di public/)
  appUrl: (env.APP_URL || '').replace(/\/+$/, ''),   // contoh: https://tar.domainanda.com
  uploadDir: path.resolve(env.UPLOAD_DIR || '/data/uploads'),
  seedDemo: env.SEED_DEMO !== 'false',
  cookieSecure: env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'false',
  sessionHours: Number(env.SESSION_HOURS) || 12,
  maxPhotos: 8,
  maxPhotoBytes: 8 * 1024 * 1024,
  webhookUrl: env.WEBHOOK_URL || '',
  webhookSecret: env.WEBHOOK_SECRET || '',
  tgToken: env.TELEGRAM_BOT_TOKEN || '',
  tgChat: env.TELEGRAM_CHAT_ID || ''
};
if (!CFG.databaseUrl) { console.error('FATAL: DATABASE_URL belum diatur.'); process.exit(1); }
if (CFG.jwtSecret.length < 32) { console.error('FATAL: JWT_SECRET wajib diisi (minimal 32 karakter).'); process.exit(1); }
if (!/^[A-Za-z0-9_\/+-]+$/.test(CFG.tz)) { console.error('FATAL: APP_TZ tidak valid.'); process.exit(1); }

const R = { MEK: 'Mekanik', PLN: 'Planner', SPV: 'Supervisor', LEAD: 'Lead Engineer', SM: 'Site Manager' };
const ROLE_LIST = Object.values(R);
const ST = { DRAFT: 'Draft', SUBMITTED: 'Submitted', REVIEW: 'Under Review', APPROVED: 'Approved', REJECTED: 'Rejected' };
const MODELS = ['Volvo FMX400', 'Komatsu PC500', 'Komatsu PC200', 'Komatsu D85ESS'];
const SUBSYSTEMS = ['Engine', 'Hydraulic', 'Transmission', 'Undercarriage', 'Electrical'];

/* -------------------------------- DATABASE -------------------------------- */
const pool = new Pool({ connectionString: CFG.databaseUrl, max: 10 });
pool.on('connect', c => c.query(`SET TIME ZONE '${CFG.tz}'`));   // semua tanggal diformat dalam zona waktu jobsite
pool.on('error', e => console.error('PG pool error:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  nama_lengkap TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Mekanik','Planner','Supervisor','Lead Engineer','Site Manager')),
  email TEXT,
  wa_number TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  token_version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS units (
  id_unit TEXT PRIMARY KEY,
  model_unit TEXT NOT NULL,
  serial_number TEXT NOT NULL UNIQUE,
  current_hm NUMERIC DEFAULT 0,
  lokasi_jobsite TEXT,
  status_operasional TEXT DEFAULT 'Operasional'
);
CREATE TABLE IF NOT EXISTS components_catalog (
  id_komponen TEXT PRIMARY KEY,
  subsystem TEXT NOT NULL,
  kode_part TEXT NOT NULL,
  nama_part TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tar_counter (
  period TEXT PRIMARY KEY,
  last INT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  tar_number TEXT PRIMARY KEY,
  tanggal_laporan TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_unit TEXT, serial_number TEXT, hm_unit NUMERIC, lokasi TEXT, subsystem TEXT,
  fault_code_gejala TEXT, kronologi TEXT,
  why_1 TEXT, why_2 TEXT, why_3 TEXT, why_4 TEXT, why_5 TEXT,
  akar_masalah TEXT, bukti_pengukuran TEXT, action_plan TEXT,
  part_required JSONB NOT NULL DEFAULT '[]',
  estimasi_manhour NUMERIC,
  nama_mekanik TEXT NOT NULL,
  mekanik_username TEXT NOT NULL,
  status_approval TEXT NOT NULL DEFAULT 'Draft',
  supervisor_notes TEXT DEFAULT '',
  photos JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status_approval);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(tanggal_laporan DESC);
CREATE INDEX IF NOT EXISTS idx_reports_mekanik ON reports(mekanik_username);
CREATE TABLE IF NOT EXISTS approval_log (
  log_id TEXT PRIMARY KEY,
  tar_number TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  actor_user TEXT NOT NULL,
  actor_username TEXT,
  action_taken TEXT NOT NULL,
  catatan TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_log_tar ON approval_log(tar_number);
`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Membuat tabel (idempotent), folder upload, dan data contoh bila diminta. */
async function migrate() {
  for (let i = 1; ; i++) {                       // database bisa belum siap saat container baru start
    try { await pool.query('SELECT 1'); break; }
    catch (e) {
      if (i >= 15) throw e;
      console.log(`Menunggu database (${i}/15): ${e.message}`);
      await sleep(3000);
    }
  }
  await pool.query(SCHEMA);
  await fsp.mkdir(CFG.uploadDir, { recursive: true });
  if (CFG.seedDemo) await seed();
}

/** Data contoh — HANYA dimasukkan jika tabelnya masih kosong. Ganti dengan data asli. */
async function seed() {
  const count = async t => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
  if ((await count('users')) === 0) {
    const demo = [
      ['mekanik1', 'Mekanik@123', 'Budi Santoso', R.MEK],
      ['mekanik2', 'Mekanik@123', 'Andi Pratama', R.MEK],
      ['planner1', 'Planner@123', 'Rina Wulandari', R.PLN],
      ['supervisor1', 'Supervisor@123', 'Hendra Wijaya', R.SPV],
      ['lead1', 'Lead@123', 'Ir. Dimas Prakoso', R.LEAD],
      ['manager1', 'Manager@123', 'Agus Setiawan', R.SM]
    ];
    for (const [u, p, n, r] of demo) {
      await pool.query('INSERT INTO users(username,password_hash,nama_lengkap,role,email) VALUES($1,$2,$3,$4,$5)',
        [u, await bcrypt.hash(p, 10), n, r, u + '@example.com']);
    }
    console.log('Seed: 6 akun demo dibuat. SEGERA ganti password (lihat README: node scripts/user.js passwd).');
  }
  if ((await count('units')) === 0) {
    const units = [
      ['UNIT-001', 'Volvo FMX400', 'VOLV-FMX-10234', 12450, 'Pit A', 'Operasional'],
      ['UNIT-002', 'Volvo FMX400', 'VOLV-FMX-10235', 11820, 'Pit A', 'Operasional'],
      ['UNIT-003', 'Komatsu PC500', 'KMTS-PC500-50871', 18340, 'Pit B', 'Operasional'],
      ['UNIT-004', 'Komatsu PC500', 'KMTS-PC500-50872', 17210, 'Pit B', 'Standby'],
      ['UNIT-005', 'Komatsu PC200', 'KMTS-PC200-20456', 9560, 'Hauling Road', 'Operasional'],
      ['UNIT-006', 'Komatsu PC200', 'KMTS-PC200-20457', 8730, 'Workshop', 'Breakdown'],
      ['UNIT-007', 'Komatsu D85ESS', 'KMTS-D85-85123', 14900, 'Disposal Area', 'Operasional'],
      ['UNIT-008', 'Komatsu D85ESS', 'KMTS-D85-85124', 13580, 'Pit A', 'Standby']
    ];
    for (const u of units) await pool.query('INSERT INTO units VALUES($1,$2,$3,$4,$5,$6)', u);
  }
  if ((await count('components_catalog')) === 0) {
    const parts = [
      ['Engine', 'ENG-0001', 'Fuel Filter'], ['Engine', 'ENG-0002', 'Oil Filter'], ['Engine', 'ENG-0003', 'Turbocharger Assy'],
      ['Engine', 'ENG-0004', 'Injector'], ['Engine', 'ENG-0005', 'Water Pump'],
      ['Hydraulic', 'HYD-0001', 'Main Hydraulic Pump'], ['Hydraulic', 'HYD-0002', 'Cylinder Seal Kit'], ['Hydraulic', 'HYD-0003', 'Control Valve'],
      ['Hydraulic', 'HYD-0004', 'Hydraulic Hose'], ['Hydraulic', 'HYD-0005', 'Hydraulic Oil Filter'],
      ['Transmission', 'TRN-0001', 'Transmission Filter'], ['Transmission', 'TRN-0002', 'Clutch Pack'],
      ['Transmission', 'TRN-0003', 'Torque Converter'], ['Transmission', 'TRN-0004', 'Final Drive Seal'],
      ['Undercarriage', 'UCG-0001', 'Track Shoe'], ['Undercarriage', 'UCG-0002', 'Track Roller'], ['Undercarriage', 'UCG-0003', 'Carrier Roller'],
      ['Undercarriage', 'UCG-0004', 'Idler'], ['Undercarriage', 'UCG-0005', 'Sprocket'],
      ['Electrical', 'ELC-0001', 'Alternator'], ['Electrical', 'ELC-0002', 'Starter Motor'], ['Electrical', 'ELC-0003', 'ECM / Controller'],
      ['Electrical', 'ELC-0004', 'Wiring Harness'], ['Electrical', 'ELC-0005', 'Pressure Sensor']
    ];
    for (let i = 0; i < parts.length; i++) {
      await pool.query('INSERT INTO components_catalog VALUES($1,$2,$3,$4)', ['CMP-' + String(i + 1).padStart(3, '0'), ...parts[i]]);
    }
  }
}

/* --------------------------------- HELPER --------------------------------- */
class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'ERR'; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 2000);
const numOrNull = v => (v === '' || v == null) ? null : Number(v);
const stamp = () => new Intl.DateTimeFormat('id-ID', { timeZone: CFG.tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

const SEL_REPORT = `SELECT *, to_char(tanggal_laporan,'YYYY-MM-DD HH24:MI:SS') AS tanggal_fmt FROM reports`;

/** Baris DB -> objek laporan untuk klien (nama field sama dengan versi Google Sheets). */
function toReport(r) {
  const photos = (r.photos || []).map(f => ({ url: '/files/' + f, id: f }));
  return {
    TAR_Number: r.tar_number, Tanggal_Laporan: r.tanggal_fmt, Model_Unit: r.model_unit || '', Serial_Number: r.serial_number || '',
    HM_Unit: r.hm_unit === null ? '' : Number(r.hm_unit), Lokasi: r.lokasi || '', Subsystem: r.subsystem || '',
    Fault_Code_Gejala: r.fault_code_gejala || '', Kronologi: r.kronologi || '',
    Why_1: r.why_1 || '', Why_2: r.why_2 || '', Why_3: r.why_3 || '', Why_4: r.why_4 || '', Why_5: r.why_5 || '',
    Akar_Masalah: r.akar_masalah || '', Bukti_Pengukuran: r.bukti_pengukuran || '', Action_Plan: r.action_plan || '',
    Estimasi_ManHour: r.estimasi_manhour === null ? '' : Number(r.estimasi_manhour),
    Nama_Mekanik: r.nama_mekanik, Status_Approval: r.status_approval, Supervisor_Notes: r.supervisor_notes || '',
    Drive_Photo_URL: photos.map(p => p.url).join('\n'), parts: r.part_required || [], photos
  };
}

const publicUser = u => ({ Username: u.username, Nama_Lengkap: u.nama_lengkap, Role: u.role, Email: u.email });

function canView(user, r) {
  return user.role === R.MEK ? r.mekanik_username === user.username : r.status_approval !== ST.DRAFT;
}

/** Tulis audit trail. Gunakan client transaksi agar atomik dengan perubahan status. */
async function logAction(db, tar, user, action, notes) {
  const id = 'LOG-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
  await db.query('INSERT INTO approval_log(log_id,tar_number,actor_user,actor_username,action_taken,catatan) VALUES($1,$2,$3,$4,$5,$6)',
    [id, tar, `${user.nama_lengkap} (${user.role})`, user.username, action, notes || '']);
}

/** Nomor TAR berurutan per bulan (TAR-YYYYMM-0001), atomik lewat upsert. */
async function nextTar(client) {
  const p = (await client.query(`SELECT to_char(now(),'YYYYMM') AS p`)).rows[0].p;
  const c = (await client.query(
    'INSERT INTO tar_counter(period,last) VALUES($1,1) ON CONFLICT (period) DO UPDATE SET last = tar_counter.last + 1 RETURNING last', [p])).rows[0];
  return `TAR-${p}-${String(c.last).padStart(4, '0')}`;
}

/* ------------------------------ FOTO (DISK) ------------------------------ */
const MAGIC = [
  { ext: '.jpg', ok: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: '.png', ok: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { ext: '.webp', ok: b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' }
];
/** Validasi isi file (magic bytes, bukan sekadar ekstensi) lalu simpan dengan nama acak. */
async function savePhoto(ph) {
  const buf = Buffer.from(String((ph && ph.data) || ''), 'base64');
  if (!buf.length || buf.length > CFG.maxPhotoBytes) throw new HttpError(400, 'Ukuran foto tidak valid (maks. 8 MB per foto).');
  const m = MAGIC.find(x => x.ok(buf));
  if (!m) throw new HttpError(400, 'Format foto tidak didukung (gunakan JPG, PNG, atau WEBP).');
  const name = crypto.randomUUID() + m.ext;
  await fsp.writeFile(path.join(CFG.uploadDir, name), buf, { flag: 'wx' });
  return name;
}
const rmFiles = files => Promise.all(files.map(f => fsp.unlink(path.join(CFG.uploadDir, f)).catch(() => {})));

/* ------------------------------ VALIDASI TAR ------------------------------ */
function validateReport(p, submit, photoCount) {
  const e = [];
  if (!MODELS.includes(p.model)) e.push('Model unit wajib dipilih.');
  const hmGiven = p.hm !== '' && p.hm != null;
  const hm = Number(p.hm);
  if ((submit || hmGiven) && !(Number.isFinite(hm) && hm > 0)) e.push('Hour Meter (HM) wajib berupa angka positif.');
  if (p.subsystem && !SUBSYSTEMS.includes(p.subsystem)) e.push('Subsystem tidak valid.');
  if (p.manhour !== '' && p.manhour != null && !(Number.isFinite(Number(p.manhour)) && Number(p.manhour) >= 0)) e.push('Estimasi Man Hour harus berupa angka ≥ 0.');
  (Array.isArray(p.parts) ? p.parts : []).forEach((x, i) => {
    if (x && (x.pn || x.name) && !(Number(x.qty) > 0)) e.push(`Qty spare part baris ${i + 1} harus lebih dari 0.`);
  });
  if (submit) {
    if (!txt(p.sn)) e.push('Serial Number wajib diisi.');
    if (!p.subsystem) e.push('Subsystem wajib dipilih.');
    if (!txt((p.why || [])[0])) e.push('Root Cause (Why 1) wajib diisi.');
    if (photoCount < 1) e.push('Foto kerusakan wajib diunggah saat submit.');
  }
  return e;
}

/* ------------------------------- NOTIFIKASI ------------------------------- */
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); } finally { clearTimeout(t); }
}

/** Payload event webhook (kompatibel dengan versi Apps Script sebelumnya). */
function buildEvent(type, rep, actor, notes, baseUrl) {
  return {
    event: type, sent_at: new Date().toISOString(), app_url: baseUrl,
    actor: { name: actor.nama_lengkap, role: actor.role }, notes: notes || '',
    tar: {
      number: rep.TAR_Number, status: rep.Status_Approval, tanggal: rep.Tanggal_Laporan, model: rep.Model_Unit,
      serial: rep.Serial_Number, hm: rep.HM_Unit, lokasi: rep.Lokasi, subsystem: rep.Subsystem, fault: rep.Fault_Code_Gejala,
      akar_masalah: rep.Akar_Masalah, action_plan: rep.Action_Plan, estimasi_manhour: rep.Estimasi_ManHour,
      mekanik: rep.Nama_Mekanik, supervisor_notes: rep.Supervisor_Notes,
      photos: rep.photos.map(p => (baseUrl || '') + p.url)
    }
  };
}

/** Kirim ke webhook & Telegram. Tidak pernah melempar error ke alur utama. */
async function notify(title, text, roles, mekanikUsername, event) {
  const msg = `[TAR System] ${title}\n${text}`;
  let recipients = [];
  try {
    const q = await pool.query(
      'SELECT nama_lengkap, role, email, wa_number FROM users WHERE active AND (role = ANY($1) OR username = $2)',
      [roles || [], mekanikUsername || '']);
    recipients = q.rows.map(u => ({ nama: u.nama_lengkap, role: u.role, email: u.email, wa: u.wa_number }));
  } catch (e) { console.warn('notify: gagal ambil penerima:', e.message); }

  if (CFG.tgToken && CFG.tgChat) {
    try {
      await fetchT(`https://api.telegram.org/bot${CFG.tgToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CFG.tgChat, text: msg })
      });
    } catch (e) { console.warn('Telegram gagal:', e.message); }
  }
  if (CFG.webhookUrl) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (CFG.webhookSecret) headers['X-Webhook-Secret'] = CFG.webhookSecret;   // cocokkan dengan Header Auth di node Webhook n8n
      const payload = Object.assign({
        title, message: text, text: msg, notify_roles: roles || [], notify_mekanik: mekanikUsername || '', recipients
      }, event || {});
      const res = await fetchT(CFG.webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
      if (!res.ok) console.warn('Webhook HTTP ' + res.status);
    } catch (e) { console.warn('Webhook gagal:', e.message); }
  }
}
const fireNotify = (...a) => { notify(...a).catch(e => console.warn('notify error:', e.message)); };
const baseUrlOf = req => CFG.appUrl || `${req.protocol}://${req.get('host')}`;

/* --------------------------------- EXPRESS -------------------------------- */
const app = express();
app.set('trust proxy', 1);                     // di belakang proxy EasyPanel (HTTPS)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'about:'],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '30mb' }));      // foto dikirim base64 (sudah dikompres klien)
app.use(cookieParser());

app.get('/healthz', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

/* ----------------------------- AUTENTIKASI ----------------------------- */
const DUMMY_HASH = bcrypt.hashSync('tidak-dipakai', 10);     // menyamakan waktu respons untuk username yang tak ada
const fails = new Map();                                      // pembatas percobaan login: 5 gagal / 15 menit
const tooMany = k => { const f = fails.get(k); if (!f) return false; if (Date.now() > f.until) { fails.delete(k); return false; } return f.n >= 5; };
const addFail = k => { const f = fails.get(k), now = Date.now(); if (!f || now > f.until) fails.set(k, { n: 1, until: now + 15 * 60000 }); else f.n++; };
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (now > v.until) fails.delete(k); }, 600000).unref();

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: CFG.cookieSecure, maxAge: CFG.sessionHours * 3600 * 1000, path: '/' });
function issueSession(res, u) {
  const t = jwt.sign({ u: u.username, v: u.token_version }, CFG.jwtSecret, { expiresIn: CFG.sessionHours + 'h' });
  res.cookie('tar_session', t, cookieOpts());
}
const authErr = () => new HttpError(401, 'Sesi berakhir, silakan login kembali.', 'AUTH');

/** Middleware: wajib login (+ batasi role bila diberikan). */
function auth(roles) {
  return async (req, res, next) => {
    try {
      const t = req.cookies && req.cookies.tar_session;
      if (!t) throw authErr();
      let p;
      try { p = jwt.verify(t, CFG.jwtSecret); } catch (e) { throw authErr(); }
      const u = (await pool.query('SELECT * FROM users WHERE username=$1', [p.u])).rows[0];
      if (!u || !u.active || u.token_version !== p.v) throw authErr();
      if (roles && !roles.includes(u.role)) throw new HttpError(403, 'Anda tidak memiliki hak akses untuk tindakan ini.', 'FORBIDDEN');
      req.user = u;
      next();
    } catch (e) { next(e); }
  };
}

app.post('/api/login', wrap(async (req, res) => {
  const username = txt(req.body.username, 100), password = String(req.body.password || '');
  if (!username || !password) throw new HttpError(400, 'Username dan password wajib diisi.');
  const k = req.ip + '|' + username.toLowerCase();
  if (tooMany(k)) throw new HttpError(429, 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.', 'LOCKED');
  const u = (await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username])).rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !u.active || !ok) { addFail(k); throw new HttpError(401, 'Username atau password salah.', 'LOGIN'); }
  fails.delete(k);
  issueSession(res, u);
  res.json({ ok: true, user: publicUser(u) });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('tar_session', { path: '/' }); res.json({ ok: true }); });

app.post('/api/password', auth(), wrap(async (req, res) => {
  const oldPw = String(req.body.oldPassword || ''), newPw = String(req.body.newPassword || '');
  if (newPw.length < 6) throw new HttpError(400, 'Password baru minimal 6 karakter.');
  if (!(await bcrypt.compare(oldPw, req.user.password_hash))) throw new HttpError(400, 'Password lama tidak sesuai.');
  const u = (await pool.query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE username=$2 RETURNING *',
    [await bcrypt.hash(newPw, 10), req.user.username])).rows[0];
  issueSession(res, u);                          // sesi lain otomatis tidak berlaku lagi
  res.json({ ok: true });
}));

/* ---------------------------- DATA REFERENSI ---------------------------- */
app.get('/api/bootstrap', auth(), wrap(async (req, res) => {
  const units = (await pool.query('SELECT * FROM units ORDER BY model_unit, serial_number')).rows.map(u => ({
    ID_Unit: u.id_unit, Model_Unit: u.model_unit, Serial_Number: u.serial_number, Current_HM: Number(u.current_hm || 0),
    Lokasi_Jobsite: u.lokasi_jobsite || '', Status_Operasional: u.status_operasional || ''
  }));
  const catalog = (await pool.query('SELECT * FROM components_catalog ORDER BY subsystem, kode_part')).rows.map(c => ({
    ID_Komponen: c.id_komponen, Subsystem: c.subsystem, Kode_Part: c.kode_part, Nama_Part: c.nama_part
  }));
  res.json({ ok: true, user: publicUser(req.user), units, catalog,
    config: { models: MODELS, subsystems: SUBSYSTEMS, company: CFG.company, logoUrl: CFG.logoUrl } });
}));

/* ------------------------------ LAPORAN TAR ------------------------------ */
app.get('/api/reports', auth(), wrap(async (req, res) => {
  const u = req.user;
  const q = u.role === R.MEK
    ? await pool.query(`${SEL_REPORT} WHERE mekanik_username=$1 ORDER BY tanggal_laporan DESC LIMIT 5000`, [u.username])
    : await pool.query(`${SEL_REPORT} WHERE status_approval <> 'Draft' ORDER BY tanggal_laporan DESC LIMIT 5000`);
  res.json({ ok: true, reports: q.rows.map(toReport) });
}));

app.get('/api/reports/:tar', auth(), wrap(async (req, res) => {
  const r = (await pool.query(`${SEL_REPORT} WHERE tar_number=$1`, [req.params.tar])).rows[0];
  if (!r || !canView(req.user, r)) throw new HttpError(404, 'Laporan tidak ditemukan atau tidak dapat diakses.');
  const logs = (await pool.query(
    `SELECT log_id, tar_number, to_char(ts,'YYYY-MM-DD HH24:MI:SS') AS ts, actor_user, action_taken, catatan
       FROM approval_log WHERE tar_number=$1 ORDER BY ts, log_id`, [r.tar_number])).rows
    .map(l => ({ Log_ID: l.log_id, TAR_Number: l.tar_number, Timestamp: l.ts, Actor_User: l.actor_user, Action_Taken: l.action_taken, Catatan: l.catatan }));
  res.json({ ok: true, report: toReport(r), logs });
}));

/** Simpan Draft / Submit (Mekanik, pada laporan miliknya). Body = payload form + submit:boolean. */
app.post('/api/reports', auth([R.MEK]), wrap(async (req, res) => {
  const u = req.user, p = req.body || {};
  const submit = p.submit === true;
  const keepReq = (Array.isArray(p.keepPhotos) ? p.keepPhotos : []).map(x => String(x).replace(/^\/files\//, ''));
  const fresh = Array.isArray(p.newPhotos) ? p.newPhotos : [];
  const errs = validateReport(p, submit, keepReq.length + fresh.length);
  if (errs.length) throw new HttpError(400, errs.join('\n'));
  if (keepReq.length + fresh.length > CFG.maxPhotos) throw new HttpError(400, `Maksimal ${CFG.maxPhotos} foto per laporan.`);

  const newFiles = [];
  let removed = [], tar, prev = null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let existing = null;
    if (p.tar) {
      existing = (await client.query('SELECT * FROM reports WHERE tar_number=$1 FOR UPDATE', [String(p.tar)])).rows[0];
      if (!existing) throw new HttpError(404, 'Laporan tidak ditemukan.');
      if (existing.mekanik_username !== u.username) throw new HttpError(403, 'Anda hanya dapat mengubah laporan milik Anda.');
      if (![ST.DRAFT, ST.REJECTED].includes(existing.status_approval)) throw new HttpError(409, 'Laporan yang sedang diproses tidak dapat diubah.');
    }
    const have = existing ? existing.photos : [];
    const keep = keepReq.filter(f => have.includes(f));
    removed = have.filter(f => !keep.includes(f));
    for (const ph of fresh) newFiles.push(await savePhoto(ph));
    const photos = keep.concat(newFiles);
    if (submit && photos.length < 1) throw new HttpError(400, 'Foto kerusakan wajib diunggah saat submit.');

    tar = existing ? existing.tar_number : await nextTar(client);
    prev = existing ? existing.status_approval : null;
    const status = submit ? ST.SUBMITTED : (prev || ST.DRAFT);
    const why = Array.isArray(p.why) ? p.why : [];
    const parts = (Array.isArray(p.parts) ? p.parts : []).filter(x => x && (x.pn || x.name))
      .map(x => ({ pn: txt(x.pn, 100), name: txt(x.name, 200), qty: Number(x.qty) || 1 }));
    const cols = {
      model_unit: p.model, serial_number: txt(p.sn, 100), hm_unit: numOrNull(p.hm), lokasi: txt(p.lokasi, 200),
      subsystem: p.subsystem || '', fault_code_gejala: txt(p.fault, 500), kronologi: txt(p.kronologi, 5000),
      why_1: txt(why[0], 1000), why_2: txt(why[1], 1000), why_3: txt(why[2], 1000), why_4: txt(why[3], 1000), why_5: txt(why[4], 1000),
      akar_masalah: txt(p.akar, 3000), bukti_pengukuran: txt(p.bukti, 3000), action_plan: txt(p.action, 5000),
      part_required: JSON.stringify(parts), estimasi_manhour: numOrNull(p.manhour),
      status_approval: status, photos: JSON.stringify(photos)
    };
    const JSONB = ['part_required', 'photos'];
    const keys = Object.keys(cols), vals = keys.map(k => cols[k]);
    const ph = k => `$${keys.indexOf(k) + 1}${JSONB.includes(k) ? '::jsonb' : ''}`;
    if (existing) {
      await client.query(`UPDATE reports SET ${keys.map(k => `${k}=${ph(k)}`).join(', ')}, updated_at=now() WHERE tar_number=$${keys.length + 1}`, [...vals, tar]);
    } else {
      const all = ['tar_number', 'nama_mekanik', 'mekanik_username', ...keys];
      await client.query(`INSERT INTO reports(${all.join(',')}) VALUES($1,$2,$3,${keys.map((k, i) => ph(k).replace(/\$\d+/, '$' + (i + 4))).join(',')})`,
        [tar, u.nama_lengkap, u.username, ...vals]);
      await logAction(client, tar, u, 'Draft Created', 'Draft laporan dibuat.');
    }
    if (submit) {
      const resub = prev === ST.REJECTED;
      await logAction(client, tar, u, resub ? 'Resubmitted' : 'Submitted', resub ? 'Laporan dikirim ulang setelah revisi.' : 'Laporan dikirim untuk verifikasi.');
      if (cols.hm_unit) await client.query('UPDATE units SET current_hm=$1 WHERE serial_number=$2 AND current_hm < $1', [cols.hm_unit, cols.serial_number]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await rmFiles(newFiles);                      // bersihkan foto baru jika transaksi gagal
    throw e;
  } finally { client.release(); }

  await rmFiles(removed);                         // foto lama yang dihapus pengguna
  if (submit) {
    const row = (await pool.query(`${SEL_REPORT} WHERE tar_number=$1`, [tar])).rows[0], rep = toReport(row);
    fireNotify('TAR baru menunggu verifikasi',
      `TAR ${tar} (${rep.Model_Unit} / SN ${rep.Serial_Number}, ${rep.Subsystem}) dikirim oleh ${u.nama_lengkap}. Mohon diperiksa.`,
      [R.PLN, R.SPV], null, buildEvent('tar.submitted', rep, u, '', baseUrlOf(req)));
  }
  res.json({ ok: true, tar, status: submit ? ST.SUBMITTED : (prev || ST.DRAFT) });
}));

/** Hapus draft milik sendiri (beserta fotonya). */
app.delete('/api/reports/:tar', auth([R.MEK]), wrap(async (req, res) => {
  const client = await pool.connect();
  let photos = [];
  try {
    await client.query('BEGIN');
    const r = (await client.query('SELECT * FROM reports WHERE tar_number=$1 FOR UPDATE', [req.params.tar])).rows[0];
    if (!r || r.mekanik_username !== req.user.username) throw new HttpError(404, 'Laporan tidak ditemukan.');
    if (r.status_approval !== ST.DRAFT) throw new HttpError(409, 'Hanya laporan berstatus Draft yang dapat dihapus.');
    photos = r.photos || [];
    await client.query('DELETE FROM reports WHERE tar_number=$1', [r.tar_number]);
    await logAction(client, r.tar_number, req.user, 'Draft Deleted', 'Draft dihapus oleh pembuat.');
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  await rmFiles(photos);
  res.json({ ok: true });
}));

/* ---------------------------- APPROVAL & AUDIT ---------------------------- */
/**
 *  forward  : Planner/Supervisor, Submitted -> Under Review
 *  revision : Planner/Supervisor, Submitted -> Rejected (catatan wajib)
 *  approve  : Lead Engineer/Site Manager, Under Review -> Approved
 *  reject   : Lead Engineer/Site Manager, Under Review -> Rejected (catatan wajib)
 */
const REVIEW_RULES = {
  forward: { who: [R.PLN, R.SPV], from: ST.SUBMITTED, to: ST.REVIEW, log: 'Forwarded to Lead Engineer', need: false, ev: 'tar.forwarded' },
  revision: { who: [R.PLN, R.SPV], from: ST.SUBMITTED, to: ST.REJECTED, log: 'Revision Requested', need: true, ev: 'tar.revision_requested' },
  approve: { who: [R.LEAD, R.SM], from: ST.REVIEW, to: ST.APPROVED, log: 'Approved', need: false, ev: 'tar.approved' },
  reject: { who: [R.LEAD, R.SM], from: ST.REVIEW, to: ST.REJECTED, log: 'Rejected', need: true, ev: 'tar.rejected' }
};

app.post('/api/reports/:tar/review', auth([R.PLN, R.SPV, R.LEAD, R.SM]), wrap(async (req, res) => {
  const u = req.user, action = String(req.body.action || ''), notes = txt(req.body.notes, 3000);
  const rule = REVIEW_RULES[action];
  if (!rule) throw new HttpError(400, 'Aksi tidak dikenal.');
  if (!rule.who.includes(u.role)) throw new HttpError(403, 'Role Anda tidak berwenang melakukan aksi ini.');
  if (rule.need && !notes) throw new HttpError(400, 'Catatan wajib diisi untuk aksi ini.');

  const client = await pool.connect();
  let tar;
  try {
    await client.query('BEGIN');
    const r = (await client.query('SELECT * FROM reports WHERE tar_number=$1 FOR UPDATE', [req.params.tar])).rows[0];
    if (!r || r.status_approval === ST.DRAFT) throw new HttpError(404, 'Laporan tidak ditemukan.');
    if (r.status_approval !== rule.from) throw new HttpError(409, `Status laporan saat ini "${r.status_approval}" — aksi tidak dapat dilakukan (mungkin sudah diproses pihak lain).`);
    tar = r.tar_number;
    const prevNotes = r.supervisor_notes || '';
    const line = `[${stamp()}] ${u.nama_lengkap} (${u.role}): ${notes}`;
    const newNotes = notes ? (prevNotes ? prevNotes + '\n' + line : line) : prevNotes;
    await client.query('UPDATE reports SET status_approval=$1, supervisor_notes=$2, updated_at=now() WHERE tar_number=$3', [rule.to, newNotes, tar]);
    await logAction(client, tar, u, rule.log, notes);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

  const rep = toReport((await pool.query(`${SEL_REPORT} WHERE tar_number=$1`, [tar])).rows[0]);
  const unit = `${rep.Model_Unit} / SN ${rep.Serial_Number}`;
  const ev = buildEvent(rule.ev, rep, u, notes, baseUrlOf(req));
  const mek = (await pool.query('SELECT mekanik_username FROM reports WHERE tar_number=$1', [tar])).rows[0].mekanik_username;
  if (action === 'forward') {
    fireNotify('TAR menunggu Final Approval', `TAR ${tar} (${unit}) telah diverifikasi ${u.nama_lengkap} dan menunggu keputusan Anda.`, [R.LEAD, R.SM], null, ev);
  } else {
    const label = { revision: 'perlu revisi', approve: 'DISETUJUI', reject: 'DITOLAK' }[action];
    fireNotify('Status TAR diperbarui', `TAR ${tar} (${unit}) ${label} oleh ${u.nama_lengkap}${notes ? '. Catatan: ' + notes : '.'}`, [], mek, ev);
  }
  res.json({ ok: true, status: rule.to });
}));

/** Jumlah & daftar item yang menunggu tindakan user (polling notifikasi di klien). */
app.get('/api/pending', auth(), wrap(async (req, res) => {
  const u = req.user;
  let q;
  if (u.role === R.PLN || u.role === R.SPV) q = await pool.query(`SELECT * FROM reports WHERE status_approval='Submitted'`);
  else if (u.role === R.LEAD || u.role === R.SM) q = await pool.query(`SELECT * FROM reports WHERE status_approval='Under Review'`);
  else q = await pool.query(`SELECT * FROM reports WHERE status_approval='Rejected' AND mekanik_username=$1`, [u.username]);
  res.json({ ok: true, count: q.rows.length,
    items: q.rows.map(r => ({ tar: r.tar_number, unit: `${r.model_unit} / ${r.serial_number}`, by: r.nama_mekanik, status: r.status_approval })) });
}));

/* ------------------------------ DASHBOARD KPI ------------------------------ */
app.get('/api/dashboard', auth(), wrap(async (req, res) => {
  const period = ['month', 'year', 'all'].includes(req.query.period) ? req.query.period : 'month';
  const M = `to_char(tanggal_laporan,'YYYY-MM') = to_char(now(),'YYYY-MM')`;
  const scope = period === 'all' ? 'true' : period === 'year' ? `to_char(tanggal_laporan,'YYYY') = to_char(now(),'YYYY')` : M;
  const k = (await pool.query(`
    SELECT count(*) FILTER (WHERE ${M})::int AS total_month,
           COALESCE(sum(estimasi_manhour) FILTER (WHERE ${M}), 0) AS hours,
           count(*) FILTER (WHERE status_approval IN ('Submitted','Under Review'))::int AS pending,
           count(DISTINCT serial_number) FILTER (WHERE ${M})::int AS units,
           count(*) FILTER (WHERE ${M} AND status_approval='Approved')::int AS approved
      FROM reports WHERE status_approval <> 'Draft'`)).rows[0];
  const tally = async (col, keys) => {              // col berasal dari konstanta internal, bukan input user
    const rows = (await pool.query(`SELECT ${col} AS k, count(*)::int AS n FROM reports WHERE status_approval <> 'Draft' AND ${scope} GROUP BY ${col}`)).rows;
    const m = Object.fromEntries(keys.map(x => [x, 0]));
    rows.forEach(r => { if (r.k) m[r.k] = (m[r.k] || 0) + r.n; });
    return { labels: Object.keys(m), values: Object.values(m) };
  };
  const recent = (await pool.query(`${SEL_REPORT} WHERE status_approval <> 'Draft' ORDER BY tanggal_laporan DESC LIMIT 6`)).rows.map(toReport);
  res.json({
    ok: true, period,
    kpi: { totalMonth: k.total_month, hoursBreakdown: Number(k.hours), pending: k.pending, unitsAffected: k.units, approved: k.approved },
    byModel: await tally('model_unit', MODELS), bySubsystem: await tally('subsystem', SUBSYSTEMS), recent
  });
}));

/* -------------------------- FILE FOTO (BUTUH LOGIN) -------------------------- */
app.get('/files/:name', auth(), (req, res) => {
  const n = req.params.name;
  if (!/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(n)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(CFG.uploadDir, n), { dotfiles: 'deny' }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

/* ------------------------------ FRONTEND STATIS ------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.use('/api', (req, res) => res.status(404).json({ ok: false, code: 'NOTFOUND', message: 'Endpoint tidak ditemukan.' }));

/* ------------------------------- ERROR HANDLER ------------------------------- */
app.use((err, req, res, next) => {            // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, code: 'TOO_LARGE', message: 'Ukuran data terlalu besar. Kurangi jumlah/ukuran foto.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ ok: false, code: 'BAD_JSON', message: 'Format data tidak valid.' });
  console.error(err);
  res.status(500).json({ ok: false, code: 'ERR', message: 'Terjadi kesalahan pada server.' });
});

/* ---------------------------------- START ---------------------------------- */
migrate().then(() => {
  const server = app.listen(CFG.port, '0.0.0.0', () => console.log(`TAR System berjalan di port ${CFG.port} (zona waktu ${CFG.tz})`));
  const stop = () => { console.log('Menghentikan server...'); server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}).catch(e => { console.error('FATAL saat start:', e); process.exit(1); });
