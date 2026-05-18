"""
Kronos prediction microservice for CryptoBot.
POST /predict  { candles: [{open,high,low,close,volume,ts},...] }
→ { prob_up: 0.62, predicted_close: 78500.1, current_close: 78400.0, ok: true }

Uses Kronos-mini (4.1M params, CPU-only) to predict next 15 1-minute candles,
then derives UP/DOWN probability from predicted close vs current close.
"""

import sys
import os
import math
import logging
import threading
from typing import List, Optional

import numpy as np
import pandas as pd
import torch

# Add Kronos to path
KRONOS_DIR = os.path.join(os.path.dirname(__file__), "Kronos")
sys.path.insert(0, KRONOS_DIR)

from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

from http.server import BaseHTTPRequestHandler, HTTPServer
import json

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("kronos_server")

# ── Config ────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("KRONOS_PORT", "8766"))
TOKENIZER_MODEL = "/opt/kronos_service/models/tokenizer"
PREDICTOR_MODEL = "/opt/kronos_service/models/predictor"
MAX_CONTEXT = 200          # use last 200 candles as context (well within 2048 limit)
PRED_LEN = 15              # predict next 15 minutes
SAMPLE_COUNT = 3           # average over 3 samples for stability
EDGE_SCALE = 200.0          # sigmoid scaling: 1% price move → ~0.5 prob delta

# ── Model loading ─────────────────────────────────────────────────────────────
predictor: Optional[KronosPredictor] = None
model_lock = threading.Lock()
model_ready = False

def load_model():
    global predictor, model_ready
    log.info("Loading Kronos-mini model (this may take a minute)...")
    try:
        tokenizer = KronosTokenizer.from_pretrained(TOKENIZER_MODEL)
        model = Kronos.from_pretrained(PREDICTOR_MODEL)
        predictor = KronosPredictor(model, tokenizer, device="cpu", max_context=MAX_CONTEXT)
        model_ready = True
        log.info("Kronos-mini loaded OK")
    except Exception as e:
        log.error(f"Failed to load model: {e}")

# Load in background thread so server starts fast
threading.Thread(target=load_model, daemon=True).start()

# ── Prediction logic ──────────────────────────────────────────────────────────

def candles_to_df(candles: List[dict]):
    """Convert raw candle dicts to DataFrame expected by KronosPredictor."""
    df = pd.DataFrame(candles)
    df["timestamps"] = pd.to_datetime(df["ts"], unit="ms")
    df = df.rename(columns={"volume": "volume"})
    # Ensure required columns exist
    for col in ["open", "high", "low", "close", "volume"]:
        if col not in df.columns:
            df[col] = 0.0
    df["amount"] = df["volume"] * df[["open", "high", "low", "close"]].mean(axis=1)
    df = df.sort_values("timestamps").reset_index(drop=True)
    return df

def predict_direction(candles: List[dict]) -> dict:
    """
    Run Kronos inference.
    Returns { prob_up, predicted_close, current_close, ok, error? }
    """
    if not model_ready or predictor is None:
        return {"ok": False, "error": "model_not_ready"}

    if len(candles) < 30:
        return {"ok": False, "error": "not_enough_candles"}

    try:
        df = candles_to_df(candles)
        lookback = min(len(df), MAX_CONTEXT)
        df_ctx = df.iloc[-lookback:].reset_index(drop=True)
        x_ts = df_ctx["timestamps"]

        # Build future timestamps (next PRED_LEN minutes)
        last_ts = df_ctx["timestamps"].iloc[-1]
        interval = pd.Timedelta(minutes=1)
        y_ts = pd.Series([last_ts + interval * (i + 1) for i in range(PRED_LEN)])

        with model_lock:
            pred_df = predictor.predict(
                df=df_ctx[["open", "high", "low", "close", "volume", "amount"]],
                x_timestamp=x_ts,
                y_timestamp=y_ts,
                pred_len=PRED_LEN,
                T=0.8,
                top_p=0.9,
                sample_count=SAMPLE_COUNT,
                verbose=False,
            )

        current_close = float(df_ctx["close"].iloc[-1])
        predicted_close = float(pred_df["close"].iloc[-3:].mean())  # endpoint avg, preserves direction

        # Convert price delta to probability via sigmoid
        # price_delta_pct > 0 → UP, magnitude determines confidence
        price_delta_pct = (predicted_close - current_close) / current_close * 100
        prob_up = 1.0 / (1.0 + math.exp(-price_delta_pct * EDGE_SCALE / 100))

        return {
            "ok": True,
            "prob_up": round(prob_up, 4),
            "predicted_close": round(predicted_close, 2),
            "current_close": round(current_close, 2),
            "price_delta_pct": round(price_delta_pct, 4),
        }

    except Exception as e:
        log.error(f"Prediction error: {e}")
        return {"ok": False, "error": str(e)}


# ── HTTP server ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default access log

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": model_ready}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/predict":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            candles = data.get("candles", [])
            result = predict_direction(candles)
        except Exception as e:
            result = {"ok": False, "error": str(e)}

        resp = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(resp)


def main():
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    log.info(f"Kronos service listening on :{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
