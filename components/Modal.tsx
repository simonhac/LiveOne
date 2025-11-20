"use client";

import { useEffect, ReactNode } from "react";
import { useModalContext } from "@/contexts/ModalContext";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
  modalId: string;
}

/**
 * Reusable Modal wrapper component that automatically handles:
 * - Registration with ModalContext (pauses polling when open)
 * - Common modal styling and behavior
 * - Future common modal features
 *
 * Usage:
 * <Modal isOpen={isOpen} onClose={onClose} modalId="unique-modal-id">
 *   <div>Your modal content here</div>
 * </Modal>
 */
export default function Modal({
  isOpen,
  onClose,
  children,
  modalId,
}: ModalProps) {
  const { registerModal, unregisterModal } = useModalContext();

  // Register/unregister modal based on isOpen state
  useEffect(() => {
    if (isOpen) {
      registerModal(modalId);
    } else {
      unregisterModal(modalId);
    }

    // Cleanup on unmount
    return () => {
      unregisterModal(modalId);
    };
  }, [isOpen, modalId, registerModal, unregisterModal]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50 z-50"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div className="fixed inset-0 z-50 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          {children}
        </div>
      </div>
    </>
  );
}
