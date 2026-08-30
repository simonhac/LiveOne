"""Leakage-safe supervised dataset for direct multi-horizon forecasting."""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import pandas as pd

from common import AEST_H, load

TARGETS = ("solar_kwh", "load_kwh", "import_c", "export_c")
WINDOW = 192       # 96 hours at 30-minute cadence
HORIZON = 96       # 48 hours; the rolling controller re-plans every 30 minutes
DAY_LAG = 48
WEEK_LAG = 336
EMBARGO = WEEK_LAG


@dataclass
class ForecastData:
    frame: pd.DataFrame
    features: np.ndarray
    target_scaled: np.ndarray
    target_mean: np.ndarray
    target_std: np.ndarray
    train_origins: np.ndarray
    val_origins: np.ndarray
    test_origins: np.ndarray

    def arrays(self, origins: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Materialise history windows and future targets for a set of forecast origins."""
        x = np.stack([self.features[i - WINDOW + 1:i + 1] for i in origins]).astype("float32")
        y = np.stack([self.target_scaled[i + 1:i + 1 + HORIZON] for i in origins]).astype("float32")
        return x, y

    def unscale(self, values: np.ndarray) -> np.ndarray:
        return values * self.target_std + self.target_mean


def _calendar(index: pd.DatetimeIndex) -> np.ndarray:
    local = index + pd.Timedelta(hours=AEST_H)
    hour = local.hour.to_numpy() + local.minute.to_numpy() / 60.0
    dow = local.dayofweek.to_numpy()
    doy = local.dayofyear.to_numpy()
    return np.column_stack([
        np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24),
        np.sin(2 * np.pi * dow / 7), np.cos(2 * np.pi * dow / 7),
        np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
        (dow >= 5).astype(float),
    ]).astype("float32")


def prepare(train_stride: int = 2) -> ForecastData:
    frame, _ = load()
    values = frame.loc[:, TARGETS].to_numpy(dtype="float32")
    good = np.isfinite(values).all(axis=1)
    # The extract deliberately includes partial boundary days. Select the longest contiguous complete
    # target run rather than silently imputing prices or hard-coding a date.
    runs: list[tuple[int, int]] = []
    start = None
    for i, ok in enumerate(good):
        if ok and start is None:
            start = i
        if start is not None and (not ok or i == len(good) - 1):
            end = i if ok and i == len(good) - 1 else i - 1
            runs.append((start, end))
            start = None
    if not runs:
        raise ValueError("forecast frame has no complete rows")
    lo, hi = max(runs, key=lambda pair: pair[1] - pair[0])
    frame = frame.iloc[lo:hi + 1].copy()
    values = frame.loc[:, TARGETS].to_numpy(dtype="float32")

    n = len(frame)
    train_boundary = int(n * 0.60)
    val_boundary = int(n * 0.80)
    first_origin = WEEK_LAG + WINDOW - 1

    # Targets from every training sample end before the split. Validation/test start after a full
    # one-week embargo, longer than every explicit lag, so no target window straddles a boundary.
    train_origins = np.arange(first_origin, train_boundary - HORIZON, train_stride)
    val_origins = np.arange(train_boundary + EMBARGO, val_boundary - HORIZON)
    test_origins = np.arange(val_boundary + EMBARGO, n - HORIZON)
    if min(len(train_origins), len(val_origins), len(test_origins)) == 0:
        raise ValueError("not enough history for the requested walk-forward splits")

    target_mean = values[:train_boundary].mean(axis=0)
    target_std = values[:train_boundary].std(axis=0)
    target_std[target_std < 1e-6] = 1.0
    scaled = (values - target_mean) / target_std

    lag_day = np.empty_like(scaled)
    lag_week = np.empty_like(scaled)
    lag_day[:DAY_LAG] = scaled[:DAY_LAG]
    lag_day[DAY_LAG:] = scaled[:-DAY_LAG]
    lag_week[:WEEK_LAG] = scaled[:WEEK_LAG]
    lag_week[WEEK_LAG:] = scaled[:-WEEK_LAG]
    features = np.column_stack([scaled, lag_day, lag_week, _calendar(frame.index)]).astype("float32")

    return ForecastData(
        frame=frame,
        features=features,
        target_scaled=scaled.astype("float32"),
        target_mean=target_mean,
        target_std=target_std,
        train_origins=train_origins,
        val_origins=val_origins,
        test_origins=test_origins,
    )
