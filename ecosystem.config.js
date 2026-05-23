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
    {
      name: "cryptobot-supervisor",
      script: "dist/runtime/run_strategy_supervisor.js",
      cwd: __dirname,

      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",

      // Secrets are loaded from .env by dotenv at runtime, not injected by PM2.
      env: {
        NODE_ENV: "production",
        STRATEGY_SUPERVISOR_ENABLED: "true",
        STRATEGY_SUPERVISOR_WATCH: "true",
        STRATEGY_SUPERVISOR_INTERVAL_MS: "15000",
        STRATEGY_SUPERVISOR_AUTO_START: "false",
        STRATEGY_SUPERVISOR_ALLOW_BENCHMARK_FALLBACK: "false",
        MANAGED_STRATEGY_INSTANCES_JSON: JSON.stringify([
          {
            instanceId: "okx_contract_grid_benchmark",
            type: "okx_contract_grid",
            instrument: "BTC-USDT-SWAP",
            enabled: true,
            autoStart: false,
            syncIntervalMs: 60000,
            parameters: {
              algoId: "",
              direction: "neutral",
              margin: 200,
              leverage: 2,
              gridNum: 7,
              runType: 1,
              minPriceRatio: 0.97,
              maxPriceRatio: 1.03,
            },
            metadata: {
              source: "benchmark_static",
            },
          },
          {
            instanceId: "funding_arb_btc_demo",
            type: "local_funding_arbitrage",
            instrument: "BTC funding package",
            enabled: true,
            autoStart: true,
            syncIntervalMs: 15000,
            parameters: {
              spotInstId: "BTC-USDT",
              perpInstId: "BTC-USDT-SWAP",
              entryLeadMs: 120000,
              maxPackageSizeBtc: 0.01,
              minUsefulPackageSizeBtc: 0.01,
              spotFeeRate: 0.001,
              perpFeeRate: 0.0005,
              spotSlippageBps: 5,
              perpSlippageBps: 5,
              basisRiskBufferBps: 8,
              safetyBufferUsd: 1,
              paperExecute: true,
              forceValidationEntry: false,
              maxHoldMs: 300000,
              maxNetDeltaToleranceBtc: 0.002,
            },
            metadata: {
              source: "pm2_supervisor",
            },
          },
        ]),
      },
      env_development: {
        NODE_ENV: "development",
      },

      out_file: "logs/supervisor-pm2-out.log",
      error_file: "logs/supervisor-pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",
      retain: 10,

      max_memory_restart: "512M",
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "cryptobot-agent-heartbeat-proxy",
      script: "dist/runtime/run_pm2_heartbeat_proxy.js",
      cwd: __dirname,

      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",

      env: {
        NODE_ENV: "production",
        RUNTIME_HEARTBEAT_PM2_NAME: "cryptobot-supervisor",
        RUNTIME_AGENT_ID: "cryptobot-supervisor",
        RUNTIME_AGENT_ROLE: "strategy_supervisor",
        RUNTIME_HEARTBEAT_INTERVAL_MS: "10000",
        RUNTIME_AGENT_MANAGED_INSTRUMENTS: "BTC funding package,BTC-USDT,BTC-USDT-SWAP",
      },
      env_development: {
        NODE_ENV: "development",
      },

      out_file: "logs/heartbeat-proxy.out.log",
      error_file: "logs/heartbeat-proxy.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",
      retain: 10,

      max_memory_restart: "256M",
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
    {
      name: "cryptobot-runtime-watchdog",
      script: "dist/runtime/run_runtime_watchdog.js",
      args: "--watch",
      cwd: __dirname,

      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",

      env: {
        NODE_ENV: "production",
        RUNTIME_AGENT_ID: "cryptobot-supervisor",
        RUNTIME_WATCHDOG_STALE_AFTER_MS: "60000",
        RUNTIME_WATCHDOG_DISCONNECT_AFTER_MS: "120000",
        RUNTIME_WATCHDOG_MAINTENANCE_GRACE_MS: "120000",
        RUNTIME_WATCHDOG_INTERVAL_MS: "10000",
        RUNTIME_WATCHDOG_PERSIST_MESSAGES: "true",
        RUNTIME_WATCHDOG_PERSIST_ACTIONS: "true",
        RUNTIME_WATCHDOG_NOTIFY_DRY_RUN: "true",
        RUNTIME_WATCHDOG_AFFECTED_INSTRUMENTS: "BTC-USDT,BTC-USDT-SWAP",
      },
      env_development: {
        NODE_ENV: "development",
      },

      out_file: "logs/runtime-watchdog.out.log",
      error_file: "logs/runtime-watchdog.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      max_size: "50M",
      retain: 10,

      max_memory_restart: "256M",
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
    {
      name: "cryptobot-okx-funding-watch",
      script: "dist/trade/run_okx_batch_funding_pair_watcher.js",
      cwd: __dirname,

      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",

      env: {
        NODE_ENV: "production",
        BATCH_FUNDING_ARB_POLL_MS: "60000",
        BATCH_FUNDING_ARB_WINDOW_POLL_MS: "5000",
        BATCH_FUNDING_ARB_HOLD_MS: "3000",
      },
      env_development: {
        NODE_ENV: "development",
      },

      out_file: "logs/batch-funding-watch.out.log",
      error_file: "logs/batch-funding-watch.log",
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
