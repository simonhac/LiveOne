"""Small fully-connected CfC encoder using the reference `ncps` implementation."""
from __future__ import annotations

import torch
from torch import nn
from ncps.torch import CfC


class CfCDirect(nn.Module):
    def __init__(self, input_size: int, hidden_size: int, horizon: int, targets: int):
        super().__init__()
        self.encoder = CfC(
            input_size,
            hidden_size,
            return_sequences=False,
            batch_first=True,
            backbone_units=32,
            backbone_layers=1,
            backbone_dropout=0.0,
        )
        self.head = nn.Linear(hidden_size, horizon * targets)
        self.horizon = horizon
        self.targets = targets

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        encoded, _ = self.encoder(x)
        return self.head(encoded).reshape(-1, self.horizon, self.targets)
