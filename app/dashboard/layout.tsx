import { ModalProvider } from "@/contexts/ModalContext";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ModalProvider>{children}</ModalProvider>;
}
