"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle, AlertCircle } from "lucide-react";

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
  addSystemFlow?: "credentials" | "oauth-redirect";
}

interface UpdateCredentialsModalProps {
  systemId: number;
  displayName: string;
  vendorType: string;
  onClose: () => void;
  onUpdated?: () => void;
}

/**
 * Rotate an existing system's vendor credentials (e.g. a new Amber API key). Mirrors
 * AddSystemDialog's test-before-commit flow: the new credentials must pass a live connection
 * test before Save is enabled, then they're written to the owner's Clerk metadata via
 * PUT /api/systems/[systemId]/credentials. Fields start blank — we never round-trip the
 * existing secret to the browser.
 */
export default function UpdateCredentialsModal({
  systemId,
  displayName,
  vendorType,
  onClose,
  onUpdated,
}: UpdateCredentialsModalProps) {
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);

  const { data: vendorsData } = useQuery({
    queryKey: ["addSystem", "options"],
    queryFn: () => fetchJson<{ vendors: VendorInfo[] }>("/api/vendors"),
  });

  const vendorInfo = useMemo(
    () => vendorsData?.vendors.find((v) => v.vendorType === vendorType),
    [vendorsData, vendorType],
  );
  const fields = vendorInfo?.credentialFields ?? [];

  const handleFieldChange = (name: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [name]: value }));
    setError(null);
    // Any edit invalidates a prior successful test — force a re-test before save.
    setTestSuccess(false);
  };

  const canTest = () =>
    fields.length > 0 &&
    fields.filter((f) => f.required).every((f) => credentials[f.name]?.trim());

  const testMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorType, credentials }),
      });
      const data = await response.json();
      if (response.ok && data.success) return data;
      throw new Error(data.error || "Connection test failed");
    },
    onMutate: () => {
      setError(null);
      setTestSuccess(false);
    },
    onSuccess: () => setTestSuccess(true),
    onError: (err) =>
      setError(err instanceof Error ? err.message : "Connection test failed"),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/systems/${systemId}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials }),
      });
      const data = await response.json();
      if (response.ok && data.success) return data;
      throw new Error(data.error || "Failed to update credentials");
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      onUpdated?.();
      onClose();
    },
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Failed to update credentials",
      ),
  });

  const isTesting = testMutation.isPending;
  const isSaving = saveMutation.isPending;
  const busy = isTesting || isSaving;

  const handleOpenChange = (open: boolean) => {
    if (!open && !busy) onClose();
  };

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Update Credentials</DialogTitle>
          <DialogDescription>
            Enter new credentials for {displayName}
            {vendorInfo ? ` (${vendorInfo.displayName})` : ""}. They&apos;re
            tested against the vendor before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {fields.map((field) => (
            <div key={field.name}>
              <Label htmlFor={`cred-${field.name}`} className="block mb-[10px]">
                {field.label}
                {field.required && <span className="text-red-500 ml-1">*</span>}
              </Label>
              <Input
                id={`cred-${field.name}`}
                type={field.type}
                placeholder={field.placeholder}
                value={credentials[field.name] || ""}
                onChange={(e) => handleFieldChange(field.name, e.target.value)}
                disabled={busy}
                autoComplete="off"
              />
              {field.helpText && (
                <p className="text-xs text-gray-500 mt-1">{field.helpText}</p>
              )}
            </div>
          ))}

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
                Connection successful — save to apply.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={busy}
            className="w-[140px]"
          >
            Cancel
          </Button>
          {!testSuccess ? (
            <Button
              onClick={() => testMutation.mutate()}
              disabled={!canTest() || busy}
              className="w-[140px]"
            >
              {isTesting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing
                </>
              ) : (
                "Test Connection"
              )}
            </Button>
          ) : (
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={isSaving}
              className="bg-green-600 hover:bg-green-700 w-[140px]"
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
