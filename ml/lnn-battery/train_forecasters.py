#!/usr/bin/env python3
"""Train/evaluate CfC, GRU, and LSTM direct forecasters on leakage-safe temporal splits."""
from __future__ import annotations

import argparse
import os
import random
import time

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from forecasters.baselines import predict as baseline_predict
from forecasters.cfc import CfCDirect
from forecasters.data import HORIZON, TARGETS, prepare
from forecasters.rnn import RNNDirect

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")


def parameter_count(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def matched_rnn(kind: str, input_size: int, target_params: int) -> nn.Module:
    candidates = [
        RNNDirect(kind, input_size, h, HORIZON, len(TARGETS))
        for h in range(4, 65)
    ]
    return min(candidates, key=lambda m: abs(parameter_count(m) - target_params))


def predict_model(model: nn.Module, x: np.ndarray, batch_size: int) -> tuple[np.ndarray, float]:
    loader = DataLoader(TensorDataset(torch.from_numpy(x)), batch_size=batch_size)
    chunks = []
    model.eval()
    started = time.perf_counter()
    with torch.inference_mode():
        for (xb,) in loader:
            chunks.append(model(xb).cpu().numpy())
    elapsed = time.perf_counter() - started
    return np.concatenate(chunks), 1000.0 * elapsed / len(x)


def train_model(model: nn.Module, x_train: np.ndarray, y_train: np.ndarray,
                x_val: np.ndarray, y_val: np.ndarray, epochs: int,
                batch_size: int, patience: int) -> nn.Module:
    loader = DataLoader(
        TensorDataset(torch.from_numpy(x_train), torch.from_numpy(y_train)),
        batch_size=batch_size, shuffle=True,
    )
    xv, yv = torch.from_numpy(x_val), torch.from_numpy(y_val)
    optimiser = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    loss_fn = nn.SmoothL1Loss()
    best_loss, best_state, stale = float("inf"), None, 0

    for epoch in range(1, epochs + 1):
        model.train()
        running = 0.0
        for xb, yb in loader:
            optimiser.zero_grad(set_to_none=True)
            loss = loss_fn(model(xb), yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimiser.step()
            running += float(loss.detach()) * len(xb)
        model.eval()
        with torch.inference_mode():
            val_loss = float(loss_fn(model(xv), yv))
        print(f"    epoch {epoch:02d} train={running/len(x_train):.4f} val={val_loss:.4f}", flush=True)
        if val_loss < best_loss - 1e-5:
            best_loss = val_loss
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                print(f"    early stop after {epoch} epochs", flush=True)
                break
    if best_state is None:
        raise RuntimeError("training produced no checkpoint")
    model.load_state_dict(best_state)
    return model


def metric_rows(name: str, truth: np.ndarray, pred: np.ndarray,
                persistence_mae: np.ndarray, mase_scale: np.ndarray,
                params: int, latency_ms: float) -> list[dict]:
    rows = []
    for j, target in enumerate(TARGETS):
        mae = float(np.mean(np.abs(pred[..., j] - truth[..., j])))
        rows.append({
            "model": name,
            "target": target,
            "mae": mae,
            "mase": mae / mase_scale[j],
            "skill_vs_persistence_pct": 100.0 * (1.0 - mae / persistence_mae[j]),
            "parameters": params,
            "inference_ms_per_origin": latency_ms,
        })
    return rows


def run(args: argparse.Namespace) -> None:
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    os.makedirs(OUT, exist_ok=True)

    data = prepare(train_stride=args.train_stride)
    x_train, y_train = data.arrays(data.train_origins)
    x_val, y_val = data.arrays(data.val_origins)
    x_test, y_test_scaled = data.arrays(data.test_origins)
    truth = data.unscale(y_test_scaled)
    raw = data.frame.loc[:, TARGETS].to_numpy(dtype="float32")
    print(
        f"samples train/val/test={len(x_train)}/{len(x_val)}/{len(x_test)}  "
        f"input={x_train.shape[1:]} horizon={HORIZON}",
        flush=True,
    )

    predictions: dict[str, np.ndarray] = {}
    for name in ("persistence", "seasonal_day", "seasonal_week"):
        predictions[name] = baseline_predict(raw, data.test_origins, name)

    persistence_mae = np.mean(np.abs(predictions["persistence"] - truth), axis=(0, 1))
    train_values = raw[:int(len(raw) * 0.60)]
    mase_scale = np.mean(np.abs(train_values[48:] - train_values[:-48]), axis=0)
    mase_scale = np.maximum(mase_scale, 1e-6)
    rows: list[dict] = []
    for name in ("persistence", "seasonal_day", "seasonal_week"):
        rows += metric_rows(name, truth, predictions[name], persistence_mae, mase_scale, 0, 0.0)

    input_size = x_train.shape[-1]
    cfc = CfCDirect(input_size, args.cfc_hidden, HORIZON, len(TARGETS))
    target_params = parameter_count(cfc)
    builders = {
        "cfc": lambda: cfc,
        "gru": lambda: matched_rnn("gru", input_size, target_params),
        "lstm": lambda: matched_rnn("lstm", input_size, target_params),
    }
    for name in args.models:
        model = builders[name]()
        nparams = parameter_count(model)
        print(f"\n{name.upper()} parameters={nparams:,}", flush=True)
        model = train_model(
            model, x_train, y_train, x_val, y_val,
            epochs=args.epochs, batch_size=args.batch_size, patience=args.patience,
        )
        pred_scaled, latency = predict_model(model, x_test, args.batch_size)
        pred = data.unscale(pred_scaled)
        predictions[name] = pred.astype("float32")
        rows += metric_rows(name, truth, pred, persistence_mae, mase_scale, nparams, latency)
        torch.save({
            "state_dict": model.state_dict(),
            "input_size": input_size,
            "horizon": HORIZON,
            "targets": TARGETS,
            "target_mean": data.target_mean,
            "target_std": data.target_std,
        }, os.path.join(OUT, f"{name}.pt"))
        print(f"    test inference={latency:.3f} ms/origin", flush=True)

    metrics = pd.DataFrame(rows)
    metrics.to_csv(os.path.join(OUT, "forecast_metrics.csv"), index=False)
    payload = {
        "origins": data.test_origins,
        "timestamps_ns": data.frame.index.asi8,
        "targets": np.asarray(TARGETS),
        "truth": truth.astype("float32"),
    }
    payload.update({f"pred_{k}": v for k, v in predictions.items()})
    np.savez_compressed(os.path.join(OUT, "forecast_predictions.npz"), **payload)

    print("\nTest metrics (MASE; lower is better):")
    print(metrics.pivot(index="model", columns="target", values="mase").round(3).to_string())
    print("\nwrote out/forecast_metrics.csv and out/forecast_predictions.npz")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", choices=["cfc", "gru", "lstm"],
                    default=["cfc", "gru", "lstm"])
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--batch-size", type=int, default=64)
    ap.add_argument("--train-stride", type=int, default=2)
    ap.add_argument("--cfc-hidden", type=int, default=24)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--seed", type=int, default=7)
    run(ap.parse_args())
