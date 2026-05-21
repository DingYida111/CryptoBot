# CryptoBot

> Polymarket 信号驱动 OKX BTC 合约交易机器人

## 当前能力概览

目前项目已经不只是一个简单的信号脚本，而是拆成了四层：

- `monitor`：采集 Polymarket / OKX 数据并写入 SQLite
- `trade`：本地策略执行，当前包含 regime + directional trading + CHOP grid
- `runtime`：统一管理本地策略与 OKX 托管策略，支持 benchmark、快照持久化、后续扩展 martingale / arbitrage
- `portfolio`：统一 portfolio algebra、decision trace、runtime message 分类和 shadow health report

当前已经接入的托管策略能力：

- OKX `contract grid` 创建 / 查询 / 停止
- Local `funding arbitrage` shadow / paper validation
- 持久化 `managed_strategy_runs`
- 持久化 `managed_strategy_snapshots`
- 持久化 `managed_strategy_sub_orders`
- 持久化 `managed_strategy_positions`
- 持久化 `funding_arb_opportunities`
- 持久化 `funding_arb_events`
- 持久化 `portfolio_snapshots` for `local_funding_arbitrage`
- 持久化 `runtime_messages` for `warning / instrument_error / major_error`，`info` 需显式开启
- 持久化 observe-only `runtime_actions` proposals，先审计不执行
- RuntimeDecisionTrace 统一 report / health verdict / observe-only notification

基础设计文档：

- `CRYPTOBOT_KNOWLEDGE_BASE.md` — 全局本体与架构知识库，给人和 Agent 的统一入口
- `STRATEGY_RUNTIME_ARCHITECTURE.md` — 当前托管策略运行时设计
- `PORTFOLIO_ALGEBRA_FOUNDATION.md` — TypeScript-first 的 `instrument / security / strategy / residual` V1 落地方案
- `PORTFOLIO_ALGEBRA_M1_BLUEPRINT.md` — `M1: Registry + Exposure Compiler` 的文件级施工蓝图
- `PORTFOLIO_ALGEBRA_V1_MATH_NOTE.md` — V1 数学定义、单位约定和 worked example，避免后续实现跑偏
- `PORTFOLIO_CARRY_AND_OKX_ARBITRAGE_REPORT.md` — OKX 官方套利产品栈对比、carry 建模建议、funding arbitrage worked example
- `PORTFOLIO_CARRY_MODEL_NOTE.md` — carry 子模型的正式定义：funding / borrow / staking、realized vs expected、连续与离散结算
- `FUNDING_ARBITRAGE_STRATEGY_SPEC.md` — 第一版 BTC 现货 + 合约资金费率套利策略规格：事件驱动、双腿执行、shadow-first
- `FUNDING_ARBITRAGE_V1_RUNBOOK.md` — V1 落地说明：shadow / paper / official batch validation、supervisor 配置、持久化与已知限制

Portfolio algebra shadow diagnostics:

- `npm run report:portfolio-shadow -- 50` — 默认读取最新 `shadow_version` 的最近 50 条 shadow 行
- `npm run report:portfolio-shadow -- 50 --all` — 跨版本查看历史
- `npm run report:portfolio-shadow -- 50 --version portfolio-shadow-v1.1` — 指定版本过滤
- `npm run report:runtime-traces -- 50` — 统一读取 `portfolio_shadow_log` 与 `portfolio_snapshots` 中的 RuntimeDecisionTrace
- `npm run report:runtime-traces -- 50 --persist-messages` — 将分类后的 `warning / instrument_error / major_error` 消息写入 `runtime_messages`
- `npm run report:runtime-traces -- 50 --persist-messages --persist-info` — 同时持久化正常 `info` 消息
- `npm run report:runtime-traces -- 50 --persist-actions` — 将消息类别映射成 observe-only `runtime_actions` 建议动作
- `npm run report:runtime-actions -- 50` — 汇总 observe-only action proposal，并标记 cooldown/dedupe 候选
- `npm run run:runtime-action-executor -- 50` — dry-run 评估 proposed actions；默认不改状态、不交易
- `npm run run:runtime-action-executor -- 50 --ack-dry-run` — 将 dry-run 结果写回 action status，仍不交易
- `npm run report:runtime-traces -- 50 --notify-dry-run` — 打印将要通知的 error 类消息，不发送外部请求
- `RUNTIME_NOTIFY_WEBHOOK_URL=https://... npm run report:runtime-traces -- 50 --notify` — 发送 `notify=true` 的消息到 webhook
- `npm run run:runtime-message-self-test -- --persist-messages --notify-dry-run` — 生成一条模拟 `instrument_error`，验证消息落库和 dry-run 通知链路，不触发任何交易动作
- `npm run run:runtime-trace-fixture` — 写入一条标准 RuntimeDecisionTrace fixture 到 `portfolio_shadow_log`，用于无交易验证 observer/report 闭环

Supervisor observe-only runtime trace monitoring:

