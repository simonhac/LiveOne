"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDateTime } from "@/lib/fe-date-format";
import {
  RefreshCw,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  X,
  ChevronDown,
  Check,
} from "lucide-react";
import SessionInfoModal from "@/components/SessionInfoModal";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getFacetedUniqueValues,
  ColumnDef,
  SortingState,
  ColumnFiltersState,
  flexRender,
} from "@tanstack/react-table";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

// Extend ColumnMeta type for custom metadata
declare module "@tanstack/react-table" {
  interface ColumnMeta<TData, TValue> {
    showFilter?: boolean;
  }
}

interface Session {
  id: number;
  sessionLabel?: string;
  systemId: number;
  vendorType: string;
  systemName: string;
  cause: string;
  started: string;
  duration: number;
  successful: boolean;
  errorCode?: string;
  error?: string;
  response?: any;
  numRows: number;
  createdAt: string;
}

// Helper function to format duration
const formatDuration = (durationMs: number): string => {
  if (durationMs >= 2000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${durationMs}ms`;
};

// Multi-select filter component for header cells
function HeaderFilter({ column }: { column: any }) {
  const filterValue = (column.getFilterValue() as any[]) ?? [];
  const facetedValues = column.getFacetedUniqueValues();
  const sortedUniqueValues = useMemo(
    () => Array.from(facetedValues.keys()).sort(),
    [facetedValues],
  );

  const toggleValue = (value: any) => {
    const newFilterValue: any[] = filterValue.includes(value)
      ? filterValue.filter((v) => v !== value)
      : [...filterValue, value];
    column.setFilterValue(newFilterValue.length ? newFilterValue : undefined);
  };

  const clearFilter = () => {
    column.setFilterValue(undefined);
  };

  const hasActiveFilter = filterValue.length > 0;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={`p-0.5 rounded hover:bg-gray-700 transition-colors ${
            hasActiveFilter ? "text-blue-400" : "text-gray-500"
          }`}
          title="Filter column"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[200px] bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-1 z-50 max-h-[400px] overflow-y-auto"
          sideOffset={5}
        >
          {hasActiveFilter && (
            <>
              <DropdownMenu.Item
                className="flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-gray-700 rounded cursor-pointer outline-none"
                onSelect={(e: Event) => {
                  e.preventDefault();
                  clearFilter();
                }}
              >
                <X className="h-3 w-3" />
                Clear filter
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="h-px bg-gray-700 my-1" />
            </>
          )}
          {sortedUniqueValues.map((value: any) => {
            const isSelected = filterValue.includes(value);
            return (
              <DropdownMenu.Item
                key={String(value)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 rounded cursor-pointer outline-none"
                onSelect={(e: Event) => {
                  e.preventDefault();
                  toggleValue(value);
                }}
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  {isSelected && <Check className="h-3 w-3 text-blue-400" />}
                </div>
                <span className="flex-1">{String(value)}</span>
                <span className="text-xs text-gray-500">
                  {String(facetedValues.get(value))}
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default function ActivityViewer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [rotateKey, setRotateKey] = useState(0);
  const [maxSessionId, setMaxSessionId] = useState<number | null>(null);

  // Initialize sorting from URL
  const [sorting, setSorting] = useState<SortingState>(() => {
    const sortParam = searchParams.get("sort");
    if (sortParam) {
      const [id, desc] = sortParam.split(".");
      return [{ id, desc: desc === "desc" }];
    }
    return [{ id: "started", desc: true }]; // Default: newest first
  });

  // Initialize column filters from URL
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() => {
    const filters: ColumnFiltersState = [];
    const vendor = searchParams.get("vendor");
    const system = searchParams.get("system");
    const cause = searchParams.get("cause");
    const status = searchParams.get("status");

    if (vendor) filters.push({ id: "vendorType", value: vendor.split(",") });
    if (system) filters.push({ id: "systemName", value: system.split(",") });
    if (cause) filters.push({ id: "cause", value: cause.split(",") });
    if (status)
      filters.push({
        id: "successful",
        value: status.split(",").map((s) => s === "success"),
      });

    return filters;
  });

  // Update URL when sorting or filters change
  useEffect(() => {
    const params = new URLSearchParams();

    // Add sorting to URL
    if (sorting.length > 0) {
      const { id, desc } = sorting[0];
      params.set("sort", `${id}.${desc ? "desc" : "asc"}`);
    }

    // Add filters to URL
    columnFilters.forEach((filter) => {
      if (Array.isArray(filter.value) && filter.value.length > 0) {
        const key = {
          vendorType: "vendor",
          systemName: "system",
          cause: "cause",
          successful: "status",
        }[filter.id];

        if (key) {
          if (filter.id === "successful") {
            // Convert boolean array to success/error strings
            const statusValues = (filter.value as boolean[]).map((v) =>
              v ? "success" : "error",
            );
            params.set(key, statusValues.join(","));
          } else {
            params.set(key, (filter.value as string[]).join(","));
          }
        }
      }
    });

    const queryString = params.toString();
    const newUrl = queryString ? `?${queryString}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });
  }, [sorting, columnFilters, router]);

  const getCauseColor = (cause: string) => {
    switch (cause) {
      case "POLL":
        return "text-blue-400";
      case "PUSH":
        return "text-green-400";
      case "USER":
        return "text-yellow-400";
      case "ADMIN":
        return "text-purple-400";
      default:
        return "text-gray-400";
    }
  };

  const getStatusBadge = (successful: boolean, errorCode?: string) => {
    if (successful) {
      return (
        <span className="px-2 py-0.5 text-xs rounded bg-green-500/20 text-green-400">
          Success
        </span>
      );
    }
    return (
      <span className="px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400">
        {errorCode ? `Error ${errorCode}` : "Failed"}
      </span>
    );
  };

  // Define columns
  const columns = useMemo<ColumnDef<Session>[]>(
    () => [
      {
        accessorKey: "started",
        header: "Time",
        cell: ({ getValue }) => formatDateTime(getValue<string>()).display,
        sortingFn: "datetime",
        enableColumnFilter: false,
      },
      {
        accessorKey: "systemName",
        header: "System",
        cell: ({ row }) => (
          <div>
            <a
              href={`/dashboard/${row.original.systemId}`}
              className="text-gray-300 hover:text-blue-400 hover:underline cursor-pointer transition-colors"
            >
              {row.original.systemName}
            </a>
            <span className="text-gray-500">
              {" "}
              ID:&nbsp;{row.original.systemId}
            </span>
          </div>
        ),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || !Array.isArray(filterValue)) return true;
          return filterValue.includes(row.getValue(id));
        },
        meta: { showFilter: true },
      },
      {
        accessorKey: "vendorType",
        header: "Vendor",
        filterFn: (row, id, filterValue) => {
          if (!filterValue || !Array.isArray(filterValue)) return true;
          return filterValue.includes(row.getValue(id));
        },
        meta: { showFilter: true },
      },
      {
        accessorKey: "cause",
        header: "Cause",
        cell: ({ getValue }) => {
          const cause = getValue<string>();
          return (
            <span className={`font-medium ${getCauseColor(cause)}`}>
              {cause}
            </span>
          );
        },
        filterFn: (row, id, filterValue) => {
          if (!filterValue || !Array.isArray(filterValue)) return true;
          return filterValue.includes(row.getValue(id));
        },
        meta: { showFilter: true },
      },
      {
        accessorKey: "duration",
        header: "Duration",
        cell: ({ getValue }) => formatDuration(getValue<number>()),
        sortingFn: "basic",
      },
      {
        accessorKey: "successful",
        header: "Status",
        cell: ({ row }) =>
          getStatusBadge(row.original.successful, row.original.errorCode),
        filterFn: (row, id, filterValue) => {
          if (!filterValue || !Array.isArray(filterValue)) return true;
          return filterValue.includes(row.getValue(id));
        },
        meta: { showFilter: true },
      },
      {
        accessorKey: "numRows",
        header: "Rows",
        cell: ({ getValue }) => {
          const numRows = getValue<number>();
          return numRows > 0 ? numRows : "-";
        },
        sortingFn: "basic",
      },
      {
        accessorKey: "sessionLabel",
        header: "Label",
        cell: ({ row }) => {
          const label = row.original.sessionLabel;
          return label ? (
            <button
              onClick={() => setSelectedSession(row.original)}
              className="font-mono text-xs text-gray-400 hover:text-gray-200 group-hover:underline transition-colors cursor-pointer"
            >
              {label}
            </button>
          ) : (
            "-"
          );
        },
        enableSorting: true,
      },
    ],
    [],
  );

  const table = useReactTable({
    data: sessions,
    columns,
    state: {
      sorting,
      columnFilters,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });

  const fetchSessions = useCallback(
    async (isRefresh = false) => {
      try {
        const url =
          isRefresh && maxSessionId
            ? `/api/admin/sessions?start=${maxSessionId}&count=200`
            : "/api/admin/sessions?last=200";

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch sessions: ${response.status}`);
        }
        const data = await response.json();

        if (isRefresh) {
          setSessions((prev) => {
            const sessionMap = new Map<number, Session>();
            prev.forEach((session) => sessionMap.set(session.id, session));
            data.sessions.forEach((session: Session) =>
              sessionMap.set(session.id, session),
            );
            return Array.from(sessionMap.values()).sort((a, b) => b.id - a.id);
          });
        } else {
          setSessions(data.sessions);
        }

        if (data.sessions.length > 0) {
          const newMaxId = Math.max(...data.sessions.map((s: Session) => s.id));
          setMaxSessionId((prevMax) =>
            prevMax ? Math.max(prevMax, newMaxId) : newMaxId,
          );
        }

        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load sessions",
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [maxSessionId],
  );

  useEffect(() => {
    if (loading) {
      fetchSessions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    setRotateKey((prev) => prev + 1);
    fetchSessions(true);
  };

  // Handle modal close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedSession(null);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    };
    if (selectedSession) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [selectedSession]);

  const clearAllFilters = () => {
    table.resetColumnFilters();
  };

  const hasActiveFilters = columnFilters.length > 0;
  const filteredRowCount = table.getFilteredRowModel().rows.length;
  const totalRowCount = table.getCoreRowModel().rows.length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-400 text-lg">Loading activity…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4">
        <p className="text-red-400">Error: {error}</p>
        <button
          onClick={() => fetchSessions()}
          className="mt-2 px-3 py-1 text-sm bg-red-500/20 hover:bg-red-500/30 rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-gray-800 border-t md:border border-gray-700 md:rounded-t overflow-hidden flex flex-col min-h-0 flex-1">
        {/* Active filters info */}
        {hasActiveFilters && (
          <div className="border-b border-gray-700 px-4 py-2 bg-gray-800/50">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={clearAllFilters}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
              >
                <X className="h-3 w-3" />
                Clear all filters
              </button>
              <div className="text-xs text-gray-400">
                Showing {filteredRowCount} of {totalRowCount} sessions
              </div>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="overflow-auto flex-1">
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-gray-700">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sortDirection = header.column.getIsSorted();
                    const showFilter = header.column.columnDef.meta?.showFilter;

                    return (
                      <th
                        key={header.id}
                        className="px-4 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider"
                      >
                        <div className="flex items-center gap-2">
                          {header.id === "started" ? (
                            <>
                              {canSort ? (
                                <button
                                  onClick={header.column.getToggleSortingHandler()}
                                  className="flex items-center gap-1 hover:text-gray-200 transition-colors"
                                >
                                  <span>
                                    {flexRender(
                                      header.column.columnDef.header,
                                      header.getContext(),
                                    )}
                                  </span>
                                  {sortDirection === "asc" ? (
                                    <ArrowUp className="h-3 w-3" />
                                  ) : sortDirection === "desc" ? (
                                    <ArrowDown className="h-3 w-3" />
                                  ) : (
                                    <ArrowUpDown className="h-3 w-3 opacity-50" />
                                  )}
                                </button>
                              ) : (
                                flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )
                              )}
                              <button
                                onClick={handleRefresh}
                                disabled={refreshing}
                                className="text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                                title="Refresh"
                              >
                                <RefreshCw
                                  className="h-4 w-4"
                                  style={{
                                    transform: `rotate(${rotateKey * 180}deg)`,
                                    transition: "transform 500ms ease",
                                  }}
                                />
                              </button>
                            </>
                          ) : (
                            <>
                              {canSort ? (
                                <button
                                  onClick={header.column.getToggleSortingHandler()}
                                  className="flex items-center gap-1 hover:text-gray-200 transition-colors"
                                >
                                  <span>
                                    {flexRender(
                                      header.column.columnDef.header,
                                      header.getContext(),
                                    )}
                                  </span>
                                  {sortDirection === "asc" ? (
                                    <ArrowUp className="h-3 w-3" />
                                  ) : sortDirection === "desc" ? (
                                    <ArrowDown className="h-3 w-3" />
                                  ) : (
                                    <ArrowUpDown className="h-3 w-3 opacity-50" />
                                  )}
                                </button>
                              ) : (
                                flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )
                              )}
                              {showFilter && (
                                <HeaderFilter column={header.column} />
                              )}
                            </>
                          )}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row, index) => (
                <tr
                  key={row.id}
                  className={`group ${index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"} hover:bg-gray-700 transition-colors`}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-4 py-3 text-sm text-gray-300 align-top"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {sessions.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-500">
            No sessions recorded yet
          </div>
        )}

        {sessions.length > 0 && filteredRowCount === 0 && (
          <div className="px-4 py-8 text-center text-gray-500">
            No sessions match the current filters
          </div>
        )}
      </div>

      <SessionInfoModal
        isOpen={selectedSession !== null}
        onClose={() => setSelectedSession(null)}
        session={selectedSession}
      />
    </>
  );
}
