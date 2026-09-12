"use client";

import { createContext, useContext, useState, useCallback } from "react";

interface ModalContextType {
  isAnyModalOpen: boolean;
  registerModal: (id: string) => void;
  unregisterModal: (id: string) => void;
}

const ModalContext = createContext<ModalContextType | undefined>(undefined);

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [openModals, setOpenModals] = useState<Set<string>>(new Set());

  const registerModal = useCallback((id: string) => {
    setOpenModals((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unregisterModal = useCallback((id: string) => {
    setOpenModals((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const isAnyModalOpen = openModals.size > 0;

  return (
    <ModalContext.Provider
      value={{ isAnyModalOpen, registerModal, unregisterModal }}
    >
      {children}
    </ModalContext.Provider>
  );
}

export function useModalContext() {
  const context = useContext(ModalContext);
  if (context === undefined) {
    // Return no-op functions if not within a provider (e.g., admin pages)
    // This allows modals to work everywhere without requiring ModalProvider
    return {
      isAnyModalOpen: false,
      registerModal: () => {},
      unregisterModal: () => {},
    };
  }
  return context;
}