- `RUNTIME_TRACE_OBSERVER_ENABLED=true` — supervisor 每轮 sync 后自动扫描 RuntimeDecisionTrace
- `RUNTIME_TRACE_OBSERVER_PERSIST_MESSAGES=true` — 写入 `runtime_messages`，默认 true
- `RUNTIME_TRACE_OBSERVER_PERSIST_INFO=true` — 同时写入正常 `info` 消息，默认 false
- `RUNTIME_TRACE_OBSERVER_PERSIST_ACTIONS=true` — 写入建议动作到 `runtime_actions`，默认 false
- `RUNTIME_TRACE_OBSERVER_NOTIFY_DRY_RUN=true` — 只打印将通知的消息，默认 true
- `RUNTIME_TRACE_OBSERVER_NOTIFY=true` — 真实发送 `notify=true` 的消息；不会暂停、不平仓、不改变交易路径
- `RUNTIME_ACTION_EXECUTOR_ENABLED=true` — supervisor 每轮运行 dry-run action executor，默认 false
- `RUNTIME_ACTION_EXECUTOR_ACK_DRY_RUN=true` — 将 dry-run 结果写回 `runtime_actions.status`，默认 false
- `RUNTIME_ACTION_EXECUTOR_LIMIT=50` — 每轮最多处理 proposed actions
- `RUNTIME_ACTION_EXECUTOR_COOLDOWN_MS=300000` — dry-run cooldown/dedupe 窗口
- `RUNTIME_ACTION_EXECUTOR_LIVE_EXECUTION_ENABLED=true` — 仅用于 preflight 建模 live readiness，当前仍不执行
- `RUNTIME_ACTION_EXECUTOR_TRADING_ADAPTER_CONFIGURED=true` — 仅用于 preflight 建模 adapter readiness
- `RUNTIME_ACTION_EXECUTOR_PERSIST_CONTROL_EFFECTS=true` — 将 ready action 的 control effects 写入审计表，默认 false

Funding arbitrage diagnostics:

- `npm run run:okx-connectivity` — 只读检查 OKX DNS、公共 API、模拟盘 account balance 连通性；不写 DB、不下单
- `npm run run:funding-arb:validate` — 运行本地 funding arbitrage controller 的 shadow 或 paper 验证
- `npm run run:okx-batch-funding-validate` — 直接通过 OKX `batch-orders` 做一笔官方接口对照验证
- `npm run report:funding-arb -- 20` — 汇总最近 funding arb 机会、事件和 portfolio snapshots

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
- `src/runtime/local_funding_arbitrage_controller.ts`

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
- observe-only 扫描 RuntimeDecisionTrace，生成分类消息并可 dry-run 通知

### 4. Runtime Trace 与消息分类

关键文件：

- `src/portfolio/decision_trace.ts`
- `src/portfolio/decision_trace_report.ts`
- `src/runtime/runtime_trace_observer.ts`
- `src/runtime/runtime_notifications.ts`

职责：

- 汇总 `RuntimeDecisionTrace`
- 生成 `pass / warn / fail` health verdict
- 将 trace alert 映射为运行时消息：
  - `major_error`：未来用于全局停机和平仓
  - `instrument_error`：未来用于清空并暂停单个 instrument
  - `warning`：记录异常但继续运行
  - `info`：正常成交、参数变更、资金变动等信息
- 当前 observer 是 observe-only：
  - 可以写入 `runtime_messages`
  - 可以写入 `runtime_actions` 建议动作，`execution_enabled=false`
  - 默认只持久化 `warning / instrument_error / major_error`，`info` 需显式开启
  - 可以 dry-run 或 webhook 通知 `notify=true` 的消息
  - 不暂停、不平仓、不改变交易执行路径

### 5. 可扩展设计

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

Funding arbitrage 也已经按这一模式接入，不再是独立脚本：

- strategy type: `local_funding_arbitrage`
- execution modes: `shadow` / `paper`
- persistence surfaces:
  - `managed_strategy_*`
  - `funding_arb_opportunities`
  - `funding_arb_events`
  - `portfolio_snapshots`

Runtime trace observer 已按同一原则接入 supervisor：

- 默认关闭
- 开启后每轮 sync 后扫描 trace
- 只做消息落库和通知
- 不干预策略执行

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript（Node.js >= 20）|
| 价格采集 | Polymarket CLOB HTTP API + OKX REST API |
| 数据存储 | SQLite（`better-sqlite3`）|
| 策略验证 | 原始 Python 脚本（统计分析）|
| 部署 | Docker（可选）|

## 环境配置

### Node.js 版本

本项目建议使用 Node.js 20 LTS。仓库内已提供 `.nvmrc` 和 `.node-version`，支持 `nvm`、`fnm`、`nodenv`、`mise` 等工具自动选择版本。

如果本机使用 Homebrew 的 `node@20`：

```bash
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
npm rebuild better-sqlite3
```

不要使用 Node 25 运行本项目。`better-sqlite3` 是 native module，Node 大版本切换后需要重新编译，否则 report 脚本会出现 ABI 不匹配。

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

