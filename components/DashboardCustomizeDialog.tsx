"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Trash2,
  Layers,
} from "lucide-react";
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
  cardIdentity,
  type DashboardDescriptor,
  type ModuleCardInstance,
} from "@/lib/dashboard/descriptor";
import { MULTI_AREA_CARD_TYPES } from "@/lib/dashboard/multi-area";
import type { ReadableArea } from "@/lib/areas/list";

/** Card types that can be composed from ANOTHER Area (Phase 2b), with their catalog labels. */
const ADDABLE_AREA_CARD_TYPES = MULTI_AREA_CARD_TYPES.map((type) => ({
  type,
  label: CARD_REGISTRY[type].label,
}));

/** A reasonably-unique, type/Area-namespaced instance id for an added multi-area card. */
function newAreaCardId(type: DashboardCardType, areaId: string): string {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${type}@${areaId.slice(0, 8)}-${rand}`;
}

/** True for the PAGE tile grid (the areaId-less `tiles` card), as opposed to an off-area tiles block. */
function isPageTiles(c: ModuleCardInstance): boolean {
  return c.type === "tiles" && !c.areaId;
}

/**
 * Per-instance display label for a module card row. Multiple `chart` instances share one
 * CARD_REGISTRY label, so derive a distinct label from the instance's chart config.
 */
function moduleLabel(c: ModuleCardInstance): string {
  if (c.type === "chart" && c.chart) {
    if (c.chart.variant === "lines") return "Energy Chart";
    if (c.chart.split === "load") return "Power — Load";
    if (c.chart.split === "generation") return "Power — Generation";
    return "Power Chart";
  }
  return CARD_REGISTRY[c.type].label;
}

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
  /** Areas the user can read — the "add a card from another Area" picker (Phase 2b). */
  readableAreas?: ReadableArea[];
  /** This dashboard's own systemId — excluded from the area picker (it's the page, not "another"). */
  pageSystemId?: number;
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
      /** The card's reconcile identity (id ?? type) — keys the row, toggle and reorder. */
      identity: string;
      label: string;
      hidden: boolean;
      /** For an off-area card (Phase 2b): the Area's display name, shown as a subdued suffix. */
      areaName?: string;
      /** Off-area cards are user-added → removable (not just hideable). */
      removable?: boolean;
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
  readableAreas = [],
  pageSystemId,
  onSave,
  onReset,
}: DashboardCustomizeDialogProps) {
  const { registerModal, unregisterModal } = useModalContext();
  const [draft, setDraft] = useState<DashboardDescriptor | null>(descriptor);
  const [isSaving, setIsSaving] = useState(false);
  // "Add a card from another Area" picker state.
  const [addType, setAddType] = useState<DashboardCardType>("tiles");
  const [addAreaId, setAddAreaId] = useState<string>("");

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

  const areaNameById = new Map(readableAreas.map((a) => [a.id, a.displayName]));
  // Areas the user can compose FROM — everything they can read except this page's own Area.
  const otherAreas = readableAreas.filter(
    (a) => a.legacySystemId !== pageSystemId,
  );

  // The unified list, in grid order: available tiles (in their saved order), then module cards in
  // descriptor order. An off-area card (areaId set) is always listed (it's the user's explicit
  // composition) even if the PAGE system couldn't render that type; the PAGE tile grid is excluded
  // (it's rendered as the tile rows above, not as a module).
  const moduleCards = draft.cards.filter(
    (c) => !isPageTiles(c) && (availableModules.has(c.type) || !!c.areaId),
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
        key: `mod:${cardIdentity(c)}`,
        kind: "module",
        identity: cardIdentity(c),
        label: moduleLabel(c),
        hidden: !!c.hidden,
        areaName: c.areaId
          ? (areaNameById.get(c.areaId) ?? "Other area")
          : undefined,
        removable: !!c.areaId,
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
              if (!isPageTiles(c)) return c;
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

  const toggleModule = (identity: string, hide: boolean) =>
    setDraft((d) =>
      !d
        ? d
        : {
            ...d,
            cards: d.cards.map((c) =>
              cardIdentity(c) === identity ? { ...c, hidden: hide } : c,
            ),
          },
    );

  // Append a new off-area card (Phase 2b): a fresh instance bound to another Area, visible by default.
  const appendAreaCard = (type: DashboardCardType, areaId: string) => {
    if (!areaId) return;
    const card: ModuleCardInstance = {
      type,
      id: newAreaCardId(type, areaId),
      areaId,
      hidden: false,
    };
    if (type === "chart") card.chart = { variant: "lines" };
    setDraft((d) => (!d ? d : { ...d, cards: [...d.cards, card] }));
  };

  // Remove an off-area card entirely (user-added cards are removable, not just hideable).
  const removeModule = (identity: string) =>
    setDraft((d) =>
      !d
        ? d
        : { ...d, cards: d.cards.filter((c) => cardIdentity(c) !== identity) },
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
    const moduleIdentities = next
      .filter(
        (r): r is Extract<CardRow, { kind: "module" }> => r.kind === "module",
      )
      .map((r) => r.identity);

    setDraft((d) => {
      if (!d) return d;
      const tilesCard = d.cards.find(isPageTiles);
      const moduleByIdentity = new Map(
        d.cards.filter((c) => !isPageTiles(c)).map((c) => [cardIdentity(c), c]),
      );
      const reorderedModules = moduleIdentities
        .map((id) => moduleByIdentity.get(id))
        .filter((c): c is ModuleCardInstance => !!c);
      // Preserve any module cards NOT in the visible list (e.g. unavailable on this system).
      const shown = new Set(moduleIdentities);
      const otherModules = d.cards.filter(
        (c) => !isPageTiles(c) && !shown.has(cardIdentity(c)),
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
                          : toggleModule(row.identity, hide)
                      }
                      onRemove={
                        row.kind === "module" && row.removable
                          ? () => removeModule(row.identity)
                          : undefined
                      }
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {/* Add a card from ANOTHER Area (Phase 2b multi-area composition). Pick a card type +
                an Area you can read; it's appended as a visible off-area card. */}
            {otherAreas.length > 0 && (
              <div className="mt-5 border-t border-gray-700/70 pt-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500">
                  <Layers className="h-3.5 w-3.5" />
                  Add a card from another area
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={addType}
                    onChange={(e) =>
                      setAddType(e.target.value as DashboardCardType)
                    }
                    className="rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
                  >
                    {ADDABLE_AREA_CARD_TYPES.map((t) => (
                      <option key={t.type} value={t.type}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={addAreaId}
                    onChange={(e) => setAddAreaId(e.target.value)}
                    className="min-w-[8rem] flex-1 rounded-md border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
                  >
                    <option value="">Choose area…</option>
                    {otherAreas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!addAreaId}
                    onClick={() => {
                      appendAreaCard(addType, addAreaId);
                      setAddAreaId("");
                    }}
                    className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </button>
                </div>
              </div>
            )}

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

/** A single draggable card row: grip + label (+ Area suffix) + show/hide toggle (+ remove). */
function CardRowItem({
  row,
  onToggle,
  onRemove,
}: {
  row: CardRow;
  onToggle: (hide: boolean) => void;
  onRemove?: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.key });
  const areaName = row.kind === "module" ? row.areaName : undefined;

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
        {areaName && (
          <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-gray-500">
            <Layers className="h-3 w-3" />
            {areaName}
          </span>
        )}
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
      {onRemove && (
        <button
          className="p-1.5 rounded text-gray-400 hover:text-red-400 hover:bg-gray-700 transition-colors"
          onClick={onRemove}
          title="Remove card"
          aria-label="Remove card"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
