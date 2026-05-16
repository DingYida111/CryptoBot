# CryptoBot 实施计划

> Last updated: 2026-05-16
> Author: PEAK Team Quant

---

## 背景与目标

**核心命题**：Polymarket BTC 15分钟涨跌市场的概率信号，是否对 OKX BTC 永续合约价格有统计显著的预测能力？

**Phase 1（当前）**：数据采集 + 验证
**Phase 2**：策略开发（验证通过后）
**Phase 3**：模拟盘 + 实盘

---

## Phase 1 — 数据采集与验证

### 里程碑 1.1：基础设施完成

**目标**：采集程序稳定运行，数据库正常写入

- [x] `src/monitor/polymarket.ts` — Polymarket CLOB 价格采集
- [x] `src/monitor/okx.ts` — OKX BTC 永续价格采集
- [x] `src/monitor/storage.ts` — SQLite 存储（ticks + window_summaries）
- [x] `src/monitor/run.ts` — 采集循环 + 窗口切换检测 + 信号记录

**TODO**：
- [ ] 配置 `.env`（填入 OKX API key 和 Polymarket 私钥）
- [ ] `npm install && npm run collect` 启动采集
- [ ] 验证数据库写入：确认 ticks 和 window_summaries 表有数据

**验收标准**：
- 采集 1 小时后，`ticks` 表至少有 500 条记录（每 5s × 12 × 4 coins）
- `window_summaries` 表至少记录了 2 个完整窗口（30分钟）

---

### 里程碑 1.2：数据质量检查

**目标**：确保采集数据的完整性和一致性

- [ ] 检查 Polymarket API 连通性（国内是否需要代理）
- [ ] 检查 OKX API 连通性（国内是否需要代理）
- [ ] 验证 slug 生成逻辑和 Polymarket 实际 slug 一致性
- [ ] 验证 market_end_timestamp 和实际窗口结束时间匹配
- [ ] 添加数据质量告警：连续 N 次采集失败时通知

**技术细节**：
- Polymarket CLOB API（`clob.polymarket.com`）可能在国内需要代理
- OKX 公开行情 API（`www.okx.com/api/v5/market/ticker`）通常可直连
- 需要在 `.env` 中加入 `HTTP_PROXY` 配置

---

### 里程碑 1.3：统计验证

**目标**：用已有数据验证"UP > X → BTC 涨"的假设

在积累 500 个完整窗口数据后（约 125 小时），运行以下验证：

```python
# 伪代码
for threshold in [0.55, 0.60, 0.65, 0.70]:
    for direction in ["up", "down"]:
        # 当 signal 触发时的 BTC 实际走势
        # 计算胜率、p-value、平均收益率
        pass
```

**数据验证标准**（全部满足才进入 Phase 2）：

| 条件 | 阈值 |
|------|------|
| 有效窗口数 | ≥ 500 |
| UP > 0.55 时 BTC 上涨概率 | > 55% |
| DOWN > 0.55 时 BTC 下跌概率 | > 55% |
| 偏差 p-value | < 0.05 |
| 平均收益率（扣除手续费后）| > 0 |

**若验证失败**：停在 Phase 1，报告结果，不进入 Phase 2。

---

## Phase 2 — 策略开发

Phase 1 通过后解锁。基于三个参考项目的最佳实践，Phase 2 包含三条策略线：

### 策略 A：概率偏差信号（主策略）

**借鉴**：Simon-Evan 的 trade_1/trade_2 决策框架

**逻辑**：
```
IF UP_bid > 0.55 AND window_time_remaining > 20% THEN
    IF no existing position THEN
        entry_direction = "up"
        entry_price = current_btc_price
    END
END

IF remaining_time_ratio > 0.90 OR up_price_ratio > 0.95 THEN
    close_position(entry_price, current_btc_price)
END
```