# Optional generic managed strategy config
# Recommended for local funding arbitrage or mixed strategy fleets
# MANAGED_STRATEGY_INSTANCES_JSON=[{"instanceId":"funding_arb_btc_demo","type":"local_funding_arbitrage","instrument":"BTC funding package","enabled":true,"autoStart":true,"syncIntervalMs":5000,"parameters":{"spotInstId":"BTC-USDT","perpInstId":"BTC-USDT-SWAP","entryLeadMs":120000,"maxPackageSizeBtc":0.01,"minUsefulPackageSizeBtc":0.01,"spotFeeRate":0.001,"perpFeeRate":0.0005,"spotSlippageBps":5,"perpSlippageBps":5,"basisRiskBufferBps":8,"safetyBufferUsd":1,"paperExecute":false,"forceValidationEntry":false,"maxHoldMs":300000,"maxNetDeltaToleranceBtc":0.002}}]

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

Funding arbitrage 示例：

```json
[
  {
    "instanceId": "funding_arb_btc_demo",
    "type": "local_funding_arbitrage",
    "instrument": "BTC funding package",
    "enabled": true,
    "autoStart": true,
    "syncIntervalMs": 5000,
    "parameters": {
      "spotInstId": "BTC-USDT",
      "perpInstId": "BTC-USDT-SWAP",
      "entryLeadMs": 120000,
      "maxPackageSizeBtc": 0.01,
      "minUsefulPackageSizeBtc": 0.01,
      "spotFeeRate": 0.001,
      "perpFeeRate": 0.0005,
      "spotSlippageBps": 5,
      "perpSlippageBps": 5,
      "basisRiskBufferBps": 8,
      "safetyBufferUsd": 1,
      "paperExecute": false,
      "forceValidationEntry": false,
      "maxHoldMs": 300000,
      "maxNetDeltaToleranceBtc": 0.002
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
- `funding_arb_opportunities`
- `funding_arb_events`
- `portfolio_snapshots`（`source = local_funding_arbitrage`）
- `runtime_messages`
- `runtime_actions`

这些表的目标是让分析建立在结构化数据上，而不是建立在日志文本上。

## Runtime Trace 验证状态

当前 observe-only 链路已经验证：

- `npm run run:runtime-message-self-test -- --persist-messages --notify-dry-run`
  - 生成模拟 `instrument_error`
  - 验证 `runtime_messages` 落库和 dry-run 通知
- `npm run run:runtime-trace-fixture`
  - 写入标准 `RuntimeDecisionTrace` fixture 到 `portfolio_shadow_log`
  - 不访问交易接口
- `npm run report:runtime-traces -- 20 --source runtime_trace_fixture --persist-messages --notify-dry-run`
  - 验证 trace -> message -> persistence -> notification dry-run 闭环
- `npm run report:runtime-traces -- 20 --source runtime_trace_fixture --persist-actions`
  - 验证 trace -> message -> observe-only action proposal 落库
- `npm run report:runtime-actions -- 20 --source runtime_trace_fixture`
  - 汇总建议动作，审计 action type / instrument 分布和 cooldown 重复候选
- `npm run run:runtime-action-executor -- 20 --source runtime_trace_fixture`
  - dry-run 展示未来执行器会处理哪些动作、adapter operation 和 control effects，不暂停、不平仓
- `npm run run:runtime-action-executor -- 20 --simulate-live-execution-enabled --simulate-trading-adapter-configured`
  - 仅模拟 live preflight readiness，仍不触发交易
- `npm run run:runtime-action-executor -- 20 --simulate-live-execution-enabled --simulate-trading-adapter-configured --persist-control-effects`
  - 将 ready action 的 control effects 写入 `runtime_control_effects`，仍不干预运行
- `npm run report:runtime-control -- 20`
  - 汇总已持久化的 planned control effects
- `npm run run:runtime-action-executor -- 20 --source runtime_trace_fixture --ack-dry-run`
  - 将 dry-run 状态写回本地 `runtime_actions`，仍不触发交易

当前限制：

- 本地环境访问 `www.okx.com:443` 存在连接超时，真实 funding arb shadow trace 尚未跑通。
- 自动处理动作尚未接入。`major_error` / `instrument_error` 现在只分类、落库、通知，不自动暂停或平仓。

## 数据验证标准

在进入 Phase 2 之前，需要达到以下标准：

- [ ] 收集至少 500 个有效窗口的数据
- [ ] UP > 0.55 时，BTC 接下来15分钟上涨的概率 > 55%（基准：50%）
- [ ] DOWN > 0.55 时，BTC 接下来15分钟下跌的概率 > 55%
- [ ] 上述偏差的 p-value < 0.05（统计显著）
- [ ] 平均收益率为正（扣除手续费后）

若数据验证未通过，项目将停留 Phase 1，不进入策略开发。

## 免责声明

本项目仅供教育与研究目的。预测市场和加密货币合约交易存在重大财务风险，包括可能亏损全部资金。历史表现不代表未来结果。你须自行承担使用本软件的所有风险。

## License

MIT
