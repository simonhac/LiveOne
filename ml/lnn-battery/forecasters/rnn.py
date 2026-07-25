"""GRU/LSTM controls with the same direct multi-horizon head as the CfC."""
from __future__ import annotations

import torch
from torch import nn


class RNNDirect(nn.Module):
    def __init__(self, kind: str, input_size: int, hidden_size: int, horizon: int, targets: int):
        super().__init__()
        cls = {"gru": nn.GRU, "lstm": nn.LSTM}[kind]
        self.encoder = cls(input_size, hidden_size, batch_first=True)
        self.head = nn.Linear(hidden_size, horizon * targets)
        self.horizon = horizon
        self.targets = targets

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        _, state = self.encoder(x)
        hidden = state[0] if isinstance(state, tuple) else state
        return self.head(hidden[-1]).reshape(-1, self.horizon, self.targets)
