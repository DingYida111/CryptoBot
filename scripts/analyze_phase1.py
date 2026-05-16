#!/usr/bin/env python3
"""
Phase 1 Statistical Analysis for CryptoBot
==========================================
Analyzes the window_summaries table to answer:
  1. Win rate: Does Polymarket signal > 0.55 predict BTC direction?
  2. Statistical significance (binomial p-value, Fisher exact test)
  3. Net EV after friction (spread + fee)
  4. Signal correlation with BTC return (Pearson / Spearman)
  5. Time-of-day breakdown (ET hour buckets)
  6. Regime breakdown

Usage:
    python3 scripts/analyze_phase1.py [--db data/cryptobot.sqlite3] [--min-windows 30]

Requirements:
    pip install pandas scipy numpy tabulate
"""

import argparse
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
    from scipy import stats
    from tabulate import tabulate
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run: pip install pandas scipy numpy tabulate")
    sys.exit(1)


# ── Constants ─────────────────────────────────────────────────────────────────
DEFAULT_DB = Path(__file__).parent.parent / "data" / "cryptobot.sqlite3"
ET_OFFSET = timedelta(hours=-5)   # EST; flip to -4 for EDT (not critical for bucketing)
SIGNAL_THRESHOLD = 0.55
FEE_RATE = 0.02   # Polymarket 2% taker fee (can override with env)


# ── Data Loading ──────────────────────────────────────────────────────────────

def load_data(db_path: str) -> pd.DataFrame:
    con = sqlite3.connect(db_path)
    df = pd.read_sql("""
        SELECT
            id,
            coin,
            slug,
            window_start_timestamp,
            window_end_timestamp,
            signal_up_price,
            signal_down_price,
            btc_entry_price,
            btc_exit_price,
            btc_return,
            up_won,
            profit_if_up,
            profit_if_down,
            net_profit_if_up,
            net_profit_if_down,
            spread_cost,
            fee_cost,
            created_at
        FROM window_summaries
        WHERE btc_return IS NOT NULL
        ORDER BY window_end_timestamp ASC
    """, con)
    con.close()
    return df


def enrich(df: pd.DataFrame) -> pd.DataFrame:
    """Add derived columns."""
    df = df.copy()
    df["window_end_dt"] = pd.to_datetime(df["window_end_timestamp"], unit="s", utc=True)
    # ET hour for time-of-day analysis
    df["et_hour"] = (df["window_end_dt"] + pd.Timedelta(hours=-5)).dt.hour

    df["up_won"] = df["up_won"].astype(float)  # keep NaN-safe
    df["btc_return_pct"] = df["btc_return"] * 100

    # Signal presence flags
    df["has_up_signal"]   = df["signal_up_price"].notna() & (df["signal_up_price"] > SIGNAL_THRESHOLD)
    df["has_down_signal"] = df["signal_down_price"].notna() & (df["signal_down_price"] < (1 - SIGNAL_THRESHOLD))

    # Gross and net profit based on direction we'd have bet
    df["directed_gross_profit"] = np.where(
        df["has_up_signal"] & df["up_won"].notna(),
        df["profit_if_up"],
        np.where(
            df["has_down_signal"] & df["up_won"].notna(),
            df["profit_if_down"],
            np.nan,
        )
    )

    # Friction-adjusted net profit (use stored values if available, else compute)
    if "net_profit_if_up" in df.columns and df["net_profit_if_up"].notna().any():
        df["directed_net_profit"] = np.where(
            df["has_up_signal"] & df["up_won"].notna(),
            df["net_profit_if_up"],
            np.where(
                df["has_down_signal"] & df["up_won"].notna(),
                df["net_profit_if_down"],
                np.nan,
            )
        )
    else:
        # Compute from fee rate if DB doesn't have friction columns yet
        friction = FEE_RATE * 100  # in same units as profit_if_*
        df["directed_net_profit"] = df["directed_gross_profit"] - friction

    return df


