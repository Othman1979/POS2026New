module.exports = {
  apps: [
    {
      name: 'pos-app',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env_production: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'db-backup',
      script: 'scripts/db-backup.js',
      cron_restart: '0 3 * * *',
      autorestart: false,
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
