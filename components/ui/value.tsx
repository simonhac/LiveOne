import React from "react";
import {
  classifyUnit,
  GAP_CLASS,
  UNIT_CLASS,
  UNIT_MUTED_CLASS,
  UNIT_SMALL_CAPS_CLASS,
  type UnitGap,
} from "@/lib/point/unit-typography";

/**
 * A hero value: `[prefix][NUMBER][unit][ qualifier]`.
 *
 * Deliberately size-agnostic — every part is sized in `em`, so the caller owns
 * font-size, weight and colour. That is what lets the same component serve a
 * `text-2xl` tile and a `text-[32px]` donut.
 *
 * See docs/architecture/number-typography.md.
 */

function UnitSpan({
  children,
  gap,
  muted,
  smallCaps,
}: {
  children: React.ReactNode;
  gap: UnitGap;
  muted: boolean;
  smallCaps?: boolean;
}) {
  return (
    <span
      className={`${UNIT_CLASS} ${GAP_CLASS[gap]} ${muted ? UNIT_MUTED_CLASS : ""} ${
        smallCaps ? UNIT_SMALL_CAPS_CLASS : ""
      }`}
    >
      {children}
    </span>
  );
}

export interface ValueProps {
  /** The number, already formatted. Never include the unit in here. */
  value: React.ReactNode;
  /** Fused, unmuted symbol before the number — e.g. `$`. */
  prefix?: string;
  /** e.g. `kW`, `%`, `°C`, `¢/kWh`. Binding is decided by `classifyUnit`. */
  unit?: string;
  /** A trailing label that is not a unit — e.g. `RE`, `EI`. Spaced + muted. */
  qualifier?: string;
  className?: string;
}

export default function Value({
  value,
  prefix,
  unit,
  qualifier,
  className,
}: ValueProps) {
  const parts = unit ? classifyUnit(unit) : null;

  return (
    <span className={`whitespace-nowrap tabular-nums ${className ?? ""}`}>
      {prefix && <span className={UNIT_CLASS}>{prefix}</span>}
      {value}
      {parts?.head && (
        <UnitSpan
          gap={parts.headGap}
          muted={parts.headMuted}
          smallCaps={parts.headSmallCaps}
        >
          {parts.head}
        </UnitSpan>
      )}
      {parts?.tail && (
        <UnitSpan gap="none" muted>
          {parts.tail}
        </UnitSpan>
      )}
      {qualifier && (
        <UnitSpan gap="word" muted>
          {qualifier}
        </UnitSpan>
      )}
    </span>
  );
}