**关键参数**（需回测优化）：
- `SIGNAL_THRESHOLD`: 0.55（可遍历 0.50–0.70）
- `ENTRY_TIME_RATIO_MIN`: 0.2（窗口过完不追入）
- `EXIT_TIME_RATIO`: 0.90
- `MAX_HOLDING_WINDOWS`: 1（不过夜）

**回测框架**：
- 使用已有 500+ 窗口数据
- 遍历参数空间，找出最优组合
- 留 20% 数据做 out-of-sample 验证

---

### 策略 B：急跌对冲（对冲策略）

**借鉴**：Dougthethugg 的 dump-and-hedge 逻辑

**逻辑**：
```
IF (UP_bid 从高点下跌 > 15% OR DOWN_bid 从高点下跌 > 15%) THEN
    # 抄底便宜那一侧
    leg1_side = cheaper_side
    leg1_price = current_price
    leg1_shares = 5

    # 等待对侧价格合适
    WHILE (time_remaining > 0 AND leg1_price + other_side_ask <= 0.95) WAIT 1s
    IF condition_met THEN
        leg2_side = other_side
        leg2_price = other_side_ask
        HOLD_BOTH_TO_RESOLUTION
    ELSE
        # 止损：立即以市价买入对侧
        emergency_hedge()
    END
END
```

**关键参数**：
- `DUMP_THRESHOLD`: 0.15（15% 价格急跌）
- `HEDGE_SUM_TARGET`: 0.95（两腿总价上限）
- `STOP_LOSS_WAIT_MINUTES`: 5（超时后强制对冲）

---

### 策略 C：自适应预测（可选，高阶）

**借鉴**：sysnexus1 的 AdaptivePricePredictor

**逻辑**：使用在线线性回归，持续更新权重，预测下一个价格方向：
- 特征：momentum、volatility、trend（EMA 差分）
- 只在 pole value（极值点）预测，减少噪音
- 信心度 > 阈值才触发交易
- 权重通过梯度下降在线学习

**成本**：实现复杂度高，Phase 2 后期再评估是否接入。

---

## Phase 3 — 交易执行

### 3.1 模拟盘（至少 100 窗口）

- 不使用真实资金
- 完整走交易流程（信号生成 → 订单构造 → 成交回报 → 盈亏计算）
- 记录每笔交易到 `executions` 表

**验收标准**：
- 连续 100 窗口无 crash
- 手续费计算正确
- 仓位管理正确（单笔 ≤ 2% 资金）

### 3.2 实盘（极小仓位开始）

- 单笔金额：总资金的 0.5%（不是 2%，保守起步）
- 最大同时持仓窗口：1
- 日亏损熔断：-3%（不是 5%，更保守）
- 每周复盘，调整参数

### 3.3 风控规则

```
单笔最大亏损: 1% 总资金
日累计亏损熔断: -3% 总资金
持仓窗口上限: 1 个（不跨窗口持仓）
最大单日交易次数: 10
仓位增长率: 盈利 10% 后才将单笔上限从 0.5% 提升到 1%
```

---

## 项目结构（完整规划）

```
CryptoBot/
├── README.md
├── IMPLEMENTATION_PLAN.md         # 本文件
├── trade.toml                    # 策略参数配置
├── .env.example
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts                  # 共享类型定义
│   ├── config.ts                 # 环境变量 + TOML 配置加载（Zod 验证）
│   │
│   ├── monitor/                  # Phase 1
│   │   ├── polymarket.ts        # Polymarket CLOB 价格采集
│   │   ├── okx.ts               # OKX REST 价格采集
│   │   ├── storage.ts           # SQLite 存储
│   │   ├── run.ts               # 采集入口
│   │   └── proxy.ts             # 代理配置（可选）
│   │
│   ├── strategy/                 # Phase 2
│   │   ├── index.ts             # 策略选择器
│   │   ├── probability_signal.ts # 策略A：概率偏差信号
│   │   ├── dump_hedge.ts        # 策略B：急跌对冲
│   │   └── adaptive_predictor.ts # 策略C：自适应预测（可选）
│   │
│   ├── execution/                # Phase 3
│   │   ├── okx_trader.ts        # OKX 合约交易接口
│   │   ├── polymarket_trader.ts # Polymarket 代币交易接口
│   │   ├── position_manager.ts  # 仓位管理 + 盈亏计算
│   │   └── risk_manager.ts      # 风控规则引擎
│   │
│   ├── backtest/                 # 回测框架
│   │   └── runner.ts            # 基于已有数据的回测
│   │
│   ├── utils/
│   │   ├── logger.ts            # 日志（文件 + stderr）
│   │   ├── time.ts              # 时间工具
│   │   └── http.ts              # 带重试的 HTTP 客户端
│   │
│   └── analysis/                # 统计分析脚本
│       └── validate.ts          # Phase 1 统计验证
│
├── data/                         # SQLite 数据库（运行生成）
│   └── cryptobot.sqlite3
│
├── logs/                         # 日志目录
│
└── scripts/
    ├── install-deps.sh
    ├── start-collector.sh
    └── analysis/
        ├── validate_correlation.py
        ├── backtest.py
        └── report.py
```

