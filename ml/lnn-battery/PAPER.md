# Forecast-Driven Home Battery Optimisation with a Liquid Neural Network

## A retrospective comparison with Amber Electric SmartShift and price-blind self-consumption

**Technical case study — Kinkora residential energy system, Australia**  
**25 July 2026**

### Abstract

Residential batteries exposed to wholesale electricity prices face a sequential decision problem whose
best present action depends on uncertain future demand, photovoltaic generation, and tariffs. This
paper evaluates a compact liquid neural network as the forecasting component of a model-predictive
battery controller. A closed-form continuous-time (CfC) network with 24 liquid neurons and 14,176
trainable parameters was
trained on 30-minute observations from one Australian home. From 96 hours of history it directly
forecast 48 hours of solar generation, load, import price, and export price. Every forecast was supplied
to the same linear-programming controller and assessed using realised tariffs and physical power flows.

On the held-out period, the CfC controller cost \$583.96, compared with \$613.29 for the home’s recorded
incumbent operation under Amber Electric SmartShift, \$845.84 for a price-blind self-consumption rule,
and \$528.78 for a perfect-forecast oracle. The simulated CfC policy reduced cost by \$29.33
(4.78%) relative to the incumbent and by \$261.88 (30.96%) relative to the dumb rule. However,
a same-time-previous-day forecast cost \$590.81, only \$6.85 more than CfC, and the bootstrap confidence
interval for that marginal advantage included zero. The result therefore supports forecast-aware
optimisation over naive self-consumption, but does not establish a general or uniquely liquid-network
advantage. The study also shows why evaluating forecasts through economic dispatch, rather than forecast
error alone, is essential.

**Keywords:** liquid neural network; closed-form continuous-time network; home battery; photovoltaic
generation; model predictive control; dynamic electricity tariff; SmartShift; energy forecasting

## 1. Introduction

Rooftop solar and residential battery systems transform a household from a passive consumer into a
small energy trader. The household may pay or be paid to import, earn revenue by exporting, or incur a
cost by exporting during a negative feed-in interval. A battery moves energy between intervals subject
to efficiency, power, capacity, reserve, and inverter constraints. Consequently, “use solar first” is
not an economically complete policy: grid charging can be rational, stored energy can avoid a later
spike, battery export can exceed the value of self-consumption, and storing solar sacrifices immediate
feed-in revenue.

The controller must make these choices before future prices, solar output, and load are known. Model
predictive control (MPC) provides a practical framework: forecast a finite horizon, optimise the
corresponding power flows, execute only the first action, then repeat with new observations. This
receding-horizon pattern combines explicit physical constraints with refreshed predictions [1]. Its
quality depends on both forecast accuracy and the economic sensitivity of the resulting actions.

Liquid neural networks are an appealing candidate for the forecasting component. Liquid time-constant
networks model hidden-state dynamics in continuous time [2]. Their closed-form continuous-time
descendant, CfC, approximates those dynamics without repeatedly invoking a numerical differential
equation solver, retaining explicit time dependence with recurrent-network-like computational cost [3].
The resulting models can be compact and are intended for sequential and physical-dynamics problems. The
present work asks a deliberately applied question: can a small reference-implementation CfC extract
economically useful information from one home’s time series?

The contribution is an end-to-end retrospective evaluation, not a forecast leaderboard. CfC, cheap
causal forecasts, parameter-matched GRU/LSTM networks, and a perfect-forecast bound all drive the same
controller. They are compared with actual SmartShift-enabled operation and dumb self-consumption using
the same realised prices.

## 2. Background

### 2.1 Liquid neural networks and CfC

Liquid neural networks use state dynamics whose effective temporal response changes with the input. The
original liquid time-constant formulation uses ordinary differential equations [2]. CfC instead uses a
bounded closed-form approximation and interpolates between learned candidate states through a
time-dependent gate, avoiding a numerical ODE solve for each update [3].

