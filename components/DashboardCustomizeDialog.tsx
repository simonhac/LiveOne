"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, GripVertical } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useModalContext } from "@/contexts/ModalContext";
import {
  CARD_REGISTRY,
  POWER_CARDS,
  POWER_CARD_IDS,
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
  /** Power mini-cards the system can satisfy (have data). */
  availablePower: Set<PowerCardId>;
  /** Real rendered card nodes, keyed by id — so previews match the live dashboard exactly. */
  powerCardNodes: Record<PowerCardId, ReactNode>;
  onSave: (next: DashboardDescriptor) => Promise<void>;
  onReset: () => Promise<void>;
}

type ZoneId = "dashboard" | "available";

/**
 * Customize dialog (P2). The power mini-cards are edited via drag-and-drop between two zones —
 * "Dashboard cards" (shown, ordered) and "Available cards" (hidden but addable) — with real card
 * previews. Card types the system has no data for appear greyed-out as an "Add Card" gallery. The
 * chart modules keep a simple show/hide list. Edits apply on Save (not live).
 */
export default function DashboardCustomizeDialog({
  isOpen,
  onClose,
  descriptor,
  availableModules,
  availablePower,
  powerCardNodes,
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

  // Card types this system has no data for — shown greyed as an "Add Card" gallery (can't be added).
  const unavailableIds = POWER_CARD_IDS.filter((id) => !availablePower.has(id));

  const setPower = (next: PowerCardsConfig) =>
    setDraft({
      ...draft,
      cards: draft.cards.map((c) =>
        c.type === "power-cards" ? { ...c, powerCards: next } : c,
      ),
    });

  // DnD reports the two zone lists; fold them back into order+hidden. Everything not on the
  // dashboard (available + unavailable) is "hidden"; unavailable ids park at the end of the order.
  const handlePowerChange = (
    dashboardIds: PowerCardId[],
    availableIds: PowerCardId[],
  ) =>
    setPower({
      order: [...dashboardIds, ...availableIds, ...unavailableIds],
      hidden: [...availableIds, ...unavailableIds],
    });

  const setModuleHidden = (type: DashboardCardType, hidden: boolean) =>
    setDraft({
      ...draft,
      cards: draft.cards.map((c) => (c.type === type ? { ...c, hidden } : c)),
    });

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
      {/* Flex-center (NOT translate-center): a transformed ancestor re-bases the DnD DragOverlay's
          position:fixed and makes the dragged card jump by ~half the dialog size. */}
      <div className="fixed inset-0 z-[10001] flex items-center justify-center px-4 pointer-events-none">
        <div className="w-full max-w-[560px] sm:max-w-[680px] pointer-events-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
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
          <div className="px-6 py-4 space-y-5 min-h-[300px] max-h-[68vh] overflow-y-auto">
            {hasPowerCards && (
              <PowerCardsEditor
                power={power}
                availablePower={availablePower}
                unavailableIds={unavailableIds}
                powerCardNodes={powerCardNodes}
                onChange={handlePowerChange}
              />
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

// ============================================================================
// Power-cards drag-and-drop editor: two zones (Dashboard / Available) of real card previews.
// ============================================================================

interface PowerCardsEditorProps {
  power: PowerCardsConfig;
  availablePower: Set<PowerCardId>;
  unavailableIds: PowerCardId[];
  powerCardNodes: Record<PowerCardId, ReactNode>;
  onChange: (dashboardIds: PowerCardId[], availableIds: PowerCardId[]) => void;
}

function PowerCardsEditor({
  power,
  availablePower,
  unavailableIds,
  powerCardNodes,
  onChange,
}: PowerCardsEditorProps) {
  // Seed the two zones from the config (only available cards participate in DnD).
  const seed = (): Record<ZoneId, PowerCardId[]> => {
    const dashboard = power.order.filter(
      (id) => availablePower.has(id) && !power.hidden.includes(id),
    );
    const available = power.order
      .filter((id) => availablePower.has(id) && !dashboard.includes(id))
      .concat(
        POWER_CARD_IDS.filter(
          (id) =>
            availablePower.has(id) &&
            !power.order.includes(id) &&
            !dashboard.includes(id),
        ),
      );
    return { dashboard, available };
  };

  const [items, setItems] = useState<Record<ZoneId, PowerCardId[]>>(seed);
  const [activeId, setActiveId] = useState<PowerCardId | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const zoneOf = (id: PowerCardId): ZoneId | undefined =>
    (Object.keys(items) as ZoneId[]).find((z) => items[z].includes(id));

  const commit = (next: Record<ZoneId, PowerCardId[]>) => {
    setItems(next);
    onChange(next.dashboard, next.available);
  };

  const handleDragStart = (e: DragStartEvent) =>
    setActiveId(e.active.id as PowerCardId);

  const handleDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over) return;
    const activeZone = zoneOf(active.id as PowerCardId);
    // `over` may be a card id or a zone (droppable) id.
    const overZone =
      (over.id as ZoneId) in items
        ? (over.id as ZoneId)
        : zoneOf(over.id as PowerCardId);
    if (!activeZone || !overZone || activeZone === overZone) return;

    setItems((prev) => {
      const activeItems = [...prev[activeZone]];
      const overItems = [...prev[overZone]];
      const activeIndex = activeItems.indexOf(active.id as PowerCardId);
      if (activeIndex < 0) return prev;
      const [moved] = activeItems.splice(activeIndex, 1);
      const overIndex =
        (over.id as ZoneId) in items
          ? overItems.length
          : Math.max(0, overItems.indexOf(over.id as PowerCardId));
      overItems.splice(overIndex, 0, moved);
      return { ...prev, [activeZone]: activeItems, [overZone]: overItems };
    });
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setActiveId(null);
    if (!over) return;
    const activeZone = zoneOf(active.id as PowerCardId);
    const overZone =
      (over.id as ZoneId) in items
        ? (over.id as ZoneId)
        : zoneOf(over.id as PowerCardId);
    if (!activeZone || !overZone) {
      commit(items);
      return;
    }
    if (activeZone === overZone) {
      const list = items[activeZone];
      const from = list.indexOf(active.id as PowerCardId);
      const to = list.indexOf(over.id as PowerCardId);
      const reordered =
        from >= 0 && to >= 0 && from !== to ? arrayMove(list, from, to) : list;
      commit({ ...items, [activeZone]: reordered });
    } else {
      // Cross-zone move already applied in handleDragOver; just persist.
      commit(items);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Zone
          id="available"
          title="Available cards"
          ids={items.available}
          powerCardNodes={powerCardNodes}
          unavailableIds={unavailableIds}
          emptyHint="All cards are on the dashboard"
        />
        <Zone
          id="dashboard"
          title="Dashboard cards"
          ids={items.dashboard}
          powerCardNodes={powerCardNodes}
          emptyHint="Drag cards here to show them"
        />
      </div>
      <DragOverlay>
        {activeId ? (
          <div className="opacity-90 rotate-1">{powerCardNodes[activeId]}</div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface ZoneProps {
  id: ZoneId;
  title: string;
  ids: PowerCardId[];
  powerCardNodes: Record<PowerCardId, ReactNode>;
  unavailableIds?: PowerCardId[];
  emptyHint: string;
}

function Zone({
  id,
  title,
  ids,
  powerCardNodes,
  unavailableIds = [],
  emptyHint,
}: ZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        {title}
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-[120px] rounded-lg border border-dashed p-2 space-y-2 transition-colors ${
          isOver ? "border-blue-500 bg-blue-500/5" : "border-gray-700"
        }`}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((cardId) => (
            <SortableCard key={cardId} id={cardId}>
              {powerCardNodes[cardId]}
            </SortableCard>
          ))}
        </SortableContext>

        {ids.length === 0 && unavailableIds.length === 0 && (
          <div className="text-xs text-gray-600 text-center py-6">
            {emptyHint}
          </div>
        )}

        {/* Add-Card gallery: card types this system can't populate (not draggable). */}
        {unavailableIds.map((cardId) => (
          <div
            key={cardId}
            className="flex items-center gap-2 px-3 py-3 rounded-md border border-gray-800 bg-gray-900/40 opacity-50"
            title="No data on this system"
          >
            <span className="text-sm text-gray-400">
              {POWER_CARDS[cardId].label}
            </span>
            <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-600">
              No data
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SortableCard({
  id,
  children,
}: {
  id: PowerCardId;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  // The WHOLE card is the drag handle: spread the sortable listeners on the wrapper, disable text
  // selection (`select-none`) and native touch gestures (`touch-none`) so dragging the card body
  // drags instead of selecting text, and neutralise the preview's own pointer events so nothing
  // inside swallows the drag.
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative select-none touch-none cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <span className="absolute top-1 right-1 z-10 text-gray-500">
        <GripVertical className="w-4 h-4" />
      </span>
      <div className="pointer-events-none">{children}</div>
    </div>
  );
}
