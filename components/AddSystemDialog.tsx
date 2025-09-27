'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, CheckCircle, AlertCircle, MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface CredentialField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'password' | 'url' | 'number';
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
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [selectedVendor, setSelectedVendor] = useState<string>('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState(false);
  const [systemInfo, setSystemInfo] = useState<any>(null);

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
      setSelectedVendor('');
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
        const response = await fetch('/api/vendors');
        if (response.ok) {
          const data = await response.json();
          setVendors(data.vendors.filter((v: VendorInfo) => v.credentialFields && v.credentialFields.length > 0));
        }
      } catch (err) {
        console.error('Failed to fetch vendors:', err);
      }
    }

    if (open) {
      fetchVendors();
      // Reset state when dialog opens
      setSelectedVendor('');
      setCredentials({});
      setError(null);
      setTestSuccess(false);
      setSystemInfo(null);
    }
  }, [open]);

  const selectedVendorInfo = vendors.find(v => v.vendorType === selectedVendor);

  const handleVendorChange = (vendorType: string) => {
    setSelectedVendor(vendorType);
    setCredentials({});
    setError(null);
    setTestSuccess(false);
    setSystemInfo(null);
  };

  const handleFieldChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({ ...prev, [fieldName]: value }));
    setError(null);
  };

  const canTestConnection = () => {
    if (!selectedVendorInfo) return false;
    return selectedVendorInfo.credentialFields
      .filter(f => f.required)
      .every(f => credentials[f.name]?.trim());
  };

  const handleTestConnection = async () => {
    if (!canTestConnection()) return;

    setIsTesting(true);
    setError(null);
    setTestSuccess(false);

    try {
      console.log('[Test Connection] Sending request with:', {
        vendorType: selectedVendor,
        credentials: Object.keys(credentials)
      });

      const response = await fetch('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorType: selectedVendor,
          credentials
        })
      });

      const data = await response.json();
      console.log('[Test Connection] Response:', response.status, data);

      if (response.ok && data.success) {
        setTestSuccess(true);
        setSystemInfo(data.systemInfo);
      } else {
        setError(data.error || 'Connection test failed');
      }
    } catch (err) {
      setError('Failed to test connection. Please try again.');
    } finally {
      setIsTesting(false);
    }
  };

  const handleCreateSystem = async () => {
    if (!testSuccess || !selectedVendorInfo) return;

    setIsCreating(true);
    setError(null);

    try {
      const response = await fetch('/api/systems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vendorType: selectedVendor,
          credentials,
          systemInfo
        })
      });

      const data = await response.json();

      if (response.ok && data.success) {
        // Success! Navigate to the new system
        onOpenChange(false);
        router.push(`/dashboard/${data.systemId}`);
        router.refresh();
      } else {
        setError(data.error || 'Failed to create system');
      }
    } catch (err) {
      setError('Failed to create system. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add System</DialogTitle>
          <DialogDescription>
            Connect a new energy system to monitor its performance
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Vendor Selection */}
          <div className="space-y-2">
            <Label htmlFor="vendor">System Type</Label>
            <Select value={selectedVendor} onValueChange={handleVendorChange}>
              <SelectTrigger id="vendor">
                <SelectValue placeholder="Select a system type" />
              </SelectTrigger>
              <SelectContent>
                {vendors.map(vendor => (
                  <SelectItem key={vendor.vendorType} value={vendor.vendorType}>
                    {vendor.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Dynamic Credential Fields */}
          {selectedVendorInfo && (
            <div className="space-y-4">
              {selectedVendorInfo.credentialFields.map(field => (
                <div key={field.name} className="space-y-2">
                  <Label htmlFor={field.name}>
                    {field.label}
                    {field.required && <span className="text-red-500 ml-1">*</span>}
                  </Label>
                  <Input
                    id={field.name}
                    type={field.type}
                    placeholder={field.placeholder}
                    value={credentials[field.name] || ''}
                    onChange={(e) => handleFieldChange(field.name, e.target.value)}
                    disabled={isTesting || isCreating}
                  />
                  {field.helpText && (
                    <p className="text-xs text-gray-500">{field.helpText}</p>
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
                    {systemInfo.serial && <div>Serial: {systemInfo.serial}</div>}
                    {systemInfo.solarSize && <div>Solar: {systemInfo.solarSize}</div>}
                    {systemInfo.batterySize && <div>Battery: {systemInfo.batterySize}</div>}
                  </div>
                )}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isTesting || isCreating}>
            Cancel
          </Button>

          {!testSuccess ? (
            <Button
              onClick={handleTestConnection}
              disabled={!canTestConnection() || isTesting || isCreating}
            >
              {isTesting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Testing Connection
                </>
              ) : (
                'Test Connection'
              )}
            </Button>
          ) : (
            <Button
              onClick={handleCreateSystem}
              disabled={isCreating}
              className="bg-green-600 hover:bg-green-700"
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating System
                </>
              ) : (
                'Create System'
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}