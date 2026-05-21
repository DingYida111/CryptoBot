# CryptoBot

> Polymarket 信号驱动 OKX BTC 合约交易机器人

## 当前能力概览

目前项目已经不只是一个简单的信号脚本，而是拆成了三层：

- `monitor`：采集 Polymarket / OKX 数据并写入 SQLite
- `trade`：本地策略执行，当前包含 regime + directional trading + CHOP grid
- `runtime`：统一管理本地策略与 OKX 托管策略，支持 benchmark、快照持久化、后续扩展 martingale / arbitrage

当前已经接入的托管策略能力：

- OKX `contract grid` 创建 / 查询 / 停止
- 持久化 `managed_strategy_runs`
- 持久化 `managed_strategy_snapshots`
- 持久化 `managed_strategy_sub_orders`
- 持久化 `managed_strategy_positions`

基础设计文档：

- `STRATEGY_RUNTIME_ARCHITECTURE.md` — 当前托管策略运行时设计
- `PORTFOLIO_ALGEBRA_FOUNDATION.md` — TypeScript-first 的 `instrument / security / strategy / residual` V1 落地方案
- `PORTFOLIO_ALGEBRA_M1_BLUEPRINT.md` — `M1: Registry + Exposure Compiler` 的文件级施工蓝图

Portfolio algebra shadow diagnostics:

- `npm run report:portfolio-shadow -- 50` — 默认读取最新 `shadow_version` 的最近 50 条 shadow 行
- `npm run report:portfolio-shadow -- 50 --all` — 跨版本查看历史
- `npm run report:portfolio-shadow -- 50 --version portfolio-shadow-v1.1` — 指定版本过滤

## 核心思路

Polymarket 是基于区块链的预测市场，其 BTC 15分钟"涨跌"市场（BID: "BTC 15分钟后上涨还是下跌？"）反映了交易者在短期内对 BTC 价格方向的群体预期。

**本项目的假设**：当 Polymarket 的群体预期在短期内出现系统性偏差时，这种偏差包含了有价值的预测信息，可以用来在 OKX BTC 永续合约上进行有方向性的交易。

> 注意：这不是无风险套利。这是一套**信号 → 验证 → 执行**的自动化交易系统，存在亏损风险。

## 策略框架

### Phase 1（当前）：数据验证阶段

**目标**：验证 Polymarket BTC 15分钟预测的概率信号与 OKX BTC 实际走势之间的相关性。

```
Polymarket CLOB API          OKX REST API
      │                            │
      ▼                            ▼
采集 UP/DOWN 代币价格          采集 BTC 永续价格
      │                            │
      └────────┬───────────────────┘
               ▼
        分析相关性：
        - 当 UP 价格 > 0.55 时，BTC 接下来15分钟上涨的频率？
        - 当 DOWN 价格 > 0.55 时，BTC 接下来15分钟下跌的频率？
        - 这种偏差的统计显著性？
```

**数据收集**（`src/monitor/`）：
- `polymarket.ts` — 轮询 Polymarket CLOB API，获取当前15分钟窗口的 UP/DOWN 代币价格（bid/ask）
- `okx.ts` — 轮询 OKX REST API，获取 BTC 永续合约价格
- `storage.ts` — 将配对数据存入 SQLite，便于后续分析
- `run.ts` — 定时任务入口

**数据模型**：
```typescript
interface Tick {
  timestamp: number;        // Unix ms
  slug: string;             // Polymarket market slug
  upAsk: number;            // UP 代币卖一价
  downAsk: number;          // DOWN 代币卖一价
  btcPrice: number;         // OKX BTC 永续合约价格（USD）
  marketEndTimestamp: number; // 本窗口结束时间
}
```

### Phase 2：策略开发阶段（数据验证后）

根据 Phase 1 的统计结果，选择最优策略方向：

**策略A**：概率偏差信号（若统计显著）
- 当 UP 价格 > 阈值 X → 在 OKX 开多
- 当 DOWN 价格 > 阈值 X → 在 OKX 开空
- 窗口结束时平仓

**策略B**：急跌对冲（借鉴 Dougthethugg）
- 检测 Polymarket 一侧代币价格的急跌
- 同时在 Polymarket 买入抄底侧 + OKX 对冲方向
- 锁定两个头寸的组合收益

**策略C**：预测增强（借鉴 sysnexus1）
- 使用自适应线性回归模型，对 UP/DOWN 价格序列进行方向预测
- 当预测信心 > 阈值时，在 OKX 追入方向

### Phase 3：实盘与风控

- 模拟盘验证至少 100 个15分钟窗口后再上实盘
- 仓位控制：单笔不超过总资金的 2%
- 最大同时持仓窗口数限制
- 止损机制：单窗口最大亏损 1%
- 日亏损熔断：当日亏损 > 5% 停止交易

