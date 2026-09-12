"use client";
import { useCallback, useEffect, useState } from "react";
import type { PollerSettings, PollerStatus } from "@/lib/collectors/contracts";

type Poller = {
  id: string;
  collectorId: string;
  deviceId: string;
  source: string;
  revision: number;
  appliedRevision: number;
  paused: boolean;
  deleted: boolean;
  settings: PollerSettings;
  status: PollerStatus | null;
};
type Collector = {
  id: string;
  name: string;
  destination: string;
  lastSeenAt: string | null;
};
type Device = { id: string; name: string; vendor: string };
const defaults: Record<string, PollerSettings> = {
  deepsea: {
    host: "",
    port: 502,
    unitId: 10,
    pollMs: 300000,
    pushMs: 300000,
    activePollMs: 15000,
    activePushMs: 60000,
    postRunMs: 3600000,
  },
  fronius: {
    inverters: [{ host: "", master: true, battery: true }],
    pollMs: 2000,
    pushMs: 60000,
  },
  selectronic: { pollMs: 60000, pushMs: 60000 },
  sigenergy: {
    region: "aus",
    authMode: "auto",
    pollMs: 300000,
    pushMs: 300000,
  },
};
export default function PollersPage() {
  const [pollers, setPollers] = useState<Poller[]>([]);
  const [collectors, setCollectors] = useState<Collector[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Poller | null>(null);
  const [source, setSource] = useState("deepsea");
  const [collectorId, setCollectorId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [settings, setSettings] = useState(
    JSON.stringify(defaults.deepsea, null, 2),
  );
  const [collectorName, setCollectorName] = useState("");
  const [destination, setDestination] = useState("");
  const [token, setToken] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/admin/pollers");
    const data = await r.json();
    if (!r.ok) throw Error(data.error);
    setPollers(data.pollers);
    setCollectors(data.collectors);
    setDevices(data.devices);
  }, []);
  useEffect(() => {
    const refresh = () => {
      load().catch((e) => setError(e.message));
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function mutate(path: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error);
      await load();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const inputClass =
    "rounded border border-gray-300 bg-white px-3 py-2 text-gray-900";
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Pollers</h1>
        <p className="mt-2 text-gray-600">
          Manage Gousher collection tasks. The shadow trial delivers to a
          private receiver; Usher remains the live generator controller.
        </p>
      </header>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}
      <section className="rounded border p-4">
        <h2 className="mb-3 text-lg font-semibold">Collectors</h2>
        {collectors.map((c) => (
          <p key={c.id} className="mb-2">
            <strong>{c.name}</strong> ·{" "}
            {c.lastSeenAt
              ? `Last seen ${new Date(c.lastSeenAt).toLocaleString()}`
              : "Not connected"}
            <br />
            <span className="text-sm text-gray-500">
              {c.id} · {c.destination}
            </span>
          </p>
        ))}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const result = await mutate("/api/admin/collectors", "POST", {
              name: collectorName,
              destination,
            });
            if (result) {
              setToken(result.token);
              setCollectorId(result.id);
            }
          }}
        >
          <input
            className={inputClass}
            aria-label="Collector name"
            placeholder="Collector name"
            value={collectorName}
            onChange={(e) => setCollectorName(e.target.value)}
            required
          />
          <input
            className={`${inputClass} grow`}
            type="url"
            aria-label="Private receiver URL"
            placeholder="https://private-receiver.example/capture"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            required
          />
          <button className={inputClass} disabled={busy}>
            Create collector
          </button>
        </form>
        {token && (
          <div className="mt-3 rounded bg-amber-50 p-3">
            <p>
              Save this collector token in deployment secrets. It is shown only
              once.
            </p>
            <code className="break-all">{token}</code>
            <button className="ml-3 underline" onClick={() => setToken("")}>
              Dismiss
            </button>
          </div>
        )}
      </section>
      <section className="overflow-x-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50">
            <tr>
              {[
                "Device / source",
                "Collector",
                "Revision",
                "Collection / delivery",
                "Actions",
              ].map((v) => (
                <th className="p-3" key={v}>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pollers.map((p) => {
              const pending = p.revision !== p.appliedRevision;
              const c = collectors.find((c) => c.id === p.collectorId);
              const offline =
                !c?.lastSeenAt ||
                Date.now() - Date.parse(c.lastSeenAt) > 120000;
              return (
                <tr key={p.id} className="border-t">
                  <td className="p-3">
                    {devices.find((d) => d.id === p.deviceId)?.name ??
                      p.deviceId}
                    <br />
                    {p.source} ·{" "}
                    {p.deleted ? "Deleted" : p.paused ? "Paused" : "Collecting"}
                  </td>
                  <td className="p-3">
                    {c?.name ?? p.collectorId}
                    {offline && <p className="text-amber-700">Offline</p>}
                  </td>
                  <td className="p-3">
                    Desired {p.revision} / applied {p.appliedRevision}
                    {pending && <p className="text-amber-700">Pending</p>}
                  </td>
                  <td className="p-3">
                    Read:{" "}
                    {p.status?.collectionAt
                      ? new Date(p.status.collectionAt).toLocaleString()
                      : "No samples"}
                    <br />
                    Delivered:{" "}
                    {p.status?.deliveryAt
                      ? new Date(p.status.deliveryAt).toLocaleString()
                      : "No deliveries"}
                    {p.status?.collectionStale && (
                      <p className="text-amber-700">Collection is stale</p>
                    )}
                    {p.status?.collectionError && (
                      <p className="text-red-700">
                        Collection: {p.status.collectionError}
                      </p>
                    )}
                    {p.status?.deliveryError && (
                      <p className="text-red-700">
                        Delivery: {p.status.deliveryError}
                      </p>
                    )}
                    {p.status?.error && (
                      <p className="text-red-700">{p.status.error}</p>
                    )}
                    {p.status?.storage && (
                      <p>
                        Spool: {p.status.storage.spoolBytes} bytes · Dropped:{" "}
                        {p.status.storage.dropped}
                      </p>
                    )}
                  </td>
                  <td className="space-x-2 p-3">
                    {!p.deleted && (
                      <>
                        <button
                          className="underline"
                          disabled={busy}
                          onClick={() => {
                            setEditing(p);
                            setSource(p.source);
                            setSettings(JSON.stringify(p.settings, null, 2));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="underline"
                          disabled={busy}
                          onClick={() =>
                            mutate(`/api/admin/pollers/${p.id}`, "PATCH", {
                              revision: p.revision,
                              paused: !p.paused,
                            })
                          }
                        >
                          {p.paused ? "Resume" : "Pause"}
                        </button>
                        <button
                          className="text-red-700 underline"
                          disabled={busy}
                          onClick={() => {
                            if (
                              window.confirm(
                                "Delete this poller? The device and its readings will remain.",
                              )
                            )
                              mutate(`/api/admin/pollers/${p.id}`, "DELETE", {
                                revision: p.revision,
                              });
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pollers.length && (
          <p className="p-6 text-gray-500">No pollers configured.</p>
        )}
      </section>
      <form
        className="space-y-3 rounded border p-4"
        onSubmit={async (e) => {
          e.preventDefault();
          let parsed: unknown;
          try {
            parsed = JSON.parse(settings);
          } catch {
            setError("Settings must be valid JSON");
            return;
          }
          const result = editing
            ? await mutate(`/api/admin/pollers/${editing.id}`, "PATCH", {
                revision: editing.revision,
                settings: parsed,
              })
            : await mutate("/api/admin/pollers", "POST", {
                collectorId,
                deviceId,
                source,
                settings: parsed,
                paused: true,
              });
          if (result) setEditing(null);
        }}
      >
        <h2 className="text-lg font-semibold">
          {editing ? "Edit poller settings" : "Create poller"}
        </h2>
        {!editing && (
          <div className="flex flex-wrap gap-2">
            <select
              className={inputClass}
              aria-label="Source"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setDeviceId("");
                setSettings(JSON.stringify(defaults[e.target.value], null, 2));
              }}
            >
              {Object.keys(defaults).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select
              className={inputClass}
              aria-label="Device"
              required
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            >
              <option value="">Choose device</option>
              {devices
                .filter(
                  (d) =>
                    d.vendor === (source === "fronius" ? "fusher" : source),
                )
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
            <select
              className={inputClass}
              aria-label="Collector"
              required
              value={collectorId}
              onChange={(e) => setCollectorId(e.target.value)}
            >
              <option value="">Choose collector</option>
              {collectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="block">
          Settings
          <textarea
            className={`${inputClass} mt-1 block w-full font-mono text-sm`}
            rows={12}
            value={settings}
            onChange={(e) => setSettings(e.target.value)}
            spellCheck={false}
          />
        </label>
        <p className="text-sm text-gray-500">
          New pollers start paused. Host addresses must also be allowed by the
          collector’s bootstrap settings.
        </p>
        <button className={inputClass} disabled={busy}>
          {editing ? "Save settings" : "Create paused poller"}
        </button>
        {editing && (
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => setEditing(null)}
          >
            Cancel
          </button>
        )}
      </form>
    </main>
  );
}
