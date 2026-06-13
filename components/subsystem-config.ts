import {
  Sun,
  Battery,
  Zap,
  Home,
  Car,
  Activity,
  LucideIcon,
} from "lucide-react";

/**
 * Shared display metadata for point subsystems.
 *
 * Single source of truth for the label/icon/colours used to render a subsystem
 * (Solar, Battery, Grid, Load, EV, …). Consumed by PointsTab (groups a system's
 * points by subsystem) and CompositeTab (maps points into composite categories).
 * Each consumer renders its own ordered subset of these keys.
 */
export interface SubsystemDisplay {
  label: string;
  icon: LucideIcon;
  iconColor: string;
  bgColor: string;
  borderColor: string;
}

export const SUBSYSTEM_CONFIG = {
  solar: {
    label: "Solar",
    icon: Sun,
    iconColor: "text-yellow-400",
    bgColor: "bg-yellow-500/10",
    borderColor: "border-yellow-500/30",
  },
  battery: {
    label: "Battery",
    icon: Battery,
    iconColor: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
  },
  grid: {
    label: "Grid",
    icon: Zap,
    iconColor: "text-green-400",
    bgColor: "bg-green-500/10",
    borderColor: "border-green-500/30",
  },
  load: {
    label: "Load",
    icon: Home,
    iconColor: "text-red-400",
    bgColor: "bg-red-500/10",
    borderColor: "border-red-500/30",
  },
  ev: {
    label: "EV",
    icon: Car,
    iconColor: "text-purple-400",
    bgColor: "bg-purple-500/10",
    borderColor: "border-purple-500/30",
  },
  inverter: {
    label: "Inverter",
    icon: Activity,
    iconColor: "text-orange-400",
    bgColor: "bg-orange-500/10",
    borderColor: "border-orange-500/30",
  },
  other: {
    label: "Other",
    icon: Activity,
    iconColor: "text-gray-400",
    bgColor: "bg-gray-500/10",
    borderColor: "border-gray-500/30",
  },
} as const satisfies Record<string, SubsystemDisplay>;

export type SubsystemKey = keyof typeof SUBSYSTEM_CONFIG;