This study uses the authors’ open-source `ncps` implementation, which supplies CfC and LTC layers for
PyTorch and TensorFlow [4]. “Twenty-four neurons” refers only to the recurrent liquid state. It does not
mean that the complete forecaster has 24 scalar parameters. At each of 192 recurrent steps, the
19-feature input is concatenated with the 24-state vector. A 43-to-32 dense backbone and four 32-to-24
branches generate two candidate states and the temporal gate components. Those shared recurrent weights
account for 4,576 parameters. A separate 24-to-384 output layer produces 96 horizons for four targets and
adds 9,600 parameters, yielding 14,176 in total. The architecture is dense CfC, not a sparse neural
circuit policy; compact state and parameter count are related but distinct concepts.

### 2.2 Forecast-aware battery control

MPC solves a forecast-conditioned plan at every decision point and commits only its first action before
re-solving [1]. Prescient optimisation is infeasible in deployment but provides a bound. Prior
photovoltaic-battery research finds that forecast value depends on feed-in tariffs and export limits and
that simple historical load patterns can be strong predictors [5], motivating both the oracle and
same-time-yesterday baselines.

Amber Electric’s SmartShift is itself forecast-aware. Amber describes a personalised site-flow model
that uses forecasts of wholesale price, solar production, and household consumption to minimise cost
over a 24-hour horizon, with plans continually recalculated as conditions change [6]. Its advanced price
forecast combines market pre-dispatch information with weather, actual demand patterns, and historical
prices, and was designed with CSIRO [7]. SmartShift also accounts for charging and discharging losses and
may charge cheaply for later self-consumption or export [6]. It is therefore a strong real-world
comparator, not a naive baseline.

The experiment has settled prices but not SmartShift’s historical forecast vintages or plans. Meter flow
also cannot separate remote commands from fast local battery behaviour. “Actual SmartShift” therefore
means observed incumbent operation while SmartShift was active, not a replay of Amber’s algorithm.

## 3. Data and methods

### 3.1 Site data and reconstruction

The Kinkora dataset’s longest complete physical and settled-price interval extends from 19 October 2025
to 25 July 2026: 13,411 half-hour observations. It contains two solar arrays, battery and grid power,
reconstructed load, Amber tariffs, and stored energy. Because measured percentage state of charge has a
long gap, a continuous offline coulomb-counted `stored_kwh` proxy was used. No operational data were
modified.

Signs were normalised so grid flow \(g_t>0\) denotes import and \(g_t<0\) denotes export. Battery power
is positive when discharging in the source data. Household load was reconstructed using the verified
site balance

\[
  \mathrm{load}_t=\mathrm{solar}_t+\mathrm{grid}_t+\mathrm{battery}_t.
\]

Daily battery parameters were taken from the existing physical fold: usable capacity varied from
approximately 21 to 34 kWh, charge efficiency from 0.97 to 1.00, idle loss from 0.43 to
1.02 kWh/day, and the learned reserve floor from 5% to 10%. Maximum battery power was set to 8.5 kW
from observed operation. Counterfactual policies shared a 12.5 kW site-export limit.

### 3.2 Forecasting task

At each forecast origin, the models received the preceding 96 hours (192 half-hour samples) and directly
predicted the next 48 hours (96 samples). The four targets were solar energy, household-load energy,
import price, and export price. Nineteen input features comprised current values for those four series,
their same-time-previous-day values, their same-time-previous-week values, and seven cyclical calendar
features encoding hour, weekday, annual position, and weekend status.

The data were divided chronologically into 60% training, 20% validation, and 20% test regions. A
one-week purge/embargo prevented an explicit lag or forecast target from crossing a split boundary. The
held-out forecast origins ran from 7 June to 23 July 2026 UTC and produced 48 local-day cost buckets.
Normalisation and clipping bounds used training data only. Training used AdamW, Smooth L1 loss, gradient
clipping, validation-based early stopping, and a fixed seed.

The principal model was the 24-state CfC described above. For architectural controls, a GRU with 14,034
parameters and an LSTM with 13,920 parameters were selected to approximately match the CfC’s 14,176
parameters. Causal non-neural forecasts included persistence, recursive repetition of the previous day,
and recursive repetition of the previous week. Forecast accuracy was reported using mean absolute
scaled error (MASE), scaled by the training-period absolute same-time-previous-day difference.

### 3.3 Rolling dispatch optimisation

Every forecast drove the same 48-hour linear program, recomputed every 30 minutes. Only its first
charge, discharge, and curtailment decisions were applied to realised net load. Simulated state evolved
continuously rather than resetting daily. The first interval used observed net load and tariff;
forecasts affected the look-ahead.