## 项目结构

```
CryptoBot/
├── README.md
├── trade.toml               # 交易参数配置
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── monitor/             # Phase 1 数据采集
│   │   ├── polymarket.ts    # Polymarket CLOB 价格采集
│   │   ├── okx.ts           # OKX REST 价格采集
│   │   ├── storage.ts       # SQLite 存储
│   │   └── run.ts           # 采集入口
│   ├── strategy/            # 信号评分、Kronos、regime 判断
│   ├── trade/               # 本地下单、仓位管理、CHOP grid、OKX bot API
│   ├── runtime/             # 托管策略 registry / controller / supervisor
│   └── types.ts
├── data/                     # SQLite 数据库目录
├── logs/                     # 日志目录
├── ecosystem.config.js       # PM2 配置
├── STRATEGY_RUNTIME_ARCHITECTURE.md
└── PORTFOLIO_ALGEBRA_FOUNDATION.md
```

## 运行时架构

这部分是现在项目最重要的结构变化。

### 1. 本地策略执行层

入口：

- `src/trade/strategy_runner.ts`

职责：

- 读取 Polymarket + BTC 行情
- 判断当前 regime
- 执行 directional trade 或 CHOP grid
- 同步 OKX 持仓
- 记录详细成交 / 平仓 / 风控日志

### 2. 托管策略适配层

关键文件：

- `src/trade/okx_bots.ts`
- `src/runtime/okx_contract_grid_controller.ts`

职责：

- 适配 OKX Strategy Trading API
- 将 OKX 原生返回结构转成统一 snapshot
- 让托管策略也能像本地策略一样被统一管理

### 3. 统一控制平面

关键文件：

- `src/runtime/managed_strategies.ts`
- `src/runtime/strategy_registry.ts`
- `src/runtime/strategy_supervisor.ts`
- `src/runtime/supervisor_config.ts`
- `src/runtime/persistence.ts`

职责：

- 注册策略类型与参数元数据
- 为每种策略生成对应 controller
- 轮询多个 strategy instance
- 持久化 run / snapshot / sub-order / position
- 为 benchmark、dashboard、Agent 分析提供统一数据面

### 4. 可扩展设计

新增一个策略族时，原则上只需要三步：

1. 在 `managed_strategies.ts` 新增 definition
2. 实现一个 controller，暴露 `start / sync / stop`
3. 在 `strategy_registry.ts` 注册 factory

这使得后续接入：

- OKX martingale
- 本地 spread arbitrage
- funding basis
- 交易所其他托管策略

都不需要重构主流程。

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript（Node.js >= 20）|
| 价格采集 | Polymarket CLOB HTTP API + OKX REST API |
| 数据存储 | SQLite（`better-sqlite3`）|
| 策略验证 | 原始 Python 脚本（统计分析）|
| 部署 | Docker（可选）|

## 环境配置

```bash
cp .env.example .env
# 编辑 .env 填入必要的 API key 和配置
```

安全原则：

- 不要把 API key 写进 Git
- 不要把 API key 直接写进 PM2 `env`
- 所有密钥统一从 `.env` 由 `dotenv` 在运行时读取
- 开源仓库默认只允许提交 `.env.example`

关键配置项：

```env
# OKX API（用于采集价格，不需要交易权限）
OKX_API_KEY=your_key
OKX_API_SECRET=your_secret
OKX_API_PASSPHRASE=your_passphrase
OKX_USE_PROXY=false

# Polymarket（使用公开发接口，无需认证）
# ...

# 数据采集配置
DATA_COLLECT_INTERVAL_MS=5000   # 采集间隔（ms）
TARGET_MARKETS=btc              # 目标市场（btc/eth/sol/xrp）
WINDOW_DURATION_MINUTES=15      # 窗口时长（分钟）

# 交易配置
SIGNAL_INTERVAL_MS=10000
MAX_POSITION_SIZE=1
CLOSE_BEFORE_MINS=0.5
MAX_HOLDING_MS=1500000
FLOATING_PROFIT_THRESHOLD_PCT=0.5

# Regime 配置
REGIME_MODE=adaptive        # adaptive | trend_only | chop_only
MIN_REGIME_SCORE=0.6
TREND_WIDTH_MIN_PCT=0.04
CHOP_WIDTH_MAX_PCT=0.035

# Managed strategy supervisor
STRATEGY_SUPERVISOR_ENABLED=true
STRATEGY_SUPERVISOR_WATCH=true
STRATEGY_SUPERVISOR_INTERVAL_MS=60000
STRATEGY_SUPERVISOR_AUTO_START=false
STRATEGY_SUPERVISOR_ALLOW_BENCHMARK_FALLBACK=true

# OKX benchmark fallback instance
OKX_BENCHMARK_ENABLED=true
OKX_BENCHMARK_AUTO_CREATE=false
OKX_BENCHMARK_WATCH=false
OKX_BENCHMARK_INST_ID=BTC-USDT-SWAP
OKX_BENCHMARK_DIRECTION=neutral
OKX_BENCHMARK_MARGIN=200
OKX_BENCHMARK_LEVERAGE=2
OKX_BENCHMARK_GRID_NUM=7
OKX_BENCHMARK_RUN_TYPE=1
OKX_BENCHMARK_MIN_RATIO=0.97
OKX_BENCHMARK_MAX_RATIO=1.03
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动数据采集
npm run collect

# 启动本地策略执行
node dist/trade/strategy_runner.js

# 单次同步 OKX grid benchmark
npm run benchmark:okx-grid

# 启动统一 supervisor
npm run supervisor:strategies
```

