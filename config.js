// config.js — Web2Apk V2 Gen 1 Configuration

const config = {

  // ─── Telegram ────────────────────────────────────────────────────────────
  telegram: {
    botToken: '',
    // API credentials untuk Local Bot API Server (dari https://my.telegram.org)
    // Setiap VPS Worker akan punya Local Bot API sendiri di port 8081
    apiId: '',
    apiHash: '',
    // Aktifkan auto-discovery Local Bot API dari data VPS worker (multi VPS).
    useLocalApi: true,
    // ID admin yang berhak menjalankan perintah management
    adminIds: [6772882691],
    ownerLink: 'https://t.me/UyaGantengg',
    informationLink: 'https://t.me/uyachannel',
  },

  // ─── Payment ─────────────────────────────────────────────────────────────
  payment: {
    // ID channel untuk nota transaksi (receipt)
    paymentChannelId: '-1003574203465',
  },

  // ─── Wajib Join Channel / Grup ───────────────────────────────────────────
  // User harus join SEMUA channel/grup di sini sebelum bisa menggunakan bot
  requiredJoins: [
    '@uyachannel',
    '',
    ''
  ],

  // ─── Akses & Membership ──────────────────────────────────────────────────
  access: {
    // URL to APK = GRATIS (semua user bisa)
    urlToApkFree: true,
    // ZIP to APK = BERBAYAR (hanya member aktif)
    zipToApkMembersOnly: true,
    // Pesan yang ditampilkan ke non-member saat coba akses ZIP to APK
    nonMemberMessage: '🔒 Fitur ini memerlukan akses.\nHubungi admin untuk mendapatkan akses.',
  },

  // ─── Worker Pool Settings (default untuk semua worker) ──────────────────
  // Identitas & data tiap worker disimpan di database/workers/*.json
  // Di sini hanya setting global yang berlaku untuk semua worker
  workers: {
    // Timeout SSH ke VPS sebelum dianggap gagal koneksi (detik)
    sshTimeoutSeconds: 15,
    // Timeout trigger GitHub Actions sebelum dianggap gagal (detik)
    githubTriggerTimeoutSeconds: 30,
    // Direktori build default di setiap VPS (bisa di-override per worker di JSON)
    defaultBuildDir: '/opt/web2apk/builds',
    // Direktori cache default di setiap VPS
    defaultCacheDir: '/opt/web2apk/cache',
    // Cooldown duration after build completes (ms) - worker enters cooldown before accepting new jobs
    cooldownMs: 30000,
    // Maximum build duration before timeout (ms) - 55 minutes default.
    // Increased from 30 minutes: the auto-fix retry chain in
    // worker/pipeline/flutter.js can run the build up to 3-4 times in a row
    // (pin package / pub upgrade / pub upgrade --major-versions / loosen
    // constraints), and each attempt can itself take several minutes, so a
    // tight timeout was killing the process mid-retry before the fix had a
    // chance to land — making the auto-fix logic look like it "didn't work"
    // when it was actually just cut off before finishing.
    buildTimeoutMs: 55 * 60 * 1000,
    // ⭐ Maksimal slot concurrent build (berapa orang bisa build bersamaan)
    // Saat ini: 3 orang bisa build bersamaan, sisanya antri
    maxConcurrentBuilds: 3,
  },

  // ─── Global Queue (jika semua worker penuh) ───────────────────────────────
  queue: {
    // Maks total job yang boleh antri di global queue
    maxQueueSize: 50,
    // Notifikasi posisi antrian ke user setiap N menit
    notifyIntervalMinutes: 5,
  },

  // ─── Build Settings ───────────────────────────────────────────────────────
  build: {
    outputDir: '/tmp/web2apk/builds',
    maxFileSizeMb: 2048,
    timeoutMinutes: 30,
    allowHttp: true,
    // Retry hanya untuk error yang BISA di-fix (bukan restart dari awal)
    maxRetries: 2,
    // ID channel/grup Telegram untuk notifikasi otomatis setiap build selesai
    // (SUKSES maupun GAGAL). Kosongkan ('') untuk menonaktifkan fitur ini.
    // Contoh: '-1001234567890'. Bot harus sudah jadi admin di channel tsb.
    notifyChannelId: '',
    // Cache dependency untuk memangkas waktu build berulang
    cache: {
      enabled: true,
      dir: '/opt/web2apk/cache',
      maxAgeDays: 7,
      maxSizeGb: 10,
    },
  },

  // ─── Worker Health Monitor ────────────────────────────────────────────────
  // Bot ping tiap worker secara berkala, tandai offline jika tidak merespons
  healthMonitor: {
    enabled: true,
    intervalSeconds: 30,
    timeoutSeconds: 10,
    // Kirim alert ke admin jika ada worker offline
    alertAdminOnOffline: true,
  },

  // ─── URL to APK Settings ──────────────────────────────────────────────────
  urlToApk: {
    allowedProtocols: ['http', 'https'],
    allowCustomIcon: true,
    allowedIconFormats: ['image/png', 'image/jpeg', 'image/webp'],
    minIconSize: 512,
  },

  // ─── Warna Resmi Telegram (Brand + semantic UI colors) ───────────────────
  // Sumber: brand palette resmi Telegram (Lochmara/Telegram Blue gradient
  // #2AABEE → #229ED9, legacy blue #0088CC, putih #FFFFFF) + warna semantik
  // yang dipakai Telegram sendiri di client-nya untuk aksi (biru=primary,
  // hijau=success/online, merah=danger/destructive).
  // Dipakai untuk styling tombol bot (style: primary/success/danger, sudah
  // ada di bot/menus/mainMenu.js) DAN untuk tombol di web/dashboard.html.
  telegramColors: {
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
  },

  // ─── Database (folder & file JSON) ───────────────────────────────────────
  // Tidak ada .env / .env.example — semua konfigurasi di file ini
  database: {
    dir: './database',
    usersFile: './database/users.json',
    membersFile: './database/members.json',
    queueFile: './database/queue.json',
    workersFile: './database/workers.json',
    resellersFile: './database/resellers.json',
    approvalsFile: './database/approvals.json',
    buildsFile: './database/builds.json',
    paymentsFile: './database/payments.json',
    pricesFile: './database/prices.json',
    ordersFile: './database/orders.json',
    reportsFile: './database/reports.json',
  },

};

module.exports = config;

