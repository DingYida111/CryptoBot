/**
 * PM2 Process Manager Configuration for CryptoBot
 *
 * Usage:
 *   pm2 start ecosystem.config.js          # start collector
 *   pm2 stop cryptobot-collector
 *   pm2 restart cryptobot-collector
 *   pm2 logs cryptobot-collector
 *   pm2 save && pm2 startup               # persist on reboot
 */

module.exports = {
  apps: [
    {
      name: "cryptobot-collector",
      script: "node_modules/.bin/tsx",
      args: "src/monitor/run.ts",
      cwd: __dirname,

      // Restart policy
      watch: false,
      autorestart: true,
      restart_delay: 5000,        // wait 5s before restarting on crash
      max_restarts: 20,           // stop retrying after 20 crashes
      min_uptime: "10s",          // consider stable if alive > 10s

      // Environment
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },

      // Logging
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",
      retain: 10,                 // keep 10 rotated log files

      // Resource limits
      max_memory_restart: "512M",

      // Graceful shutdown
      kill_timeout: 5000,         // wait 5s for SIGINT handler before SIGKILL
      listen_timeout: 10000,
    },
    {
      name: "cryptobot-strat",
      script: "dist/trade/strategy_runner.js",
      cwd: __dirname,

      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",

      // Secrets are loaded from .env by dotenv at runtime, not injected by PM2.
      env: {
        NODE_ENV: "production",
      },
      env_development: {
        NODE_ENV: "development",
      },

      out_file: "logs/strategy-pm2-out.log",
      error_file: "logs/strategy-pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",
      retain: 10,

      max_memory_restart: "512M",
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
