"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { useModalContext } from "@/contexts/ModalContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Loader2,
  CheckCircle,
  AlertCircle,
  MoreHorizontal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import TeslaConnectFlow from "./TeslaConnectFlow";

interface CredentialField {
  name: string;
  label: string;
  type: "text" | "email" | "password" | "url" | "number";
  placeholder?: string;
  required?: boolean;
  helpText?: string;
}

interface VendorInfo {
  vendorType: string;
  displayName: string;
  credentialFields: CredentialField[];
  addDeviceFlow?: "credentials" | "oauth-redirect";
}

interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddDeviceDialog({ open, onOpenChange }: AddDeviceDialogProps) {
  const router = useRouter();
  const [selectedVendor, setSelectedVendor] = useState<string>("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<any>(null);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    if (open) {
      registerModal("add-system-dialog");
      return () => unregisterModal("add-system-dialog");
    }
  }, [open, registerModal, unregisterModal]);

  // Handle dialog close - only allow closing via explicit actions
  const handleOpenChange = (newOpen: boolean) => {
    // Only allow closing if explicitly requested (not via overlay click)
    // The dialog will only close when we explicitly call onOpenChange(false)
    if (!newOpen && (isTesting || isCreating)) {
      // Prevent closing while operations are in progress
      return;
    }
    if (!newOpen) {
      // Reset state when closing
      setSelectedVendor("");
      setCredentials({});
      setError(null);
      setTestSuccess(false);
      setDeviceInfo(null);
    }
    onOpenChange(newOpen);
  };

  // Fetch available vendors when the dialog opens
  const { data: vendorsData } = useQuery({
    queryKey: ["addSystem", "options"],
    queryFn: () => fetchJson<{ vendors: VendorInfo[] }>("/api/vendors"),
    enabled: open,
  });

  const vendors = (vendorsData?.vendors ?? []).filter(
    (v) =>
      v.addDeviceFlow === "oauth-redirect" ||
      (v.credentialFields && v.credentialFields.length > 0),
  );

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedVendor("");
      setCredentials({});
      setError(null);
      setTestSuccess(false);
      setDeviceInfo(null);
    }
  }, [open]);

  const selectedVendorInfo = vendors.find(
    (v) => v.vendorType === selectedVendor,
  );

  const handleVendorChange = (vendorType: string) => {
    setSelectedVendor(vendorType);
    setCredentials({});
    setError(null);
    setTestSuccess(false);
    setDeviceInfo(null);
  };

  const isOAuthRedirect =
    selectedVendorInfo?.addDeviceFlow === "oauth-redirect";

  const handleOAuthConnected = (systemId: number) => {
    onOpenChange(false);
    router.push(`/device/${systemId}`);
    router.refresh();
  };

  const handleFieldChange = (fieldName: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [fieldName]: value }));
    setError(null);
  };

  const canTestConnection = () => {
    if (!selectedVendorInfo) return false;
    return selectedVendorInfo.credentialFields
      .filter((f) => f.required)
      .every((f) => credentials[f.name]?.trim());
  };

  const testMutation = useMutation({
    mutationFn: async () => {
      console.log("[Test Connection] Sending request with:", {
        vendorType: selectedVendor,
        credentials: Object.keys(credentials),
      });

      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorType: selectedVendor,
          credentials,
        }),
      });

      const data = await response.json();
      console.log("[Test Connection] Response:", response.status, data);

      if (response.ok && data.success) {
        return data;
      }
      throw new Error(data.error || "Connection test failed");
    },
    onMutate: () => {
      setError(null);
      setTestSuccess(false);
    },
    onSuccess: (data) => {
      setTestSuccess(true);
      setDeviceInfo(data.deviceInfo);
    },
    onError: (err) => {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to test connection. Please try again.",
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorType: selectedVendor,
          credentials,
          deviceInfo,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        return data;
      }
      throw new Error(data.error || "Failed to create system");
    },
    onMutate: () => {
      setError(null);
    },
    onSuccess: (data) => {
      // Success! Navigate to the new device
      onOpenChange(false);
      router.push(`/device/${data.systemId}`);
      router.refresh();
    },
    onError: (err) => {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to create system. Please try again.",
      );
    },
  });

  const isTesting = testMutation.isPending;
  const isCreating = createMutation.isPending;

  const handleTestConnection = () => {
    if (!canTestConnection()) return;
    testMutation.mutate();
  };

  const handleCreateDevice = () => {
    if (!testSuccess || !selectedVendorInfo) return;
    createMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[560px] max-h-[calc(100vh-100px)] flex flex-col"
        style={{
          maxHeight: "min(900px, calc(100vh - 100px))",
          minHeight: "540px",
        }}
      >
        <DialogHeader>
          <DialogTitle>Add Device</DialogTitle>
          <DialogDescription>
            Connect a new energy device to monitor its performance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 px-6 py-2">
          {/* Vendor Selection */}
          <div>
            <Label htmlFor="vendor" className="block mb-[10px]">
              Device Type
            </Label>
            <Select value={selectedVendor} onValueChange={handleVendorChange}>
              <SelectTrigger id="vendor">
                <SelectValue placeholder="Select a system type" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((vendor) => (
                  <SelectItem key={vendor.vendorType} value={vendor.vendorType}>
                    {vendor.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* OAuth redirect flow (Tesla Fleet API) */}
          {selectedVendorInfo && isOAuthRedirect && (
            <TeslaConnectFlow
              onConnected={handleOAuthConnected}
              disabled={isCreating}
            />
          )}

          {/* Dynamic Credential Fields */}
          {selectedVendorInfo && !isOAuthRedirect && (
            <div className="space-y-5 mt-9">
              {selectedVendorInfo.credentialFields.map((field) => (
                <div key={field.name} className="mt-[10px]">
                  <Label
                    htmlFor={field.name}
                    className="block mt-[16px] mb-[10px]"
                  >
                    {field.label}
                    {field.required && (
                      <span className="text-red-500 ml-1">*</span>
                    )}
                  </Label>
                  <Input
                    id={field.name}
                    type={field.type}
                    placeholder={field.placeholder}
                    value={credentials[field.name] || ""}
                    onChange={(e) =>
                      handleFieldChange(field.name, e.target.value)
                    }
                    disabled={isTesting || isCreating}
                  />
                  {field.helpText && (
                    <p className="text-xs text-gray-500 mt-1">
                      {field.helpText}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Error/Success Messages */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {testSuccess && (
            <Alert className="border-green-500 bg-green-50 dark:bg-green-950">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-600">
                Connection successful!
                {deviceInfo && (
                  <div className="mt-2 text-sm">
                    {deviceInfo.model && <div>Model: {deviceInfo.model}</div>}
                    {deviceInfo.serial && (
                      <div>Serial: {deviceInfo.serial}</div>
                    )}
                    {deviceInfo.solarSize && (
                      <div>Solar: {deviceInfo.solarSize}</div>
                    )}
                    {deviceInfo.batterySize && (
                      <div>Battery: {deviceInfo.batterySize}</div>
                    )}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6 flex-shrink-0 px-6 pt-4 border-t border-gray-700">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isTesting || isCreating}
            className="w-[140px]"
          >
            Cancel
          </Button>

          {!isOAuthRedirect &&
            (!testSuccess ? (
              <Button
                onClick={handleTestConnection}
                disabled={!canTestConnection() || isTesting || isCreating}
                className="w-[140px]"
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing Connection
                  </>
                ) : (
                  "Test Connection"
                )}
              </Button>
            ) : (
              <Button
                onClick={handleCreateDevice}
                disabled={isCreating}
                className="bg-green-600 hover:bg-green-700 w-[140px]"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating Device
                  </>
                ) : (
                  "Create System"
                )}
              </Button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
