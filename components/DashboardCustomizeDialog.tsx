"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, ChevronUp, ChevronDown } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";
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

interface DashboardCustomizeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The effective (saved-or-default) descriptor to seed the editor from. */
  descriptor: DashboardDescriptor | null;
  /** Module card types the system can satisfy. */
  availableModules: Set<DashboardCardType>;
  /** Power mini-cards the system can satisfy. */
  availablePower: Set<PowerCardId>;
  onSave: (next: DashboardDescriptor) => Promise<void>;
  onReset: () => Promise<void>;
}

/**
 * Customize dialog (P2) — same chrome as the system settings dialogs. Edits a local draft seeded
 * from the effective descriptor; the dashboard updates on Save (not live). Reorder/hide/show the
 * power mini-cards; show/hide the chart modules; Reset to default.
 */
export default function DashboardCustomizeDialog({
  isOpen,
  onClose,
  descriptor,
  availableModules,
  availablePower,
  onSave,
  onReset,
}: DashboardCustomizeDialogProps) {
  const { registerModal, unregisterModal } = useModalContext();
  const [draft, setDraft] = useState<DashboardDescriptor | null>(descriptor);
  const [isSaving, setIsSaving] = useState(false);

  // Seed the draft from the effective descriptor each time the dialog opens.
  useEffect(() => {
    if (isOpen) setDraft(descriptor);
  }, [isOpen, descriptor]);

  useEffect(() => {
    if (isOpen) {
      registerModal("dashboard-customize-dialog");
      return () => unregisterModal("dashboard-customize-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !draft || typeof document === "undefined") return null;

  const power = powerCardsConfigOf(draft);
  const hasPowerCards = draft.cards.some((c) => c.type === "power-cards");
  const isDirty = JSON.stringify(draft) !== JSON.stringify(descriptor);

  const setPower = (next: PowerCardsConfig) =>
    setDraft({
      ...draft,
      cards: draft.cards.map((c) =>
        c.type === "power-cards" ? { ...c, powerCards: next } : c,
      ),
    });

  const setModuleHidden = (type: DashboardCardType, hidden: boolean) =>
    setDraft({
      ...draft,
      cards: draft.cards.map((c) => (c.type === type ? { ...c, hidden } : c)),
    });

  const togglePowerHidden = (id: PowerCardId, hide: boolean) =>
    setPower({
      ...power,
      hidden: hide
        ? Array.from(new Set([...power.hidden, id]))
        : power.hidden.filter((x) => x !== id),
    });

  const movePower = (id: PowerCardId, dir: -1 | 1) => {
    const visible = power.order.filter((x) => availablePower.has(x));
    const i = visible.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visible.length) return;
    [visible[i], visible[j]] = [visible[j], visible[i]];
    const rest = power.order.filter((x) => !availablePower.has(x));
    setPower({ ...power, order: [...visible, ...rest] });
  };

  const handleSave = async () => {
    if (!isDirty) return onClose();
    setIsSaving(true);
    try {
      await onSave(draft);
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsSaving(true);
    try {
      await onReset();
    } finally {
      setIsSaving(false);
    }
  };

  const powerList = power.order.filter((id) => availablePower.has(id));
  const moduleCards = draft.cards.filter(
    (c) => c.type !== "power-cards" && availableModules.has(c.type),
  );

  const rowClass =
    "flex items-center justify-between gap-2 px-3 py-2 bg-gray-900/50 rounded-md";
  const iconBtn =
    "p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors";

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]"
        onClick={onClose}
      />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[10001] w-full max-w-[488px] sm:max-w-[588px] px-4">
        <div className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
            <h2 className="text-lg font-semibold text-white">
              Customize dashboard
            </h2>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-700 transition-colors"
            >
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-4 space-y-5 min-h-[300px] max-h-[60vh] overflow-y-auto">
            {hasPowerCards && powerList.length > 0 && (
              <div>
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
                            className={iconBtn}
                            onClick={() => movePower(id, -1)}
                            disabled={idx === 0}
                            title="Move up"
                          >
                            <ChevronUp className="w-4 h-4" />
                          </button>
                          <button
                            className={iconBtn}
                            onClick={() => movePower(id, 1)}
                            disabled={idx === powerList.length - 1}
                            title="Move down"
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                          <button
                            className={iconBtn}
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
                        className={iconBtn}
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

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-700 flex justify-between items-center gap-3">
            <button
              onClick={handleReset}
              disabled={isSaving}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Reset to default
            </button>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                disabled={isSaving}
                className="px-4 py-2 text-gray-300 hover:text-white border border-gray-600 rounded-md transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !isDirty}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-w-[100px]"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