For battery-terminal charge \(c_t\), discharge \(d_t\), solar curtailment \(u_t\), exogenous net load
\(n_t=\mathrm{load}_t-\mathrm{solar}_t\), and charge efficiency \(\eta_c\), the main relationships were

\[
  g_t=n_t+u_t+c_t-d_t
\]

and

\[
  s_{t+1}=s_t+\eta_c c_t-d_t-\ell_t,
\]

where \(s_t\) is stored energy and \(\ell_t\) is idle loss. Capacity, reserve, export-power, and shared
charge/discharge-throughput constraints were enforced. A terminal constraint required the 48-hour plan
to finish with at least its initial stored energy, preventing artificial gains from repeatedly valuing
or depleting unscored horizon-end inventory.

Realised energy cash cost was

\[
  C=\sum_t\left[p^{\mathrm{imp}}_t\max(g_t,0)
  -p^{\mathrm{exp}}_t\max(-g_t,0)\right].
\]

This expression captures all economically important sign cases. A negative import price makes charging
from the grid profitable before future use is considered. Charging from excess solar reduces export and
therefore incurs the opportunity cost \(p^{\mathrm{exp}}_t\) whenever the feed-in tariff is positive.
Exporting stored battery energy earns that same tariff. If the export tariff is negative, exporting
creates a positive cost; the counterfactual inverter may instead curtail solar, and the optimiser is
forbidden from producing net export in that interval. Rare forecast intervals in which the export rate
exceeded the import rate were clamped to preserve the convex planning formulation, while final scoring
always used the unmodified realised rates.

### 3.4 Comparators and evaluation

The **recorded incumbent** is actual grid flow under the SmartShift-enabled site, priced at settled
Amber rates. It includes real device imperfections and was not given counterfactual curtailment.

The **dumb algorithm** is price-blind greedy self-consumption. It charges from contemporaneous surplus
solar until limited by battery capacity or power and discharges against contemporaneous positive net
load until limited by reserve or power. It never anticipates prices, deliberately charges from the grid,
or deliberately exports the battery. It is physically useful but economically unaware.

The **oracle** uses future realised solar, load, and tariffs in the same optimiser. It estimates a
model-specific lower bound. Daily differences were resampled 10,000 times for indicative 95% bootstrap
intervals; these do not imply certainty for other homes or seasons.

## 4. Results

### 4.1 Forecast accuracy

| Model | Solar MASE | Load MASE | Import-price MASE | Export-price MASE |
|---|---:|---:|---:|---:|
| CfC | 1.343 | 1.802 | 1.392 | 1.256 |
| GRU | 1.292 | 1.777 | 1.418 | 1.196 |
| LSTM | 1.372 | 1.764 | 1.437 | 1.245 |
| Persistence | 1.120 | 2.484 | 2.397 | 1.298 |
| Previous day | **0.434** | 1.939 | **1.334** | 1.331 |
| Previous week | 0.525 | 2.208 | 1.903 | 1.887 |

No model dominated. Previous-day repetition was strongest for solar and slightly beat CfC on import
price. GRU had the best export-price MASE and LSTM the best load MASE among neural models. These rankings
did not map directly to dispatch value, which is sensitive to errors near price extremes and physical
boundaries.

### 4.2 Held-out economic performance

| Policy | Realised cost | Saving vs recorded incumbent | Curtailed solar |
|---|---:|---:|---:|
| Perfect-forecast oracle | **\$528.78** | **\$84.50** | 0.00 kWh |
| CfC + MPC | **\$583.96** | **\$29.33** | 15.34 kWh |
| Previous-day + MPC | \$590.81 | \$22.48 | 41.32 kWh |
| Recorded incumbent / SmartShift-enabled site | \$613.29 | — | 0.00 kWh* |
| GRU + MPC | \$620.79 | -\$7.50 | 29.16 kWh |
| Previous-week + MPC | \$635.81 | -\$22.52 | 58.42 kWh |
| LSTM + MPC | \$712.00 | -\$98.72 | 17.11 kWh |
| Dumb self-consumption | \$845.84 | -\$232.55 | 0.00 kWh |
| No battery | \$923.94 | -\$310.65 | 298.01 kWh |

