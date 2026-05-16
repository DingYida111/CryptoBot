# CryptoBot

> Polymarket 信号驱动 OKX BTC 合约交易机器人

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
│   ├── strategy/             # Phase 2 策略模块（待开发）
│   ├── execution/            # Phase 3 执行模块（待开发）
│   ├── utils/
│   │   ├── logger.ts
│   │   └── time.ts
│   └── types.ts
├── data/                     # SQLite 数据库目录
├── logs/                     # 日志目录
└── scripts/
    └── analysis/            # 数据分析脚本
```

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
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动数据采集（Phase 1）
npm run collect

# 数据分析（需要先跑至少 100 个窗口，约 25 小时）
node scripts/analysis/correlate.ts
```

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