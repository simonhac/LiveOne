export class EnergyIntegrator {
  private totalIntegrated: number = 0;
  private lastPower?: number;
  private lastUpdateTime?: Date;

  // Hardware counter tracking
  private hardwareCounterInitial?: number;
  private hardwareCounterCurrent?: number;

  constructor() {}

  /**
   * Update the integrator with a new power reading
   * Uses trapezoidal integration for accuracy
   */
  updatePower(
    powerW: number | null | undefined,
    timestamp: Date = new Date(),
  ): void {
    if (powerW === null || powerW === undefined) return;

    if (this.lastUpdateTime && this.lastPower !== undefined) {
      const timeDeltaHours =
        (timestamp.getTime() - this.lastUpdateTime.getTime()) /
        (1000 * 60 * 60);
      const avgPower = (powerW + this.lastPower) / 2;
      this.totalIntegrated += avgPower * timeDeltaHours;
    }

    this.lastPower = powerW;
    this.lastUpdateTime = timestamp;
  }

  /**
   * Set the initial hardware counter value (only on first call)
   */
  setInitialHardwareCounter(value: number): void {
    if (this.hardwareCounterInitial === undefined) {
      this.hardwareCounterInitial = value;
      this.hardwareCounterCurrent = value;
    }
  }

  /**
   * Update the current hardware counter value
   */
  updateHardwareCounter(value: number): void {
    this.hardwareCounterCurrent = value;
  }

  /**
   * Get the total integrated energy in Wh
   */
  getTotalWh(): number {
    return this.totalIntegrated;
  }

  /**
   * Get the total integrated energy in kWh
   */
  getTotalKwh(): number {
    return this.totalIntegrated / 1000;
  }

  /**
   * Get hardware counter delta in Wh
   */
  getHardwareDeltaWh(): number {
    if (
      this.hardwareCounterInitial === undefined ||
      this.hardwareCounterCurrent === undefined
    ) {
      return 0;
    }
    return this.hardwareCounterCurrent - this.hardwareCounterInitial;
  }

  /**
   * Get the difference between integrated and hardware counter
   */
  getDifferenceWh(): number {
    return this.totalIntegrated - this.getHardwareDeltaWh();
  }

  /**
   * Get the difference percentage
   */
  getDifferencePercent(): number {
    const hwDelta = this.getHardwareDeltaWh();
    if (hwDelta === 0) return 0;
    return (this.getDifferenceWh() / hwDelta) * 100;
  }

  /**
   * Reset the integrator
   */
  reset(): void {
    this.totalIntegrated = 0;
    this.lastPower = undefined;
    this.lastUpdateTime = undefined;
    this.hardwareCounterInitial = undefined;
    this.hardwareCounterCurrent = undefined;
  }
}

/**
 * Bidirectional energy integrator for flows that can go both ways (battery, grid)
 */
export class BidirectionalEnergyIntegrator {
  private positiveIntegrator: EnergyIntegrator;
  private negativeIntegrator: EnergyIntegrator;

  constructor() {
    this.positiveIntegrator = new EnergyIntegrator();
    this.negativeIntegrator = new EnergyIntegrator();
  }

  /**
   * Update with a new power reading
   * Positive values go to positive integrator, negative to negative integrator
   */
  updatePower(
    powerW: number | null | undefined,
    timestamp: Date = new Date(),
  ): void {
    if (powerW === null || powerW === undefined) return;

    if (powerW > 0) {
      this.positiveIntegrator.updatePower(powerW, timestamp);
      // Update negative with 0 to maintain time continuity
      this.negativeIntegrator.updatePower(0, timestamp);
    } else if (powerW < 0) {
      this.negativeIntegrator.updatePower(Math.abs(powerW), timestamp);
      // Update positive with 0 to maintain time continuity
      this.positiveIntegrator.updatePower(0, timestamp);
    } else {
      // Power is 0, update both with 0
      this.positiveIntegrator.updatePower(0, timestamp);
      this.negativeIntegrator.updatePower(0, timestamp);
    }
  }

  /**
   * Get positive energy flow in Wh
   */
  getPositiveWh(): number {
    return this.positiveIntegrator.getTotalWh();
  }

  /**
   * Get negative energy flow in Wh
   */
  getNegativeWh(): number {
    return this.negativeIntegrator.getTotalWh();
  }

  /**
   * Get positive energy flow in kWh
   */
  getPositiveKwh(): number {
    return this.positiveIntegrator.getTotalKwh();
  }

  /**
   * Get negative energy flow in kWh
   */
  getNegativeKwh(): number {
    return this.negativeIntegrator.getTotalKwh();
  }

  /**
   * Reset both integrators
   */
  reset(): void {
    this.positiveIntegrator.reset();
    this.negativeIntegrator.reset();
  }
}