\*Recorded operation was left untouched; counterfactual curtailment was not imputed to it.

CfC reduced held-out cost by 4.78% relative to recorded operation and captured 34.71% of the
\$84.50 oracle headroom. It reduced cost by 30.96% relative to dumb self-consumption. Conversely, the
dumb rule cost 37.92% more than the incumbent and recovered only 8.45% of the no-battery cost. The
CfC advantage over the strong previous-day policy was just \$6.85, or 1.16%.

CfC’s mean saving over actual was \$0.61/day, with a day-bootstrap 95% interval of \$0.06 to \$1.21.
The previous-day controller saved \$0.47/day (interval -\$0.23 to \$1.22), and the oracle saved
\$1.76/day (interval \$1.10 to \$2.52). Most importantly for a liquid-network claim, CfC’s marginal
advantage over previous-day forecasting was \$0.14/day with an interval from -\$0.41 to \$0.70. That
result is economically positive in this sample but statistically inconclusive.

Across 278 complete days in the full nine-month window, the recorded battery cost \$1,646.22 versus
\$2,917.85 without a battery, a \$1,271.63 or 43.58% reduction. Dumb self-consumption cost \$2,030.54,
whereas the previous-day MPC cost \$1,608.32, \$37.90 below recorded operation. The full-window oracle
cost \$1,303.54, leaving \$342.68 of modelled headroom. Neural performance is not reported on this
full window because it contains training and validation data.

## 5. Discussion

### 5.1 What was actually achieved

Within the simulation, the 24-liquid-neuron forecast found \$29.33 more held-out value than the metered
incumbent and \$261.88 more than price-blind self-consumption, with no solver failures. Meter-derived
daily costs reconciled closely with Amber billing (correlation 0.987; mean absolute difference
\$0.26/day; mean bias -\$0.11/day). All strategy comparisons used one meter frame.

This does not show general superiority to SmartShift, a production system with richer inputs,
personalised device modelling, monitoring, and CSIRO-assisted price forecasts [6,7]. Historical
settings, forecast vintages, outages, overrides, and product version were not preserved. Current
documentation also says direct grid export is not commanded below 25% state of charge [9], whereas the
counterfactual used the learned 5–10% floor for all discharge. If that rule applied during the study,
some simulated advantage may reflect greater battery access rather than better forecasting.

The result is site-specific: under stated constraints, CfC would have beaten the recorded outcome.
A product claim requires an online shadow trial or crossover with identical information, reserves,
cycling policies, and preserved forecasts and actions.

### 5.2 Why the dumb algorithm loses

Greedy self-consumption recognises energy balance but not time value. It may fill the battery with solar
that could have been exported at a high rate, leaving no room to be paid for importing during a later
negative-price interval. It may discharge into an ordinary evening load shortly before an exceptional
price spike. It cannot grid-charge in anticipation of expensive demand, and it cannot deliberately
export stored energy. Its only objective is to reduce simultaneous grid exchange.

The rule still beat no battery by 8.45% held out and 30.41% over the full window. Its relative weakness
shows that maximising photovoltaic self-consumption is not equivalent to minimising cash cost.

### 5.3 What the LNN did—and did not—contribute

CfC compresses multivariate history into a 24-dimensional state decoded into 384 forecasts. Its temporal
gating is a plausible bias for physical and market signals, while measured inference was only
0.311 ms/origin.

Parameter-matched GRU/LSTM models had similar aggregate errors but worse dispatch, while previous-day
repetition nearly matched CfC at zero training cost. The result supports the CfC-plus-MPC system, not
universal superiority of liquid recurrence. Repeated seeds, homes, and seasons are needed to isolate an
architecture effect.

## 6. Limitations and future work

First, this is a single-site, nine-month retrospective study with only the final 20% used for untouched
neural evaluation. Conditions may differ in another year, and day-bootstrap intervals simplify
inter-day state dependence.

Second, stored energy was reconstructed, power aggregated to 30 minutes, and battery parameters
estimated. Degradation and cycle cost were omitted, potentially favouring aggressive arbitrage over a
production controller with warranty preferences [8].

