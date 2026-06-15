"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Bridges the dashboard "Customise…" trigger (in the header menu, rendered by DashboardLayout) to the
 * Customize dialog + descriptor state (which lives in DashboardClient, a sibling subtree under
 * {children}). DashboardLayout provides this around both; the header opens the dialog, DashboardClient
 * owns/renders it and advertises whether customization is currently available.
 */
interface DashboardCustomizeValue {
  /** True once the dashboard is loaded and persistence is enabled (DashboardClient sets this). */
  canCustomize: boolean;
  setCanCustomize: (v: boolean) => void;
  /** Open/close state for the Customize dialog. */
  isCustomizeOpen: boolean;
  openCustomize: () => void;
  closeCustomize: () => void;
  /** True once the dashboard is loaded, sharing is enabled, and the caller owns it (P4). */
  canShare: boolean;
  setCanShare: (v: boolean) => void;
  /** Open/close state for the Share dialog (P4). */
  isShareOpen: boolean;
  openShare: () => void;
  closeShare: () => void;
}

const DashboardCustomizeContext = createContext<DashboardCustomizeValue | null>(
  null,
);

export function DashboardCustomizeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [canCustomize, setCanCustomize] = useState(false);
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  return (
    <DashboardCustomizeContext.Provider
      value={{
        canCustomize,
        setCanCustomize,
        isCustomizeOpen,
        openCustomize: () => setIsCustomizeOpen(true),
        closeCustomize: () => setIsCustomizeOpen(false),
        canShare,
        setCanShare,
        isShareOpen,
        openShare: () => setIsShareOpen(true),
        closeShare: () => setIsShareOpen(false),
      }}
    >
      {children}
    </DashboardCustomizeContext.Provider>
  );
}

/** Throws if used outside the provider — for DashboardClient, which is always inside it. */
export function useDashboardCustomize(): DashboardCustomizeValue {
  const v = useContext(DashboardCustomizeContext);
  if (!v) {
    throw new Error(
      "useDashboardCustomize must be used within a DashboardCustomizeProvider",
    );
  }
  return v;
}

/** Null if outside the provider — for the header, which may render on pages without it. */
export function useDashboardCustomizeOptional(): DashboardCustomizeValue | null {
  return useContext(DashboardCustomizeContext);
}
