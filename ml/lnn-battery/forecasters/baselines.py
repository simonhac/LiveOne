"""Causal persistence, yesterday, and last-week forecast baselines."""
from __future__ import annotations

import numpy as np
from forecasters.data import DAY_LAG, HORIZON, WEEK_LAG


def predict(values: np.ndarray, origins: np.ndarray, kind: str) -> np.ndarray:
    out = []
    lag = {"seasonal_day": DAY_LAG, "seasonal_week": WEEK_LAG}.get(kind)
    for i in origins:
        if kind == "persistence":
            out.append(np.repeat(values[i][None, :], HORIZON, axis=0))
        elif lag is not None:
            offsets = np.arange(1, HORIZON + 1)
            if kind == "seasonal_day":
                # Recursively repeat the last fully observed day. A direct `target - 48` lookup would
                # leak the first forecast day while predicting the second.
                idx = i + offsets - DAY_LAG * np.ceil(offsets / DAY_LAG).astype(int)
            else:
                idx = i + offsets - lag
            if idx.max() > i:
                raise AssertionError(f"{kind} attempted to read beyond forecast origin")
            out.append(values[idx])
        else:
            raise ValueError(f"unknown baseline {kind}")
    return np.asarray(out, dtype="float32")
