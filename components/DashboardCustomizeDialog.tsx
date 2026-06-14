"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, Eye, EyeOff, GripVertical } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
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
  TILES,
  TILE_IDS,
  type DashboardCardType,
  type TileId,
} from "@/lib/dashboard/cards";
import {
  tilesConfigOf,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "@/lib/dashboard/descriptor";

interface DashboardCustomizeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The effective (saved-or-default) descriptor to seed the editor from. */
  descriptor: DashboardDescriptor | null;
  /** Module card types the system can satisfy. */
  availableModules: Set<DashboardCardType>;
  /** Power tiles the system can satisfy (have data). */
  availablePower: Set<TileId>;
  /** Real rendered card nodes, keyed by id (unused by the list now; kept for callers/preview). */
  powerCardNodes: Record<TileId, ReactNode>;
  onSave: (next: DashboardDescriptor) => Promise<void>;
  onReset: () => Promise<void>;
}

/**
 * One row in the unified card list. Tiles (solar/load/…) and module cards (Local Grid, Power Charts,
 * …) are presented as ONE list — there is no "tiles vs sections" split. Order/visibility map back to
 * the two underlying descriptor structures: tiles → the tiles module's `order`/`hidden`;
 * modules → each `ModuleCardInstance.hidden` + their position in `descriptor.cards`.
 */
type CardRow =
  | {
      key: string;
      kind: "tile";
      tileId: TileId;
      label: string;
      hidden: boolean;
    }
  | {
      key: string;
      kind: "module";
      moduleType: DashboardCardType;
      label: string;
      hidden: boolean;
    };