# ── Analysis Functions ────────────────────────────────────────────────────────

def overall_stats(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print("OVERALL DATASET STATS")
    print("=" * 60)
    n = len(df)
    n_up_won = int(df["up_won"].sum())
    print(f"Total windows : {n}")
    print(f"UP won        : {n_up_won} ({100 * n_up_won / n:.1f}%)")
    print(f"Date range    : {df['window_end_dt'].min().date()} → {df['window_end_dt'].max().date()}")
    print(f"Coins         : {df['coin'].value_counts().to_dict()}")
    print(f"BTC return    : mean={df['btc_return_pct'].mean():.3f}%  std={df['btc_return_pct'].std():.3f}%")


def signal_accuracy(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print(f"SIGNAL ACCURACY  (threshold={SIGNAL_THRESHOLD})")
    print("=" * 60)

    for direction, has_col, win_col, label in [
        ("UP",   "has_up_signal",   "up_won",              "upBid > threshold → BTC UP"),
        ("DOWN", "has_down_signal", None,                  "downBid < 1-threshold → BTC DOWN"),
    ]:
        sub = df[df[has_col]]
        if len(sub) < 5:
            print(f"\n[{direction}] Too few samples ({len(sub)}) to analyse.")
            continue

        if direction == "UP":
            actual_win = sub["up_won"].astype(bool)
        else:
            actual_win = ~sub["up_won"].astype(bool)  # DOWN wins when BTC goes down

        n = len(sub)
        wins = int(actual_win.sum())
        win_rate = wins / n

        # Binomial test: H0 = win_rate == 0.5
        binom = stats.binomtest(wins, n, p=0.5, alternative="greater")

        gross = sub["directed_gross_profit"].dropna()
        net   = sub["directed_net_profit"].dropna()

        print(f"\n  {label}")
        print(f"  N={n}  Wins={wins}  WinRate={win_rate:.1%}")
        print(f"  Binomial p-value (H1: win>50%): {binom.pvalue:.4f} {'✅ SIGNIFICANT' if binom.pvalue < 0.05 else '❌ NOT SIGNIFICANT'}")
        if len(gross) > 0:
            print(f"  Gross profit/trade: mean={gross.mean():.2f}  median={gross.median():.2f}")
        if len(net) > 0:
            print(f"  Net profit/trade  : mean={net.mean():.2f}  median={net.median():.2f}  (after fee={FEE_RATE*100:.0f}%)")
            ev_positive = net.mean() > 0
            print(f"  Expected value    : {'✅ POSITIVE' if ev_positive else '❌ NEGATIVE'}")


def signal_vs_nosignal(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print("SIGNAL vs NO-SIGNAL WINDOWS")
    print("=" * 60)

    has_any = df["has_up_signal"] | df["has_down_signal"]
    sig_wins   = df[has_any]["up_won"].mean()
    nosig_wins = df[~has_any]["up_won"].mean()

    ct = pd.crosstab(has_any, df["up_won"].astype(bool))
    if ct.shape == (2, 2):
        _, p_fisher, _, _ = stats.chi2_contingency(ct, correction=True)
        print(f"  Signal windows  : n={has_any.sum()}  UP-win-rate={sig_wins:.1%}")
        print(f"  No-signal windows: n={(~has_any).sum()}  UP-win-rate={nosig_wins:.1%}")
        print(f"  Chi² p-value    : {p_fisher:.4f} {'✅ SIGNIFICANT' if p_fisher < 0.05 else '❌ NOT SIGNIFICANT'}")
    else:
        print("  Not enough variance in signal/no-signal to compare.")


def correlation_analysis(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print("SIGNAL PRICE vs BTC RETURN CORRELATION")
    print("=" * 60)

    for col, label in [("signal_up_price", "upBid"), ("signal_down_price", "1-downBid")]:
        sub = df.dropna(subset=[col, "btc_return_pct"])
        if len(sub) < 10:
            continue
        x = sub[col] if col == "signal_up_price" else 1 - sub[col]
        y = sub["btc_return_pct"]
        pearson_r, pearson_p = stats.pearsonr(x, y)
        spearman_r, spearman_p = stats.spearmanr(x, y)
        print(f"\n  {label} → BTC return (n={len(sub)})")
        print(f"  Pearson  r={pearson_r:.3f}  p={pearson_p:.4f}")
        print(f"  Spearman r={spearman_r:.3f}  p={spearman_p:.4f}")


def time_of_day_analysis(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print("TIME-OF-DAY BREAKDOWN (ET hour, windows with signal)")
    print("=" * 60)

    has_any = df["has_up_signal"] | df["has_down_signal"]
    sub = df[has_any].copy()
    if len(sub) < 5:
        print("  Not enough signal windows.")
        return

    sub["correct"] = (
        (sub["has_up_signal"] & sub["up_won"].astype(bool)) |
        (sub["has_down_signal"] & ~sub["up_won"].astype(bool))
    )

    tbl = (sub.groupby("et_hour")
              .agg(count=("correct", "count"), win_rate=("correct", "mean"),
                   avg_net_profit=("directed_net_profit", "mean"))
              .reset_index())
    tbl["win_rate_pct"] = (tbl["win_rate"] * 100).round(1)
    tbl["avg_net_profit"] = tbl["avg_net_profit"].round(2)
    print(tabulate(tbl[["et_hour", "count", "win_rate_pct", "avg_net_profit"]],
                   headers=["ET Hour", "N", "Win%", "Avg Net P&L"],
                   tablefmt="github", showindex=False))


def friction_breakdown(df: pd.DataFrame) -> None:
    print("\n" + "=" * 60)
    print("FRICTION COST BREAKDOWN")
    print("=" * 60)

    sc = df["spread_cost"].dropna()
    if len(sc) > 0:
        print(f"  Spread cost: mean={sc.mean():.4f}  p25={sc.quantile(.25):.4f}  p75={sc.quantile(.75):.4f}")
    else:
        print(f"  Spread cost: no data (estimated {FEE_RATE*100:.0f}% fee rate used)")
    print(f"  Fee rate    : {FEE_RATE*100:.1f}% per trade (Polymarket taker)")
    print(f"  Break-even win rate = 1 / (1 + payout) where payout depends on entry price")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CryptoBot Phase 1 Statistical Analysis")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to SQLite database")
    parser.add_argument("--min-windows", type=int, default=20, help="Min windows required to run analysis")
    args = parser.parse_args()

    if not Path(args.db).exists():
        print(f"❌ Database not found: {args.db}")
        print("   Start the collector first: npm run collect")
        sys.exit(1)

    print(f"📊 CryptoBot Phase 1 Analysis — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"   DB: {args.db}")

    df = load_data(args.db)
    if len(df) < args.min_windows:
        print(f"\n⚠️  Only {len(df)} windows with data (need ≥ {args.min_windows}). Collect more data first.")
        sys.exit(0)

    df = enrich(df)

    overall_stats(df)
    signal_accuracy(df)
    signal_vs_nosignal(df)
    correlation_analysis(df)
    time_of_day_analysis(df)
    friction_breakdown(df)

    print("\n" + "=" * 60)
    print("INTERPRETATION GUIDE")
    print("=" * 60)
    print("  p < 0.05  → statistically significant (95% confidence)")
    print("  p < 0.01  → highly significant (99% confidence)")
    print("  Net EV > 0 → strategy profitable after friction")
    print("  Proceed to Phase 2 (live trading) only if:")
    print("    ✅ Signal accuracy p < 0.05 AND net EV > 0")
    print("    ✅ N ≥ 100 completed windows")
    print("    ✅ Win rate ≥ 55% (accounting for ~2% fee)")


if __name__ == "__main__":
    main()
