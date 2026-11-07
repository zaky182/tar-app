#!/usr/bin/env node
/**
 * Manajemen user lewat terminal (jalankan di Console service App di EasyPanel).
 *
 *   node scripts/user.js list
 *   node scripts/user.js add <username> <password> "<Nama Lengkap>" "<Role>" [email] [nomor_wa]
 *   node scripts/user.js passwd <username> <password_baru>
 *   node scripts/user.js wa <username> <nomor_wa>       (format 628xxxxxxxxxx)
 *   node scripts/user.js role <username> "<Role>"
 *   node scripts/user.js disable <username>
 *   node scripts/user.js enable <username>
 *   node scripts/user.js remove <username>
 *
 * Role: Mekanik | Planner | Supervisor | Lead Engineer | Site Manager
 */
'use strict';
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const ROLES = ['Mekanik', 'Planner', 'Supervisor', 'Lead Engineer', 'Site Manager'];
const [, , cmd, ...a] = process.argv;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL belum diatur.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const die = m => { console.error('Error: ' + m); process.exit(1); };
const needRole = r => { if (!ROLES.includes(r)) die('Role harus salah satu dari: ' + ROLES.join(', ')); };

(async () => {
  switch (cmd) {
    case 'list': {
      const { rows } = await pool.query('SELECT username, nama_lengkap, role, email, wa_number, active FROM users ORDER BY role, username');
      console.table(rows);
      break;
    }
    case 'add': {
      const [u, p, nama, role, email, wa] = a;
      if (!u || !p || !nama || !role) die('Pemakaian: add <username> <password> "<Nama>" "<Role>" [email] [wa]');
      needRole(role);
      if (p.length < 6) die('Password minimal 6 karakter.');
      await pool.query('INSERT INTO users(username,password_hash,nama_lengkap,role,email,wa_number) VALUES($1,$2,$3,$4,$5,$6)',
        [u, await bcrypt.hash(p, 10), nama, role, email || null, wa || null]);
      console.log(`User "${u}" (${role}) dibuat.`);
      break;
    }
    case 'passwd': {
      const [u, p] = a;
      if (!u || !p) die('Pemakaian: passwd <username> <password_baru>');
      if (p.length < 6) die('Password minimal 6 karakter.');
      const r = await pool.query('UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE username=$2',
        [await bcrypt.hash(p, 10), u]);
      if (!r.rowCount) die('User tidak ditemukan.');
      console.log(`Password "${u}" diganti (semua sesi lama otomatis keluar).`);
      break;
    }
    case 'wa': {
      const [u, wa] = a;
      if (!u || !wa) die('Pemakaian: wa <username> <nomor_wa>');
      const r = await pool.query('UPDATE users SET wa_number=$1 WHERE username=$2', [wa.replace(/\D/g, ''), u]);
      if (!r.rowCount) die('User tidak ditemukan.');
      console.log('Nomor WA diperbarui.');
      break;
    }
    case 'role': {
      const [u, role] = a;
      if (!u || !role) die('Pemakaian: role <username> "<Role>"');
      needRole(role);
      const r = await pool.query('UPDATE users SET role=$1, token_version=token_version+1 WHERE username=$2', [role, u]);
      if (!r.rowCount) die('User tidak ditemukan.');
      console.log('Role diperbarui.');
      break;
    }
    case 'disable':
    case 'enable': {
      const [u] = a;
      if (!u) die(`Pemakaian: ${cmd} <username>`);
      const r = await pool.query('UPDATE users SET active=$1, token_version=token_version+1 WHERE username=$2', [cmd === 'enable', u]);
      if (!r.rowCount) die('User tidak ditemukan.');
      console.log(`User "${u}" ${cmd === 'enable' ? 'diaktifkan' : 'dinonaktifkan'}.`);
      break;
    }
    case 'remove': {
      const [u] = a;
      if (!u) die('Pemakaian: remove <username>');
      const r = await pool.query('DELETE FROM users WHERE username=$1', [u]);
      if (!r.rowCount) die('User tidak ditemukan.');
      console.log(`User "${u}" dihapus. (Laporan lama tetap tersimpan dengan nama mekanik aslinya.)`);
      break;
    }
    default:
      console.log('Perintah: list | add | passwd | wa | role | disable | enable | remove\n' +
        'Contoh  : node scripts/user.js add budi Rahasia123 "Budi Santoso" Mekanik budi@mail.com 628123456789\n' +
        'Lengkap : lihat komentar di bagian atas file scripts/user.js');
  }
})().catch(e => die(e.message)).finally(() => pool.end());