如果使用 PM2：

```bash
pm2 start ecosystem.config.js
pm2 logs cryptobot-strat
pm2 logs cryptobot-supervisor
```

## Agent / 开发者阅读顺序

如果你是开发者或内部 Agent，建议按下面顺序阅读：

1. `README.md`
2. `STRATEGY_RUNTIME_ARCHITECTURE.md`
3. `PORTFOLIO_ALGEBRA_FOUNDATION.md`
4. `PORTFOLIO_ALGEBRA_M1_BLUEPRINT.md`
5. `src/trade/strategy_runner.ts`
6. `src/trade/chop_grid.ts`
7. `src/trade/okx_bots.ts`
8. `src/runtime/`
9. `src/monitor/storage.ts`

这样能最快理解：

- 信号从哪里来
- 本地策略怎么下单
- OKX 托管策略怎么接入
- snapshot 是怎么落库的
- 以后该在哪一层扩展新策略

## Managed Strategy 配置

`StrategySupervisor` 支持通过 `MANAGED_STRATEGY_INSTANCES_JSON` 一次加载多个实例。

示例：

```json
[
  {
    "instanceId": "okx_grid_btc_demo",
    "type": "okx_contract_grid",
    "instrument": "BTC-USDT-SWAP",
    "enabled": true,
    "autoStart": false,
    "syncIntervalMs": 60000,
    "parameters": {
      "algoId": "",
      "direction": "neutral",
      "margin": 200,
      "leverage": 2,
      "gridNum": 7,
      "runType": 1,
      "minPriceRatio": 0.97,
      "maxPriceRatio": 1.03
    },
    "metadata": {
      "role": "benchmark"
    }
  }
]
```

若未提供 `MANAGED_STRATEGY_INSTANCES_JSON`，supervisor 会回退到 `OKX_BENCHMARK_*` 配置，便于低成本快速上线对比实验。

## 数据库中的托管策略表

新增的几张表用于 benchmark 和复盘：

- `managed_strategy_runs`
- `managed_strategy_snapshots`
- `managed_strategy_sub_orders`
- `managed_strategy_positions`

这些表的目标是让分析建立在结构化数据上，而不是建立在日志文本上。

## 数据验证标准

在进入 Phase 2 之前，需要达到以下标准：

- [ ] 收集至少 500 个有效窗口的数据
- [ ] UP > 0.55 时，BTC 接下来15分钟上涨的概率 > 55%（基准：50%）
- [ ] DOWN > 0.55 时，BTC 接下来15分钟下跌的概率 > 55%
- [ ] 上述偏差的 p-value < 0.05（统计显著）
- [ ] 平均收益率为正（扣除手续费后）

若数据验证未通过，项目将停留 Phase 1，不进入策略开发。

## 参考项目

本项目在设计和实现上参考了以下开源项目：

| 项目 | 参考内容 |
|------|---------|
| [Simon-Evan/polymarket-trading-bot](https://github.com/Simon-Evan/polymarket-trading-bot) | 双策略框架（trade_1/trade_2）、重试机制、决策引擎设计 |
| [sysnexus1/polymarket-arbitrage-bot](https://github.com/sysnexus1/polymarket-arbitrage-bot) | AdaptivePricePredictor（在线线性回归）、pole detection、accuracy tracking |
| [Dougthethugg/polymarket-trading-bot](https://github.com/Dougthethugg/polymarket-trading-bot) | Dump-and-hedge 策略、状态机设计、history.toml 复盘日志 |

## 免责声明

本项目仅供教育与研究目的。预测市场和加密货币合约交易存在重大财务风险，包括可能亏损全部资金。历史表现不代表未来结果。你须自行承担使用本软件的所有风险。

## License

MIT
