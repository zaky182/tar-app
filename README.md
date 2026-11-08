# TAR System — Mubarak Project

Technical Analysis Report (TAR) perawatan alat berat. Node.js (Express) + PostgreSQL, siap deploy di **EasyPanel**.

```
tar-app/
├─ server.js              backend (REST API, auth, workflow approval, webhook)
├─ public/index.html      frontend (dashboard, form TAR, riwayat, approval, cetak A4)
├─ scripts/user.js        CLI kelola user (tambah, ganti password, nomor WA, dll.)
├─ scripts/import-csv.js  CLI impor data unit & katalog komponen dari CSV
├─ Dockerfile, docker-entrypoint.sh, package.json
├─ .env.example           daftar environment variable
└─ docker-compose.yml     hanya untuk uji lokal
```

Tabel database dibuat **otomatis** saat aplikasi pertama kali jalan: `users`, `units`, `components_catalog`, `reports`, `approval_log` (+ `tar_counter` untuk penomoran).

---

## 1. Kebutuhan

- Server dengan EasyPanel (2 vCPU / 4 GB RAM sudah lebih dari cukup)
- Sebuah domain/subdomain, misalnya `tar.domainanda.com`, dengan record **A** yang mengarah ke IP server
- Salah satu: repository Git (GitHub/GitLab, boleh private) **atau** akun registry Docker (Docker Hub/GHCR)

## 2. Siapkan kode

**Opsi A — Git (paling mudah untuk update berikutnya)**

```bash
cd tar-app
git init && git add . && git commit -m "TAR System"
git remote add origin git@github.com:AKUN/tar-app.git
git push -u origin main
```

**Opsi B — Docker image**

```bash
docker build -t USERNAME/tar-system:1.0 .
docker push USERNAME/tar-system:1.0
```

## 3. Buat project & database di EasyPanel

1. Dashboard EasyPanel → **Create Project** (misalnya `tar`).
2. Di dalam project: **+ Service → Postgres**.
   - Nama service: `tar-db`
   - Password: buat yang kuat (catat)
   - Setelah dibuat, buka service tersebut dan salin **Internal Connection URL** (atau susun manual).
     Bentuknya: `postgres://postgres:PASSWORD@tar_tar-db:5432/tar`
     (host internal = `NAMAPROJECT_NAMASERVICE`).

## 4. Buat service App

1. Di project yang sama: **+ Service → App**, nama `tar-web`.
2. Tab **Source**
   - Opsi A: pilih **Git**, isi URL repo + branch `main` (untuk repo private, tambahkan deploy key yang ditampilkan EasyPanel ke repo Anda).
   - Opsi B: pilih **Docker Image**, isi `USERNAME/tar-system:1.0`.
3. Tab **Build** (hanya Opsi A): pilih **Dockerfile** (path `Dockerfile`).
4. Tab **Environment** — tempel dan sesuaikan (lihat `.env.example`):

   ```env
   DATABASE_URL=postgres://postgres:PASSWORD@tar_tar-db:5432/tar
   JWT_SECRET=<hasil: openssl rand -hex 32>
   NODE_ENV=production
   APP_TZ=Asia/Makassar
   COMPANY_NAME=PT Riung Mitra Lestari
   APP_URL=https://tar.domainanda.com
   SEED_DEMO=true
   ```

   Pastikan nama host di `DATABASE_URL` sama persis dengan host internal service Postgres Anda.
5. Tab **Mounts** → **+ Volume**
   - Name: `tar-uploads`
   - Mount Path: `/data/uploads`

   Tanpa volume ini, **foto akan hilang setiap kali container di-deploy ulang.**
