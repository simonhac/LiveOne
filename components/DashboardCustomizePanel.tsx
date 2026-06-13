"use client";

import { Eye, EyeOff, ChevronUp, ChevronDown } from "lucide-react";
import {
  CARD_REGISTRY,
  POWER_CARDS,
  type DashboardCardType,
  type PowerCardId,
} from "@/lib/dashboard/cards";
import {
  powerCardsConfigOf,
  type DashboardDescriptor,
  type PowerCardsConfig,
} from "@/lib/dashboard/descriptor";

interface DashboardCustomizePanelProps {
  descriptor: DashboardDescriptor;
  /** Module card types the system can satisfy (others are hidden from the list). */
  availableModules: Set<DashboardCardType>;
  /** Power mini-cards the system can satisfy. */
  availablePower: Set<PowerCardId>;
  onChange: (next: DashboardDescriptor) => void;
}

/**
 * Apple-Home-style customize panel: reorder/hide/show the power mini-cards and show/hide the chart
 * modules. Edits a draft descriptor; the parent persists on Save. Reordering whole chart modules is
 * deferred (they keep their layout positions in v1).
 */
export default function DashboardCustomizePanel({
  descriptor,
  availableModules,
  availablePower,
  onChange,
}: DashboardCustomizePanelProps) {
  const power = powerCardsConfigOf(descriptor);
  const hasPowerCards = descriptor.cards.some((c) => c.type === "power-cards");

  const setModuleHidden = (type: DashboardCardType, hidden: boolean) =>
    onChange({
      ...descriptor,
      cards: descriptor.cards.map((c) =>
        c.type === type ? { ...c, hidden } : c,
      ),
    });

  const setPower = (next: PowerCardsConfig) =>
    onChange({
      ...descriptor,
      cards: descriptor.cards.map((c) =>
        c.type === "power-cards" ? { ...c, powerCards: next } : c,
      ),
    });

  const togglePowerHidden = (id: PowerCardId, hide: boolean) =>
    setPower({
      ...power,
      hidden: hide
        ? Array.from(new Set([...power.hidden, id]))
        : power.hidden.filter((x) => x !== id),
    });

  // Reorder among the visible-on-this-system cards; keep the rest appended so unrelated systems
  // don't churn the order.
  const movePower = (id: PowerCardId, dir: -1 | 1) => {
    const visible = power.order.filter((x) => availablePower.has(x));
    const i = visible.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    [visible[i], visible[j]] = [visible[j], visible[i]];
    const rest = power.order.filter((x) => !availablePower.has(x));
    setPower({ ...power, order: [...visible, ...rest] });
  };

  const powerList = power.order.filter((id) => availablePower.has(id));
  const moduleCards = descriptor.cards.filter(
    (c) => c.type !== "power-cards" && availableModules.has(c.type),
  );

  const rowClass =
    "flex items-center justify-between gap-2 px-3 py-2 bg-gray-800/40 rounded";
  const btnClass =
    "p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="mb-4 p-4 bg-gray-800/60 border border-gray-700 rounded-lg">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">
        Customize dashboard
      </h3>

      {hasPowerCards && powerList.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Power cards
          </div>
          <div className="space-y-1.5">
            {powerList.map((id, idx) => {
              const hidden = power.hidden.includes(id);
              return (
                <div key={id} className={rowClass}>
                  <span
                    className={`text-sm ${hidden ? "text-gray-500 line-through" : "text-gray-200"}`}
                  >
                    {POWER_CARDS[id].label}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      className={btnClass}
                      onClick={() => movePower(id, -1)}
                      disabled={idx === 0}
                      title="Move up"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      className={btnClass}
                      onClick={() => movePower(id, 1)}
                      disabled={idx === powerList.length - 1}
                      title="Move down"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      className={btnClass}
                      onClick={() => togglePowerHidden(id, !hidden)}
                      title={hidden ? "Show" : "Hide"}
                    >
                      {hidden ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {moduleCards.length > 0 && (
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Sections
          </div>
          <div className="space-y-1.5">
            {moduleCards.map((c) => (
              <div key={c.type} className={rowClass}>
                <span
                  className={`text-sm ${c.hidden ? "text-gray-500 line-through" : "text-gray-200"}`}
                >
                  {CARD_REGISTRY[c.type].label}
                </span>
                <button
                  className={btnClass}
                  onClick={() => setModuleHidden(c.type, !c.hidden)}
                  title={c.hidden ? "Show" : "Hide"}
                >
                  {c.hidden ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
