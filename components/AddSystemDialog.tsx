"use client";

import { useState, useEffect, useRef } from "react";
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
import CompositeTab from "./CompositeTab";

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
}

interface AddSystemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddSystemDialog({ open, onOpenChange }: AddSystemDialogProps) {
  const router = useRouter();
  const [compositeName, setCompositeName] = useState("");
  const [isCompositeDirty, setIsCompositeDirty] = useState(false);
  const compositeSaveRef = useRef<(() => Promise<any>) | null>(null);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [selectedVendor, setSelectedVendor] = useState<string>("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);
  const [systemInfo, setSystemInfo] = useState<any>(null);

  // Register this modal with the global modal context
  const { registerModal, unregisterModal } = useModalContext();
  useEffect(() => {
    if (open) {
      registerModal("add-system-dialog");
    } else {
      unregisterModal("add-system-dialog");
    }
    return () => unregisterModal("add-system-dialog");
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
      setCompositeName("");
      setIsCompositeDirty(false);
      setSelectedVendor("");
      setCredentials({});
      setError(null);
      setTestSuccess(false);
      setSystemInfo(null);
    }
    onOpenChange(newOpen);
  };

  // Fetch available vendors
  useEffect(() => {
    async function fetchVendors() {
      try {
        const response = await fetch("/api/vendors");
        if (response.ok) {
          const data = await response.json();
          setVendors(
            data.vendors.filter(
              (v: VendorInfo) =>
                v.credentialFields && v.credentialFields.length > 0,
            ),
          );
        }
      } catch (err) {
        console.error("Failed to fetch vendors:", err);
      }
    }

    if (open) {
      fetchVendors();
      // Reset state when dialog opens
      setCompositeName("");
      setIsCompositeDirty(false);
      setSelectedVendor("");
      setCredentials({});
      setError(null);
      setTestSuccess(false);
      setSystemInfo(null);
    }
  }, [open]);

  const selectedVendorInfo = vendors.find(
    (v) => v.vendorType === selectedVendor,
  );

  const handleVendorChange = (vendorType: string) => {
    setSelectedVendor(vendorType);
    setCredentials({});
    setCompositeName("");
    setIsCompositeDirty(false);
    setError(null);
    setTestSuccess(false);
    setSystemInfo(null);
  };

  const isComposite = selectedVendor === "composite";

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

  const handleTestConnection = async () => {
    if (!canTestConnection()) return;

    setIsTesting(true);
    setError(null);
    setTestSuccess(false);

    try {
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
        setTestSuccess(true);
        setSystemInfo(data.systemInfo);
      } else {
        setError(data.error || "Connection test failed");
      }
    } catch (err) {
      setError("Failed to test connection. Please try again.");
    } finally {
      setIsTesting(false);
    }
  };

  const handleCreateSystem = async () => {
    if (isComposite) {
      return handleCreateCompositeSystem();
    }

    if (!testSuccess || !selectedVendorInfo) return;

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch("/api/systems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorType: selectedVendor,
          credentials,
          systemInfo,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Success! Navigate to the new system
        onOpenChange(false);
        router.push(`/dashboard/${data.systemId}`);
        router.refresh();
      } else {
        setError(data.error || "Failed to create system");
      }
    } catch (err) {
      setError("Failed to create system. Please try again.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreateCompositeSystem = async () => {
    if (!compositeName.trim() || !compositeSaveRef.current) return;

    setIsCreating(true);
    setError(null);

    try {
      // Get composite mappings from CompositeTab
      const compositeMappings = await compositeSaveRef.current();

      const response = await fetch("/api/systems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorType: "composite",
          displayName: compositeName,
          metadata: {
            mappings: compositeMappings,
          },
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Success! Navigate to the new system
        onOpenChange(false);
        router.push(`/dashboard/${data.systemId}`);
        router.refresh();
      } else {
        setError(data.error || "Failed to create composite system");
      }
    } catch (err) {
      setError("Failed to create composite system. Please try again.");
    } finally {
      setIsCreating(false);
    }
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
          <DialogTitle>Add System</DialogTitle>
          <DialogDescription>
            Connect a new energy system to monitor its performance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 px-6 py-2">
          {/* Vendor Selection */}
          <div>
            <Label htmlFor="vendor" className="block mb-[10px]">
              System Type
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
                <SelectItem value="composite">
                  Composite (Combine Multiple Systems)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Composite System Fields */}
          {isComposite && (
            <>
              {/* Composite System Name */}
              <div>
                <Label
                  htmlFor="compositeName"
                  className="block mt-[16px] mb-[10px]"
                >
                  System Name
                  <span className="text-red-500 ml-1">*</span>
                </Label>
                <Input
                  id="compositeName"
                  type="text"
                  placeholder="e.g., My Combined System"
                  value={compositeName}
                  onChange={(e) => setCompositeName(e.target.value)}
                  disabled={isCreating}
                />
              </div>

              {/* Composite Configuration */}
              <div className="space-y-1">
                <h3 className="text-sm font-medium">Data Sources</h3>
                <CompositeTab
                  systemId={-1}
                  shouldLoad={true}
                  onDirtyChange={setIsCompositeDirty}
                  onSaveFunctionReady={(fn) => {
                    compositeSaveRef.current = fn;
                  }}
                />
              </div>
            </>
          )}

          {/* Dynamic Credential Fields */}
          {selectedVendorInfo && (
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
                {systemInfo && (
                  <div className="mt-2 text-sm">
                    {systemInfo.model && <div>Model: {systemInfo.model}</div>}
                    {systemInfo.serial && (
                      <div>Serial: {systemInfo.serial}</div>
                    )}
                    {systemInfo.solarSize && (
                      <div>Solar: {systemInfo.solarSize}</div>
                    )}
                    {systemInfo.batterySize && (
                      <div>Battery: {systemInfo.batterySize}</div>
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

          {isComposite ? (
            <Button
              onClick={handleCreateSystem}
              disabled={
                !compositeName.trim() || !isCompositeDirty || isCreating
              }
              className="bg-green-600 hover:bg-green-700 w-[140px]"
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating System
                </>
              ) : (
                "Create System"
              )}
            </Button>
          ) : !testSuccess ? (
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
              onClick={handleCreateSystem}
              disabled={isCreating}
              className="bg-green-600 hover:bg-green-700 w-[140px]"
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating System
                </>
              ) : (
                "Create System"
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