6. Tab **Domains & Proxy** → tambah domain `tar.domainanda.com`, **Port 3000**, HTTPS aktif (Let's Encrypt otomatis).
7. Klik **Deploy**. Pantau log: harus muncul `TAR System berjalan di port 3000`.

## 5. Uji

- Buka `https://tar.domainanda.com/healthz` → harus tampil `{"ok":true}`.
- Buka `https://tar.domainanda.com`, login dengan akun demo:

| Username | Password | Role |
|---|---|---|
| mekanik1 | Mekanik@123 | Mekanik |
| mekanik2 | Mekanik@123 | Mekanik |
| planner1 | Planner@123 | Planner |
| supervisor1 | Supervisor@123 | Supervisor |
| lead1 | Lead@123 | Lead Engineer |
| manager1 | Manager@123 | Site Manager |

- Alur uji: `mekanik1` buat TAR + foto → Submit → `planner1` Teruskan → `lead1` Approve → Riwayat → **Cetak** (A4 + tanda tangan virtual).

## 6. Langkah keamanan WAJIB sebelum dipakai tim

Buka service `tar-web` → **Console** (terminal), lalu:

```bash
# ganti password semua akun demo
node scripts/user.js passwd mekanik1 PasswordBaruYangKuat
node scripts/user.js passwd planner1 PasswordBaruYangKuat
# ... dst, atau hapus akun demo dan buat akun asli:
node scripts/user.js remove mekanik2
node scripts/user.js add andi Rahasia123 "Andi Pratama" Mekanik andi@perusahaan.com 6281234567890
node scripts/user.js list
```

Perintah lain: `wa` (nomor WhatsApp), `role`, `disable`, `enable`. Setelah akun asli siap dan data master terisi, ubah `SEED_DEMO=false`.
(Dengan `SEED_DEMO=true`, data contoh hanya dimasukkan jika tabelnya **kosong**, jadi tidak menimpa data asli.)

## 7. Data master (unit & katalog komponen)

Siapkan CSV (bisa langsung hasil *File → Download → CSV* dari Google Sheets lama):

- `units.csv`: `ID_Unit, Model_Unit, Serial_Number, Current_HM, Lokasi_Jobsite, Status_Operasional`
- `components.csv`: `ID_Komponen, Subsystem, Kode_Part, Nama_Part`

Unggah file ke server (mis. lewat Console EasyPanel / `scp`), lalu:

```bash
node scripts/import-csv.js units units.csv
node scripts/import-csv.js components components.csv
```

Menjalankan ulang aman: baris yang ID-nya sudah ada diperbarui, yang baru ditambahkan.
Nilai `Model_Unit` sebaiknya salah satu dari: Volvo FMX400, Komatsu PC500, Komatsu PC200, Komatsu D85ESS (daftar model ada di `server.js`, konstanta `MODELS`).

## 8. Sambungkan ke n8n + WAHA (notifikasi WhatsApp)

Backend mengirim POST JSON ke `WEBHOOK_URL` setiap ada kejadian:

| `event` | Terjadi saat | Penerima yang cocok |
|---|---|---|
| `tar.submitted` | mekanik submit / resubmit | Planner & Supervisor |
| `tar.forwarded` | diteruskan ke Under Review | Lead Engineer & Site Manager |
| `tar.revision_requested` | diminta revisi | Mekanik pembuat |
| `tar.approved` / `tar.rejected` | keputusan akhir | Mekanik pembuat |

Format payload sama dengan versi Apps Script (`event`, `tar{...}`, `actor`, `notes`, `app_url`, `recipients[]`). Tambahannya, setiap penerima di `recipients` kini punya field **`wa`** (nomor dari `node scripts/user.js wa ...`), jadi di n8n cukup *Loop* ke `recipients` lalu kirim lewat WAHA ke `{{ $json.wa }}@c.us`.

Di service App tambahkan environment:

```env
WEBHOOK_URL=http://n8n_n8n:5678/webhook/tar
WEBHOOK_SECRET=samakan-dengan-Header-Auth-di-n8n
```

- `n8n_n8n` = `NAMAPROJECT_NAMASERVICE` n8n Anda (jaringan internal EasyPanel, lebih cepat & tidak lewat internet). Jika tidak tersambung, pakai URL publik n8n (`https://.../webhook/tar`).
- Pakai **Production URL** node Webhook dan workflow harus **Active**.
- Di n8n: Webhook → Authentication **Header Auth** dengan header `X-Webhook-Secret`.
- Di node WAHA, isi pesan dengan ekspresi seperti `{{ $json.body.tar.number }}`, `{{ $json.body.tar.model }}`, `{{ $json.body.app_url }}`.

Telegram (opsional): isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID`.

## 9. Logo perusahaan

Taruh `logo.png` di folder `public/`, tambahkan environment `LOGO_URL=/logo.png`, deploy ulang. Logo muncul di sidebar, halaman login, dan hasil cetak A4. Tanpa logo, dipakai badge "RML".

## 10. Backup (penting)

Ada dua hal yang harus dibackup:

1. **Database** — di EasyPanel buka service Postgres → fitur **Backups** (jika tersedia di versi Anda) atau jadwalkan `pg_dump`:
   ```bash
   docker exec $(docker ps -qf name=tar_tar-db) pg_dump -U postgres tar | gzip > /backup/tar-$(date +%F).sql.gz
   ```
   Jalankan lewat cron harian di server, lalu salin ke luar server.
2. **Foto** — volume `tar-uploads` (path `/data/uploads`). Backup volume ini secara berkala (mis. `rsync`/snapshot VPS).

## 11. Update aplikasi

- **Git:** `git push` → di EasyPanel klik **Deploy** (atau aktifkan auto-deploy/webhook).
- **Image:** build & push versi baru, ubah tag di Source, **Deploy**.

Data (database + foto) tidak terpengaruh. Skema dibuat dengan `CREATE TABLE IF NOT EXISTS`, jadi deploy ulang aman.

## 12. Hak akses

| Role | Dapat melakukan |
|---|---|
| Mekanik | Buat/ubah draft & laporan yang direvisi, upload foto, submit; hanya melihat laporan miliknya |
| Planner / Supervisor | Melihat laporan non-draft; Teruskan ke Lead Engineer atau Minta Revisi (laporan Submitted) |
| Lead Engineer / Site Manager | Approve atau Reject (laporan Under Review) |

Semua dicek di server. Setiap perubahan status masuk ke `approval_log` dan tampil sebagai audit trail di detail laporan.

## 13. Pemecahan masalah

| Gejala | Penyebab / solusi |
|---|---|
| Container restart terus, log "JWT_SECRET wajib…" | Isi `JWT_SECRET` minimal 32 karakter |
| Log "Menunggu database…" lalu gagal | `DATABASE_URL` salah (host/password); host internal = `NAMAPROJECT_NAMASERVICE` |
| Login berhasil lalu langsung keluar | Akses lewat HTTP biasa. Pakai HTTPS (domain EasyPanel) atau set `COOKIE_SECURE=false` hanya untuk uji lokal |
| Foto hilang setelah deploy | Volume `/data/uploads` belum di-mount |
| Gagal upload foto "terlalu besar" | Kurangi jumlah foto per laporan (sudah dikompres otomatis ke ≤1600 px) |
| Webhook tidak masuk di n8n | Cek log App (`Webhook HTTP ...` / `Webhook gagal`), pastikan Production URL + workflow Active; coba URL publik n8n |
| Lupa password | `node scripts/user.js passwd <username> <password_baru>` |
| Akun terkunci (5× salah) | Otomatis terbuka setelah 15 menit, atau restart service App |

## 14. Uji lokal (opsional)

```bash
docker compose up --build
# buka http://localhost:3000
```