Third, the simulation assumes controllable curtailment. Production faces latency, API limits, inverter
modes, and fail-safes absent from a half-hour simulation. Amber also notes that SmartShift may export
early to make capacity before negative-price periods [10].

Fourth, CfC received no numerical weather forecast, AEMO bids, outage data, or future tariff forecast,
while SmartShift uses wider signals [7]. Preserved causal irradiance and market forecast vintages could
support probabilistic or robust MPC.

Finally, training minimised forecast error rather than cash. Decision-focused loss or price-spike
probabilities are natural extensions, while evaluation should retain physical constraints, an oracle,
cheap seasonal controls, recurrent controls, and the incumbent.

## 7. Conclusion

This case study demonstrates a credible application of a liquid neural network to residential energy
management. A 24-state CfC forecast four coupled time series and drove a transparent rolling optimiser
that explicitly valued negative charging prices, foregone solar exports, battery exports, efficiency,
curtailment, reserve, and power limits. On held-out data it cost \$583.96: \$29.33 less than recorded
SmartShift-enabled operation and \$261.88 less than dumb self-consumption.

The strongest scientific conclusion is not that CfC defeated SmartShift. The recorded comparison is
observational, the product’s historical information set cannot be reconstructed, and the CfC exceeded a
simple previous-day controller by only \$6.85 with an inconclusive confidence interval. Rather, the
study shows that forecast-aware constrained control materially outperforms price-blind battery use, and
that a very small liquid recurrent state can participate effectively in such a system. The next
decisive experiment is a prospective shadow deployment with matched constraints and preserved forecast
vintages.

## References

1. D. Perez-Pineiro, S. Skogestad, and S. Boyd, “[Home Energy Management with Dynamic Tariffs and
   Tiered Peak Power Charges](https://web.stanford.edu/~boyd/papers/hem.html),” 2023.
2. R. Hasani, M. Lechner, A. Amini, D. Rus, and R. Grosu, “[Liquid Time-constant
   Networks](https://arxiv.org/abs/2006.04439),” *Proceedings of the AAAI Conference on Artificial
   Intelligence*, 2021.
3. R. Hasani et al., “[Closed-form continuous-time neural
   networks](https://www.nature.com/articles/s42256-022-00556-7),” *Nature Machine Intelligence*,
   vol. 4, pp. 992–1003, 2022.
4. M. Lechner et al., “[ncps: PyTorch and TensorFlow implementation of NCP, LTC, and CfC wired neural
   models](https://github.com/mlech26l/ncps),” GitHub repository.
5. G. B. M. A. Litjens, E. Worrell, and W. G. J. H. M. van Sark, “[Assessment of forecasting methods
   on performance of photovoltaic-battery
   systems](https://doi.org/10.1016/j.apenergy.2018.03.154),” *Applied Energy*, vol. 221,
   pp. 358–373, 2018.
6. Amber Electric, “[How does SmartShift
   work?](https://help.amber.com.au/hc/en-us/articles/10014159451405-How-does-SmartShift-work),”
   accessed 25 July 2026.
7. Amber Electric, “[How Amber’s Advanced Price Forecasts
   work](https://help.amber.com.au/hc/en-us/articles/28605992738445-How-Amber-s-Advanced-Price-Forecasts-work),”
   accessed 25 July 2026.
8. Amber Electric, “[What’s the difference between Amber for Batteries’ two automation
   modes?](https://help.amber.com.au/hc/en-us/articles/11206698728717-What-s-the-difference-between-Amber-for-Batteries-two-automation-modes),”
   accessed 25 July 2026.
9. Amber Electric, “[How much of my battery energy can Amber
   access?](https://help.amber.com.au/hc/en-us/articles/26733365644045-How-much-of-my-battery-energy-can-Amber-access),”
   accessed 25 July 2026.
10. Amber Electric, “[How Amber for Batteries optimises your battery to take negative pricing into
    consideration](https://help.amber.com.au/hc/en-us/articles/30478903692429-How-Amber-for-Batteries-optimises-your-battery-to-take-negative-pricing-into-consideration),”
    accessed 25 July 2026.

---

*This is a technical case-study manuscript, not a peer-reviewed publication. All product descriptions
refer to public Amber Electric documentation available on 25 July 2026. “SmartShift” is a trademark of
Amber Electric Pty Ltd.*
