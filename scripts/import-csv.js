#!/usr/bin/env node
/**
 * Impor / perbarui data master dari file CSV (misalnya hasil File > Download > CSV
 * dari Google Sheets lama). Baris yang sudah ada diperbarui, yang baru ditambahkan.
 *
 *   node scripts/import-csv.js units      units.csv
 *   node scripts/import-csv.js components components.csv
 *
 * Header CSV (persis nama kolom di Google Sheets):
 *   units      : ID_Unit, Model_Unit, Serial_Number, Current_HM, Lokasi_Jobsite, Status_Operasional
 *   components : ID_Komponen, Subsystem, Kode_Part, Nama_Part
 */
'use strict';
const fs = require('fs');
const { Pool } = require('pg');

const [, , kind, file] = process.argv;
const die = m => { console.error('Error: ' + m); process.exit(1); };
if (!['units', 'components'].includes(kind) || !file) die('Pemakaian: node scripts/import-csv.js <units|components> <file.csv>');
if (!process.env.DATABASE_URL) die('DATABASE_URL belum diatur.');
if (!fs.existsSync(file)) die('File tidak ditemukan: ' + file);

/** Parser CSV sederhana (mendukung tanda kutip, koma & baris baru di dalam kutip, BOM). */
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const head = rows.shift().map(h => h.trim());
  const col = n => { const i = head.indexOf(n); if (i < 0) die('Kolom "' + n + '" tidak ada di header CSV.'); return i; };
  let n = 0;
  if (kind === 'units') {
    const ix = ['ID_Unit', 'Model_Unit', 'Serial_Number', 'Current_HM', 'Lokasi_Jobsite', 'Status_Operasional'].map(col);
    for (const r of rows) {
      const v = ix.map(i => (r[i] || '').trim());
      if (!v[0] || !v[1] || !v[2]) { console.warn('Baris dilewati (ID/Model/SN kosong):', r.join(',')); continue; }
      await pool.query(`INSERT INTO units(id_unit,model_unit,serial_number,current_hm,lokasi_jobsite,status_operasional)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id_unit) DO UPDATE SET model_unit=$2, serial_number=$3, current_hm=$4, lokasi_jobsite=$5, status_operasional=$6`,
        [v[0], v[1], v[2], Number(v[3]) || 0, v[4], v[5] || 'Operasional']);
      n++;
    }
  } else {
    const ix = ['ID_Komponen', 'Subsystem', 'Kode_Part', 'Nama_Part'].map(col);
    for (const r of rows) {
      const v = ix.map(i => (r[i] || '').trim());
      if (v.some(x => !x)) { console.warn('Baris dilewati (ada kolom kosong):', r.join(',')); continue; }
      await pool.query(`INSERT INTO components_catalog(id_komponen,subsystem,kode_part,nama_part)
        VALUES($1,$2,$3,$4) ON CONFLICT (id_komponen) DO UPDATE SET subsystem=$2, kode_part=$3, nama_part=$4`, v);
      n++;
    }
  }
  console.log(`Selesai: ${n} baris ${kind} diimpor/diperbarui.`);
  await pool.end();
})().catch(e => die(e.message));
