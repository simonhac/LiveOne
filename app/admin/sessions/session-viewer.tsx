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
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import SessionInfoModal from "@/components/SessionInfoModal";
import {
  useReactTable,
  getCoreRowModel,
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
    showTimeFilter?: boolean;
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
  numRows: number;
  createdAt: string;
}

// Helper function to format duration
const formatDuration = (durationMs: number): string => {
  // Always use seconds format with non-breaking space
  return `${(durationMs / 1000).toFixed(1)}\u00A0s`;
};

// Multi-select filter component for header cells
function HeaderFilter({
  column,
  availableOptions,
}: {
  column: any;
  availableOptions: any[];
}) {
  const filterValue = (column.getFilterValue() as any[]) ?? [];

  // Use provided options (from database), already sorted
  const sortedUniqueValues = availableOptions;

  // Helper to display boolean values as Success/Failed
  const getDisplayValue = (value: any): string => {
    if (typeof value === "boolean") {
      return value ? "Success" : "Failed";
    }
    return String(value);
  };

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
            hasActiveFilter ? "text-white font-bold" : "text-gray-500"
          }`}
          title="Filter column"
        >
          <ChevronDown
            className={`h-3 w-3 ${hasActiveFilter ? "stroke-[2.5]" : ""}`}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[200px] bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-1 max-h-[400px] overflow-y-auto z-50"
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
                <span className="flex-1">{getDisplayValue(value)}</span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// Time range filter component for TIME column header
function TimeFilter({
  timeRange,
  setTimeRange,
  setCurrentPage,
}: {
  timeRange: string | null;
  setTimeRange: (range: string | null) => void;
  setCurrentPage: (page: number) => void;
}) {
  const hasActiveFilter = timeRange !== null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={`p-0.5 rounded hover:bg-gray-700 transition-colors ${
            hasActiveFilter ? "text-blue-400" : "text-gray-500"
          }`}
          title="Filter time range"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="min-w-[120px] bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-1 z-50"
          sideOffset={5}
        >
          {["24h", "3d", "7d", "30d", "All"].map((range) => {
            const isSelected =
              range === "All" ? !timeRange : timeRange === range;
            return (
              <DropdownMenu.Item
                key={range}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-700 rounded cursor-pointer outline-none"
                onSelect={(e: Event) => {
                  e.preventDefault();
                  setTimeRange(range === "All" ? null : range);
                  setCurrentPage(0);
                }}
              >
                <div className="w-4 h-4 flex items-center justify-center">
                  {isSelected && <Check className="h-3 w-3 text-blue-400" />}
                </div>
                <span
                  className={isSelected ? "text-blue-400" : "text-gray-300"}
                >
                  {range}
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
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(
    null,
  );
  const [rotateKey, setRotateKey] = useState(0);

  // Filter options (all possible values from database)
  const [filterOptions, setFilterOptions] = useState<{
    systemName: string[];
    vendorType: string[];
    cause: string[];
    successful: boolean[];
  }>({
    systemName: [],
    vendorType: [],
    cause: [],
    successful: [],
  });

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

  // Time range filter state
  const [timeRange, setTimeRange] = useState<string | null>(() => {
    return searchParams.get("timeRange");
  });

  // Pagination state
  const [currentPage, setCurrentPage] = useState(0);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const pageSize = 100;

  // Update URL when sorting, filters, or time range change
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

    // Add time range to URL
    if (timeRange) {
      params.set("timeRange", timeRange);
    }

    // Add page to URL if not first page
    if (currentPage > 0) {
      params.set("page", currentPage.toString());
    }

    const queryString = params.toString();
    const newUrl = queryString ? `?${queryString}` : window.location.pathname;
    router.replace(newUrl, { scroll: false });

    // Reset to page 0 when filters/sorting change (but not when just changing pages)
    // This effect runs after state updates, so we check if we need to reset
  }, [sorting, columnFilters, timeRange, currentPage, router]);

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
        header: "TIME",
        cell: ({ getValue }) => formatDateTime(getValue<string>()).display,
        sortingFn: "datetime",
        enableColumnFilter: false,
        meta: { showTimeFilter: true },
      },
      {
        accessorKey: "systemName",
        header: "SYSTEM",
        size: 250,
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
        header: "VENDOR",
        filterFn: (row, id, filterValue) => {
          if (!filterValue || !Array.isArray(filterValue)) return true;
          return filterValue.includes(row.getValue(id));
        },
        meta: { showFilter: true },
      },
      {
        accessorKey: "cause",
        header: "CAUSE",
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
        header: "DURATION",
        size: 90,
        cell: ({ getValue }) => (
          <div className="text-right">{formatDuration(getValue<number>())}</div>
        ),
        sortingFn: "basic",
      },
      {
        accessorKey: "successful",
        header: "STATUS",
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
        header: "RECORDS",
        cell: ({ getValue }) => {
          const numRows = getValue<number>();
          return (
            <div className="text-right">{numRows > 0 ? numRows : "-"}</div>
          );
        },
        sortingFn: "basic",
      },
      {
        accessorKey: "sessionLabel",
        header: "LABEL",
        cell: ({ row }) => {
          const label = row.original.sessionLabel;
          return label ? (
            <button
              onClick={() => setSelectedSessionId(row.original.id)}
              className="font-mono text-xs text-gray-400 hover:text-gray-200 hover:underline transition-colors cursor-pointer"
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
    // Server-side sorting/filtering, so disable client-side
    manualSorting: true,
    manualFiltering: true,
    manualPagination: true,
    pageCount: totalCount ? Math.ceil(totalCount / pageSize) : -1,
  });

  // Fetch filter options on mount
  useEffect(() => {
    const fetchFilterOptions = async () => {
      try {
        const response = await fetch("/api/admin/sessions/filter-options");
        if (response.ok) {
          const data = await response.json();
          setFilterOptions(data.filterOptions);
        }
      } catch (error) {
        console.error("Failed to fetch filter options:", error);
      }
    };

    fetchFilterOptions();
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      setRefreshing(true);

      // Build query params for server-side filtering/sorting
      const params = new URLSearchParams();

      // Add sorting
      if (sorting.length > 0) {
        const { id, desc } = sorting[0];
        params.set("sort", `${id}.${desc ? "desc" : "asc"}`);
      }

      // Add filters
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

      // Add time range
      if (timeRange) {
        params.set("timeRange", timeRange);
      }

      // Add pagination
      params.set("page", currentPage.toString());
      params.set("pageSize", pageSize.toString());

      const url = `/api/admin/sessions?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch sessions: ${response.status}`);
      }

      const data = await response.json();
      setSessions(data.sessions);
      setTotalCount(data.totalCount ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sorting, columnFilters, timeRange, currentPage, pageSize]);

  // Fetch sessions when filters, sorting, or pagination changes
  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorting, columnFilters, timeRange, currentPage]);

  const handleRefresh = () => {
    setRotateKey((prev) => prev + 1);
    fetchSessions();
  };

  // Handle modal close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedSessionId(null);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      }
    };
    if (selectedSessionId) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [selectedSessionId]);

  const clearAllFilters = () => {
    table.resetColumnFilters();
    setTimeRange(null);
    setCurrentPage(0);
  };

  const hasActiveFilters = columnFilters.length > 0 || timeRange !== null;
  const totalPages = totalCount ? Math.ceil(totalCount / pageSize) : undefined;
  const hasMorePages = sessions.length === pageSize; // If we got a full page, there might be more

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
        {/* Pagination and refresh controls */}
        <div className="border-b border-gray-700 px-4 py-2 bg-gray-800/50 flex items-center justify-between flex-wrap gap-3">
          {/* Left side: Filter info */}
          <div className="flex items-center gap-3">
            {hasActiveFilters && (
              <>
                <button
                  onClick={clearAllFilters}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-colors"
                >
                  <X className="h-3 w-3" />
                  Clear all filters
                </button>
                {totalCount !== null && (
                  <div className="text-xs text-gray-400">
                    {totalCount} session{totalCount !== 1 ? "s" : ""} match
                    {totalCount === 1 ? "es" : ""}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right side: Pagination controls */}
          <div className="flex items-center gap-2">
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
            {(totalPages !== undefined
              ? totalPages > 1
              : currentPage > 0 || hasMorePages) && (
              <>
                <button
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  className="p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-gray-400 hover:text-gray-200 hover:bg-gray-700"
                  title="Previous page"
                >
                  <ChevronsLeft className="h-4 w-4" />
                </button>
                <span className="text-xs text-gray-400">
                  {totalPages !== undefined ? (
                    <>
                      Page {currentPage + 1} of {totalPages}
                    </>
                  ) : (
                    <>Page {currentPage + 1}</>
                  )}
                </span>
                <button
                  onClick={() =>
                    setCurrentPage((p) =>
                      totalPages !== undefined
                        ? Math.min(totalPages - 1, p + 1)
                        : p + 1,
                    )
                  }
                  disabled={
                    totalPages !== undefined
                      ? currentPage >= totalPages - 1
                      : !hasMorePages
                  }
                  className="p-1 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed text-gray-400 hover:text-gray-200 hover:bg-gray-700"
                  title="Next page"
                >
                  <ChevronsRight className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto overflow-y-visible flex-1">
          <table className="w-full">
            <thead className="sticky top-0 z-20 bg-gray-800">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-gray-700">
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sortDirection = header.column.getIsSorted();
                    const showFilter = header.column.columnDef.meta?.showFilter;
                    const showTimeFilter =
                      header.column.columnDef.meta?.showTimeFilter;

                    return (
                      <th
                        key={header.id}
                        className="px-2.5 py-3 text-left text-xs font-medium text-gray-400 uppercase tracking-wider bg-gray-800"
                      >
                        <div className="flex items-center gap-1">
                          {canSort ? (
                            <button
                              onClick={header.column.getToggleSortingHandler()}
                              className={`flex items-center gap-1 transition-colors ${
                                sortDirection
                                  ? "text-white font-bold hover:text-gray-100"
                                  : "hover:text-gray-200"
                              }`}
                            >
                              <span>
                                {flexRender(
                                  header.column.columnDef.header,
                                  header.getContext(),
                                )}
                              </span>
                              {sortDirection === "asc" ? (
                                <ArrowUp className="h-3 w-3 stroke-[2.5]" />
                              ) : sortDirection === "desc" ? (
                                <ArrowDown className="h-3 w-3 stroke-[2.5]" />
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
                            <HeaderFilter
                              column={header.column}
                              availableOptions={
                                filterOptions[
                                  header.column.id as keyof typeof filterOptions
                                ] || []
                              }
                            />
                          )}
                          {showTimeFilter && (
                            <TimeFilter
                              timeRange={timeRange}
                              setTimeRange={setTimeRange}
                              setCurrentPage={setCurrentPage}
                            />
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
                  className={`border-b border-gray-700 hover:bg-gray-700/50 transition-colors cursor-pointer ${
                    index % 2 === 0 ? "bg-gray-900/50" : "bg-gray-800/50"
                  }`}
                  onClick={() => setSelectedSessionId(row.original.id)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="px-2.5 py-3 text-sm text-gray-300 align-top"
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

        {sessions.length === 0 && !loading && (
          <div className="px-4 py-8 text-center text-gray-500">
            {hasActiveFilters
              ? "No sessions match the current filters"
              : "No sessions recorded yet"}
          </div>
        )}
      </div>

      <SessionInfoModal
        isOpen={selectedSessionId !== null}
        onClose={() => setSelectedSessionId(null)}
        sessionId={selectedSessionId}
      />
    </>
  );
}