/**
 * Customize dialog (P2). Every card the dashboard can show — the power tiles AND the module cards —
 * lives in ONE drag-to-reorder list with a per-card show/hide toggle. Tiles the system has no data
 * for appear greyed-out below as an "Add Card" gallery (can't be added). Edits apply on Save.
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (!isOpen || !draft || typeof document === "undefined") return null;

  const tiles = tilesConfigOf(draft);
  const isDirty = JSON.stringify(draft) !== JSON.stringify(descriptor);

  // Tiles the system has no data for — shown greyed below as an "Add Card" gallery (can't be added).
  const unavailableIds = TILE_IDS.filter((id) => !availablePower.has(id));

  // The unified list, in grid order: available tiles (in their saved order), then the available
  // module cards (in their descriptor order).
  const moduleCards = draft.cards.filter(
    (c) => c.type !== "tiles" && availableModules.has(c.type),
  );
  const rows: CardRow[] = [
    ...tiles.order
      .filter((id) => availablePower.has(id))
      .map(
        (id): CardRow => ({
          key: `tile:${id}`,
          kind: "tile",
          tileId: id,
          label: TILES[id].label,
          hidden: tiles.hidden.includes(id),
        }),
      ),
    ...moduleCards.map(
      (c): CardRow => ({
        key: `mod:${c.type}`,
        kind: "module",
        moduleType: c.type,
        label: CARD_REGISTRY[c.type].label,
        hidden: !!c.hidden,
      }),
    ),
  ];

  const toggleTile = (id: TileId, hide: boolean) =>
    setDraft((d) =>
      !d
        ? d
        : {
            ...d,
            cards: d.cards.map((c) => {
              if (c.type !== "tiles") return c;
              const cur = c.tiles ?? {
                order: [...TILE_IDS],
                hidden: [],
              };
              return {
                ...c,
                tiles: {
                  order: cur.order,
                  hidden: hide
                    ? Array.from(new Set([...cur.hidden, id]))
                    : cur.hidden.filter((x) => x !== id),
                },
              };
            }),
          },
    );

  const toggleModule = (type: DashboardCardType, hide: boolean) =>
    setDraft((d) =>
      !d
        ? d
        : {
            ...d,
            cards: d.cards.map((c) =>
              c.type === type ? { ...c, hidden: hide } : c,
            ),
          },
    );

  // Drag-reorder the unified list, then split the new sequence back into the tile order and the
  // module order. Tiles stay tiles and modules stay modules (the grid renders tiles, then modules),
  // so a cross-group drag settles the card at the nearest valid spot within its own kind.
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const keys = rows.map((r) => r.key);
    const from = keys.indexOf(active.id as string);
    const to = keys.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    const next = arrayMove(rows, from, to);
    const tileIds = next
      .filter((r): r is Extract<CardRow, { kind: "tile" }> => r.kind === "tile")
      .map((r) => r.tileId);
    const moduleTypes = next
      .filter(
        (r): r is Extract<CardRow, { kind: "module" }> => r.kind === "module",
      )
      .map((r) => r.moduleType);

    setDraft((d) => {
      if (!d) return d;
      const tilesCard = d.cards.find((c) => c.type === "tiles");
      const moduleByType = new Map(
        d.cards.filter((c) => c.type !== "tiles").map((c) => [c.type, c]),
      );
      const reorderedModules = moduleTypes
        .map((t) => moduleByType.get(t))
        .filter((c): c is ModuleCardInstance => !!c);
      // Preserve any module cards NOT in the visible list (e.g. unavailable on this system).
      const shown = new Set(moduleTypes);
      const otherModules = d.cards.filter(
        (c) => c.type !== "tiles" && !shown.has(c.type),
      );
      const cards: ModuleCardInstance[] = [
        ...(tilesCard
          ? [
              {
                ...tilesCard,
                tiles: {
                  order: [...tileIds, ...unavailableIds],
                  hidden: tilesCard.tiles?.hidden ?? [],
                },
              },
            ]
          : []),
        ...reorderedModules,
        ...otherModules,
      ];
      return { ...d, cards };
    });
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

  return createPortal(
    <>
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]"
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[10001] flex items-center justify-center px-4 pointer-events-none">
        <div className="w-full max-w-[560px] pointer-events-auto bg-gray-800 border border-gray-700 rounded-lg shadow-xl">
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

          {/* Body — one unified card list */}
          <div className="px-6 py-4 min-h-[300px] max-h-[68vh] overflow-y-auto">
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              Cards
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rows.map((r) => r.key)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-1.5">
                  {rows.map((row) => (
                    <CardRowItem
                      key={row.key}
                      row={row}
                      onToggle={(hide) =>
                        row.kind === "tile"
                          ? toggleTile(row.tileId, hide)
                          : toggleModule(row.moduleType, hide)
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {/* Add-Card gallery: tiles this system can't populate (no data, not addable). */}
            {unavailableIds.length > 0 && (
              <div className="mt-4">
                <div className="text-xs uppercase tracking-wide text-gray-600 mb-2">
                  Unavailable (no data)
                </div>
                <div className="space-y-1.5">
                  {unavailableIds.map((id) => (
                    <div
                      key={id}
                      className="flex items-center gap-2 px-3 py-2 rounded-md border border-gray-800 bg-gray-900/40 opacity-50"
                      title="No data on this system"
                    >
                      <span className="text-sm text-gray-400">
                        {TILES[id].label}
                      </span>
                      <span className="ml-auto text-[10px] uppercase tracking-wide text-gray-600">
                        No data
                      </span>
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

/** A single draggable card row: grip + label + show/hide toggle. */
function CardRowItem({
  row,
  onToggle,
}: {
  row: CardRow;
  onToggle: (hide: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.key });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-2 bg-gray-900/50 rounded-md ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing touch-none text-gray-500 hover:text-gray-300"
        title="Drag to reorder"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <span
        className={`text-sm flex-1 ${row.hidden ? "text-gray-500 line-through" : "text-gray-200"}`}
      >
        {row.label}
      </span>
      <button
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
        onClick={() => onToggle(!row.hidden)}
        title={row.hidden ? "Show" : "Hide"}
      >
        {row.hidden ? (
          <EyeOff className="w-4 h-4" />
        ) : (
          <Eye className="w-4 h-4" />
        )}
      </button>
    </div>
  );
}
