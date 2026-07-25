from __future__ import annotations

import os
import sys
import unittest

import numpy as np
import torch

HERE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from battery_model import BatteryParams, step
from forecasters.baselines import predict
from forecasters.cfc import CfCDirect
from forecasters.rnn import RNNDirect
from optimiser import realised_cost_c, solve_dispatch


class BatteryPhysicsTest(unittest.TestCase):
    def test_step_uses_charge_efficiency_and_idle(self):
        p = BatteryParams(10.0, 0.9, 0.24, 10.0)
        self.assertAlmostEqual(step(5.0, 1.0, 0.2, p, 1.0), 5.69)

    def test_realised_cost_signs(self):
        grid = np.array([2.0, -3.0])
        self.assertAlmostEqual(
            realised_cost_c(grid, np.array([20.0, 20.0]), np.array([5.0, 5.0])),
            25.0,
        )

    def test_dispatch_arbitrages_and_preserves_terminal_inventory(self):
        p = BatteryParams(10.0, 0.95, 0.0, 0.0, p_max_kw=5.0)
        solution = solve_dispatch(
            np.array([0.0, 0.0, 2.0, 2.0]),
            np.array([5.0, 5.0, 50.0, 50.0]),
            np.zeros(4),
            p, 5.0, 0.5, terminal_soc=5.0,
        )
        self.assertGreater(solution["chg"][:2].sum(), 4.0)
        self.assertGreater(solution["dis"][2:].sum(), 3.9)
        self.assertGreaterEqual(solution["soc"][-1], 5.0 - 1e-5)
        self.assertTrue(np.all(solution["chg"] + solution["dis"] <= 2.5 + 1e-5))

    def test_negative_export_is_curtailed_to_zero(self):
        p = BatteryParams(10.0, 0.95, 0.0, 0.0, p_max_kw=5.0)
        solution = solve_dispatch(
            np.array([-2.0]), np.array([20.0]), np.array([-5.0]),
            p, 5.0, 0.5, terminal_soc=5.0, solar_kwh=np.array([2.0]),
        )
        self.assertGreaterEqual(solution["grid"][0], -1e-6)
        # The optimiser may absorb some surplus in the battery and curtail the remainder.
        avoided_export = solution["curtail"][0] + solution["chg"][0] - solution["dis"][0]
        self.assertAlmostEqual(avoided_export, 2.0, places=5)
        self.assertLessEqual(solution["curtail"][0], 2.0 + 1e-6)

    def test_positive_tariff_battery_export_obeys_site_cap(self):
        p = BatteryParams(10.0, 0.95, 0.0, 0.0, p_max_kw=10.0)
        solution = solve_dispatch(
            np.array([0.0]), np.array([60.0]), np.array([50.0]),
            p, 5.0, 0.5, solar_kwh=np.array([0.0]), export_cap_kw=2.0,
        )
        self.assertLess(solution["grid"][0], -0.9)
        self.assertGreaterEqual(solution["grid"][0], -1.0 - 1e-6)

    def test_exclusive_mode_prevents_simultaneous_charge_and_discharge(self):
        p = BatteryParams(10.0, 0.9, 0.0, 0.0, p_max_kw=5.0)
        solution = solve_dispatch(
            np.zeros(2), np.array([-20.0, -20.0]), np.zeros(2),
            p, 10.0, 0.5, terminal_soc=10.0, solar_kwh=np.zeros(2),
            exclusive_battery=True,
        )
        self.assertFalse(np.any((solution["chg"] > 1e-6) & (solution["dis"] > 1e-6)))


class ForecastTest(unittest.TestCase):
    def test_seasonal_baseline_is_causal(self):
        values = np.arange(500 * 4, dtype=np.float32).reshape(500, 4)
        origin = np.array([400])
        got = predict(values, origin, "seasonal_day")
        np.testing.assert_array_equal(got[0, 0], values[353])
        np.testing.assert_array_equal(got[0, -1], values[400])

    def test_model_output_shapes(self):
        x = torch.zeros(2, 8, 19)
        self.assertEqual(tuple(CfCDirect(19, 8, 4, 3)(x).shape), (2, 4, 3))
        self.assertEqual(tuple(RNNDirect("gru", 19, 8, 4, 3)(x).shape), (2, 4, 3))
        self.assertEqual(tuple(RNNDirect("lstm", 19, 8, 4, 3)(x).shape), (2, 4, 3))


if __name__ == "__main__":
    unittest.main()