---

## 技术决策记录

### Decision 1：数据采集 vs 实时 WebSocket

**决定**：Phase 1 使用轮询（polling），而非 WebSocket

**理由**：
- 轮询 5s 间隔对统计验证足够（Phase 1 需要的是数据量，不是毫秒级延迟）
- 轮询比 WebSocket 实现简单，更容易调试和 debug
- Phase 2 如需要更低延迟，可以升级到 WebSocket

### Decision 2：存储用 SQLite，而非 PostgreSQL/云数据库

**理由**：
- 轻量，无需额外服务
- `better-sqlite3` 同步 API 更适合 Node.js 进程
- 数据量可控（每5秒 × 4 coins = 69120 条/天，1年约 2500万条，可接受）

### Decision 3：TypeScript 而非 Python

**理由**：
- 与 Polymarket 生态（clob-client SDK）语言一致
- 全栈 TypeScript 减少技术栈切换
- 参考的三个项目均为 TypeScript

### Decision 4：先验证，后上策略

**理由**：
- 如果 Polymarket 信号对 BTC 方向没有统计显著的预测能力，任何策略都是徒劳
- 节省 2–4 周的开发时间（避免在无效信号上构建复杂系统）

---

## 参考项目

| 项目 | 贡献 |
|------|------|
| Simon-Evan/polymarket-trading-bot | 双策略框架（trade_1/trade_2）、重试机制 |
| sysnexus1/polymarket-arbitrage-bot | AdaptivePricePredictor、pole detection、accuracy tracking |
| Dougthethugg/polymarket-trading-bot | Dump-and-hedge 策略、状态机设计、history.toml 复盘日志 |
| mvanhorn/last30days-skill | Polymarket Gamma API 搜索模式、outcome price 解析 |

---

## 时间线（预估）

| 阶段 | 任务 | 预估时间 |
|------|------|---------|
| Phase 1.1 | 跑通采集程序 | 1–2 天 |
| Phase 1.2 | 数据质量检查 + 代理支持 | 1–2 天 |
| Phase 1.3 | 统计验证（等待500窗口） | ~5 天（自然积累） |
| Phase 2 | 策略开发 + 回测 | 3–5 天 |
| Phase 3.1 | 模拟盘 100 窗口 | ~1 天 |
| Phase 3.2 | 实盘极小仓位 | 持续 |

**最快路线**：约 2–3 周可以从零到模拟盘。

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Polymarket API 国内无法访问 | 高 | 高 | 添加 HTTP_PROXY 支持 |
| OKX API 国内无法访问 | 低 | 高 | 直连测试，提前验证 |
| Phase 1 验证失败（信号无效）| 未知 | 中 | 这是核心假设，验证失败项目终止 |
| OKX 无法合约交易（BTC仅现货）| 低 | 中 | 确认 OKX 账户有合约交易权限 |
| 策略亏损超过风控 | 中 | 高 | 严格遵守 Phase 3.2 的仓位限制 |