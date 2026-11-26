/**
 * telegramColors.js
 * ─────────────────────────────────────────────────────────────────────────
 * Warna resmi Telegram (brand) + warna semantik yang dipakai Telegram di
 * client-nya sendiri untuk fungsi tombol/aksi.
 *
 * REFERENSI (brand):
 *  - Telegram Blue gradient : #2AABEE (terang) → #229ED9 (gelap)
 *  - Telegram legacy blue   : #0088CC
 *  - Putih                  : #FFFFFF
 *
 * Total warna "resmi" brand Telegram ada 4: 2 shade biru gradient logo,
 * 1 biru legacy/klasik, dan putih. Di luar itu, Telegram App sendiri
 * memakai warna semantik (bukan brand, tapi konsisten dipakai di seluruh
 * UI resminya) untuk aksi:
 *  - Biru  -> aksi utama / netral / link / navigasi   (PRIMARY)
 *  - Hijau -> aksi positif / konfirmasi / online       (SUCCESS)
 *  - Merah -> aksi destruktif / peringatan / batal     (DANGER)
 *  - Abu2  -> aksi sekunder / kembali                  (SECONDARY)
 *
 * Aturan pemakaian di project ini (dipertahankan konsisten):
 *  - PRIMARY  : tombol aksi utama (Build APK, Dev, Information, navigasi)
 *  - SUCCESS  : tombol konfirmasi/positif (Status Build, Ya, Approve, Selesai)
 *  - DANGER   : tombol destruktif/peringatan (Batal, Hapus, Tolak, Delete)
 *  - SECONDARY: tombol netral sekunder (Kembali, Skip)
 */

const config = require('../../config');

const FALLBACK = {
  brand: {
    blueLight: '#2AABEE',
    blueDark: '#229ED9',
    blueLegacy: '#0088CC',
    white: '#FFFFFF',
  },
  button: {
    primary: '#2AABEE',
    success: '#31B545',
    danger: '#E53935',
    secondary: '#8B98A5',
  },
};

const palette = (config && config.telegramColors) || FALLBACK;

/** Mengambil hex warna berdasarkan fungsi tombol (primary/success/danger/secondary) */
function colorFor(role) {
  const map = palette.button || FALLBACK.button;
  return map[role] || map.primary || FALLBACK.button.primary;
}

/** Menentukan role warna secara otomatis dari teks tombol (dipakai fallback) */
function inferRole(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(batal|hapus|delete|del|tolak|stop|cancel|reject|reset)\b/.test(t)) return 'danger';
  if (/\b(kembali|back|skip|lewati)\b/.test(t)) return 'secondary';
  if (/\b(ya|yes|setuju|approve|selesai|done|konfirmasi|confirm|success|aktif)\b/.test(t)) return 'success';
  return 'primary';
}

module.exports = {
  palette,
  colorFor,
  inferRole,
  BRAND: palette.brand || FALLBACK.brand,
  BUTTON: palette.button || FALLBACK.button,
};
