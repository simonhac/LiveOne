# CfC neural-network connectivity

This is the exact fully connected `ncps` CfC used by `CfCDirect`. Dimensions omit the batch axis.
Weights inside the CfC cell are shared across all 192 recurrent steps.

```mermaid
flowchart LR
    subgraph INPUTS["Input sequence — 96 hours × 30-minute cadence"]
        CURRENT["Current values<br/>solar, load, import price, export price<br/><b>4</b>"]
        DAY["Same-time previous-day lags<br/><b>4</b>"]
        WEEK["Same-time previous-week lags<br/><b>4</b>"]
        CAL["Calendar encoding<br/>hour sin/cos, weekday sin/cos,<br/>year sin/cos, weekend<br/><b>7</b>"]
        CURRENT --> XT["Feature vector x(t)<br/><b>19</b>"]
        DAY --> XT
        WEEK --> XT
        CAL --> XT
        XT --> SEQ["Sequence x(1)…x(192)<br/><b>192 × 19</b>"]
    end

    subgraph CELL["Shared CfC recurrent cell — repeated for t = 1…192"]
        H_PREV["Previous liquid state h(t−1)<br/><b>24 neurons</b><br/>h(0) = zeros"]
        CONCAT["Concatenate [x(t), h(t−1)]<br/><b>19 + 24 = 43</b>"]
        BACKBONE["Dense 43 → 32<br/>LeCun tanh<br/><b>1,408 parameters</b>"]

        FF1["Candidate 1<br/>Dense 32 → 24<br/>tanh"]
        FF2["Candidate 2<br/>Dense 32 → 24<br/>tanh"]
        TA["Time slope<br/>Dense 32 → 24"]
        TB["Time intercept<br/>Dense 32 → 24"]
        DT["Δt = 1<br/>uniform 30-minute step"]
        GATE["Temporal gate<br/>g(t) = sigmoid(time_a × Δt + time_b)<br/><b>24</b>"]
        BLEND["Closed-form interpolation<br/>h(t) = candidate1 × (1 − g)<br/>+ candidate2 × g"]
        H_NOW["New liquid state h(t)<br/><b>24 neurons</b>"]

        H_PREV --> CONCAT
        CONCAT --> BACKBONE
        BACKBONE --> FF1
        BACKBONE --> FF2
        BACKBONE --> TA
        BACKBONE --> TB
        TA --> GATE
        TB --> GATE
        DT --> GATE
        FF1 --> BLEND
        FF2 --> BLEND
        GATE --> BLEND
        BLEND --> H_NOW
        H_NOW -. "recurrent state for t+1" .-> H_PREV
    end

    SEQ -->|"one x(t) per recurrent step"| CONCAT
    H_NOW -->|"after step 192"| FINAL["Final state h(192)<br/><b>24</b>"]

    subgraph HEAD["Direct multi-horizon forecast head"]
        FINAL --> LINEAR["Dense 24 → 384<br/><b>9,600 parameters</b>"]
        LINEAR --> RESHAPE["Reshape<br/><b>96 horizons × 4 targets</b>"]
        RESHAPE --> SOLAR["Solar energy<br/>96 half-hour forecasts"]
        RESHAPE --> LOAD["Load energy<br/>96 half-hour forecasts"]
        RESHAPE --> IMPORT["Import tariff<br/>96 half-hour forecasts"]
        RESHAPE --> EXPORT["Export tariff<br/>96 half-hour forecasts"]
    end
```

## Parameter accounting

| Component | Connectivity | Parameters |
|---|---:|---:|
| CfC backbone | `43 → 32` | 1,408 |
| Candidate 1 | `32 → 24` | 792 |
| Candidate 2 | `32 → 24` | 792 |
| Time slope | `32 → 24` | 792 |
| Time intercept | `32 → 24` | 792 |
| **Shared CfC cell subtotal** | reused for all 192 steps | **4,576** |
| Direct forecast head | `24 → 384` | 9,600 |
| **Entire network** | | **14,176** |

The 24 recurrent-state units are the liquid neurons. The 32 backbone units and 384 output values are
ordinary feed-forward units, not additional liquid neurons. This model uses dense CfC connectivity,
not an `AutoNCP` sparse wiring.
