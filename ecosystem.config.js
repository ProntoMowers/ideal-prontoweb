// C:\scripts\ideal-prontoweb\ecosystem.config.js

module.exports = {
  apps: [
    // 22:00 - PRODUCT
    {
      name: 'ideal-migrate-product',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateProductIdeal.js',
      watch: false,
      autorestart: false,
      cron_restart: '0 22 * * *', // 22:00 todos los días
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // 22:15 - PRODUCTLOCATION
    {
      name: 'ideal-migrate-productlocation',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateProductLocation.js',
      watch: false,
      autorestart: false,
      cron_restart: '15 22 * * *', // 22:15
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // 22:30 - SALESINVOICES (AR + detalle)
    {
      name: 'ideal-migrate-salesinvoices',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateSalesInvoices.js',
      watch: false,
      autorestart: false,
      cron_restart: '30 22 * * *', // 22:30
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // 22:45 - PORECEIPTS
    {
      name: 'ideal-migrate-poreceipts',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migratePOReceipts.js',
      watch: false,
      autorestart: false,
      cron_restart: '45 22 * * *', // 22:45
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // 23:00 - ICTRANS
    {
      name: 'ideal-migrate-ictrans',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateICTrans.js',
      watch: false,
      autorestart: false,
      cron_restart: '0 23 * * *', // 23:00
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },

    // 23:15 - SALESORDERS
    {
      name: 'ideal-migrate-salesorders',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateSalesOrders.js',
      watch: false,
      autorestart: false,
      cron_restart: '15 23 * * *', // 23:15
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'ideal-migrate-customers',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateCustomers.js',
      watch: false,
      autorestart: false,
      cron_restart: '30 23 * * *', // por ejemplo 23:30
      time: true,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'ideal-migrate-workorders',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateWorkOrders.js',
      watch: false,
      autorestart: false,
      cron_restart: '45 23 * * *', // Runs at 23:45 every day
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'ideal-migrate-productstock',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateProductStock.js',
      watch: false,
      autorestart: false,
      cron_restart: '0 0 * * *',
      time: true,
      env: { NODE_ENV: 'production' },
    },
	{
      name: 'ideal-migrateAccountantTrans',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateAccountantTrans.js',
      watch: false,
      autorestart: false,
      cron_restart: '15 0 * * *',
      time: true,
      env: { NODE_ENV: 'production' },
    },
	// 00:45 - AP TRANSACTIONS
	{
	  name: 'ideal-migrate-aptrans',
	  cwd: 'C:/scripts/ideal-prontoweb',
	  script: 'src/migrateAPTrans.js',
	  autorestart: false,
	  cron_restart: '30 0 * * *', // 00:30 AM
	  env: { NODE_ENV: 'production' }
	},
	// 00:45 - AR TRANSACTIONS
    {
      name: 'ideal-migrate-artrans',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/migrateARTrans.js',
      watch: false,
      autorestart: false,
      cron_restart: '45 0 * * *',
      time: true,
      env: { NODE_ENV: 'production' },
    },
	// 00:30 - CANCELLATIONS
	{
	  name: 'Cancellations-report',
	  cwd: 'C:/scripts/ideal-prontoweb',
	  script: 'src/reportCancellationSummary.js',
	  watch: false,
	  autorestart: false,
	  cron_restart: '45 0 * * *',
	  time: true,
	  env: { NODE_ENV: 'production' },
	},
    // --- NUEVA API MULTIPROPÓSITO ---
    {
      name: 'prontoweb-api',
      cwd: 'C:/scripts/ideal-prontoweb',
      script: 'src/submitReturn.js', // Tu script principal de la API
      watch: false,                 // Habilitado para que reinicie si editas el código
      autorestart: true,           // Siempre activo
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3001                 // Puerto interno para el Reverse Proxy del IIS
      },
    },
  ],
};