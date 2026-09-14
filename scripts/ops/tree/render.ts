import type { TreeInventory } from "@/lib/inventory/types";
interface Node {
  label: string;
  children?: Node[];
}
const text = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const sorted = <T extends { id: string; name: string }>(rows: T[]) =>
  [...rows].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
const status = (value: string) => (value === "active" ? "" : ` [${value}]`);

export function renderTree(
  inventory: TreeInventory,
  options: { points: boolean; bindings: boolean },
): string {
  const people = new Map(inventory.users.map((u) => [u.id, u.email || u.name]));
  const deviceMap = new Map(inventory.devices.map((d) => [d.id, d]));
  const pointMap = new Map(inventory.points.map((p) => [p.id, p]));
  const areaMap = new Map(inventory.areas.map((a) => [a.id, a]));
  const dashboardMap = new Map(inventory.dashboards.map((d) => [d.id, d]));
  const person = (id: string | null) =>
    id ? (people.get(id) ?? id) : "No owner";
  function sharing(id: string): Node[] {
    const result: Node[] = [];
    for (const share of inventory.sharing?.dashboards ?? []) {
      if (
        share.id !== id &&
        !share.areaIds.includes(id) &&
        !share.deviceIds.includes(id)
      )
        continue;
      const access = [
        ...share.recipients.map(
          (r) => `${r.label ?? person(r.userId)} (${r.role})`,
        ),
        ...(share.activeLinks
          ? [`${share.activeLinks} active share link(s)`]
          : []),
      ];
      result.push({
        label: `Shared via dashboard ${dashboardMap.get(share.id)?.name ?? share.id}: ${access.join(", ")}`,
      });
    }
    const calendar = inventory.sharing?.calendars.find((c) => c.areaId === id);
    if (calendar)
      result.push({
        label: `Calendar sharing: ${calendar.activeLinks} active feed link(s) [schedule only]`,
      });
    return result;
  }
  function derivationNode(d: TreeInventory["derivations"][number]): Node {
    return {
      label: `Derivation: ${d.name} (${d.id}; ${d.kind}${d.role ? `/${d.role}` : ""}) [${d.enabled ? "enabled" : "disabled"}]`,
      children: [
        ...[...d.sources]
          .sort((a, b) => a.slot.localeCompare(b.slot))
          .map((s) => ({
            label: `${s.slot} → ${deviceMap.get(s.deviceId)?.name ?? s.deviceId} / ${pointMap.get(s.pointId)?.path ?? s.pointId}`,
          })),
        {
          label: `History: ${d.history.intervals} interval(s)${d.history.latest ? `, latest ${d.history.latest}` : ""}`,
          children: d.history.provenance.map((p) => ({
            label: `Interval provenance via ${areaMap.get(p.areaId)?.name ?? p.areaId}: ${p.intervals} record(s)`,
          })),
        },
        ...(d.outputPointId
          ? [
              {
                label: `Output → ${pointMap.get(d.outputPointId)?.path ?? d.outputPointId}`,
              },
            ]
          : []),
      ],
    };
  }
  const primaryDevice = (d: TreeInventory["derivations"][number]) =>
    (d.outputPointId ? pointMap.get(d.outputPointId)?.deviceId : undefined) ??
    d.sources.find((s) => s.slot === "signal")?.deviceId ??
    [...d.deviceIds].sort()[0];
  function deviceNode(
    d: TreeInventory["devices"][number],
    areaOwner: string | null,
  ): Node {
    const pts = sorted(inventory.points.filter((p) => p.deviceId === d.id));
    const children: Node[] = [
      ...sharing(d.id),
      {
        label: "History",
        children: [
          {
            label: d.history.daily
              ? `Daily aggregates: ${d.history.daily.rows} point-day rows, ${d.history.daily.startDay} → ${d.history.daily.endDay}`
              : "Daily aggregates: none",
          },
          {
            label: `Last successful collection: ${d.history.lastSuccess ?? "none recorded"}`,
          },
        ],
      },
      {
        label: `Points: ${pts.length} (${pts.filter((p) => !p.active).length} inactive, ${pts.filter((p) => p.control).length} controls)`,
        ...(options.points || d.vendor === "helper"
          ? {
              children: pts.map((p) => ({
                label: `${p.path} [${p.metric}${p.unit ? `; ${p.unit}` : ""}] (${p.id})${p.active ? "" : " [inactive]"} [${p.control ? "control" : "sensor"}]`,
              })),
            }
          : {}),
      },
    ];
    for (const derivation of sorted(
      inventory.derivations.filter((x) => x.deviceIds.includes(d.id)),
    )) {
      children.push(
        primaryDevice(derivation) === d.id
          ? derivationNode(derivation)
          : {
              label: `Derivation reference → ${derivation.name} (${derivation.id}) [${derivation.enabled ? "enabled" : "disabled"}]`,
            },
      );
    }
    return {
      label: `Device #${d.handle}: ${d.name} [${d.vendor}]${status(d.status)}${d.ownerId !== areaOwner ? ` [owner: ${person(d.ownerId)}]` : ""}`,
      children,
    };
  }
  function areaNode(a: TreeInventory["areas"][number]): Node {
    const members = sorted(inventory.devices.filter((d) => d.areaId === a.id));
    const bindings = inventory.bindings
      .filter((b) => b.areaId === a.id)
      .sort(
        (x, y) =>
          x.role.localeCompare(y.role) ||
          x.metric.localeCompare(y.metric) ||
          x.priority - y.priority ||
          x.id.localeCompare(y.id),
      );
    const p = a.provenance;
    const children: Node[] = [
      ...sharing(a.id),
      ...members.map((d) => deviceNode(d, a.ownerId)),
      ...sorted(inventory.automations.filter((x) => x.areaId === a.id)).map(
        (x) => ({
          label: `Automation: ${x.name} (${x.id}; ${x.mode}) [${x.enabled ? "enabled" : "disabled"}]`,
          children: [
            { label: `Trigger: ${x.trigger}` },
            { label: `Action: ${x.action}` },
            { label: `Last triggered: ${x.lastTriggered ?? "none recorded"}` },
          ],
        }),
      ),
      {
        label: `Bindings: ${bindings.length}`,
        ...(options.bindings
          ? {
              children: bindings.map((b) => ({
                label: `${b.role}/${b.metric} → ${deviceMap.get(pointMap.get(b.pointId)?.deviceId ?? "")?.name ?? "external point"} / ${pointMap.get(b.pointId)?.path ?? b.pointId} [priority ${b.priority}] (${b.id})`,
              })),
            }
          : {}),
      },
      {
        label: "Provenance",
        children: [
          {
            label: `Battery history: ${p.batteryDays} day(s)${p.batteryLastDay ? `, latest ${p.batteryLastDay}` : ""}`,
          },
          {
            label: `Flow attribution: ${p.flowDays} day(s)${p.flowLastDay ? `, latest ${p.flowLastDay}` : ""}`,
          },
          ...members
            .filter((d) => d.vendor === "helper")
            .map((d) => ({
              label: `Derived outputs → ${d.name} (#${d.handle})`,
            })),
        ],
      },
    ];
    return {
      label: `Area: ${a.name} (${a.id})${status(a.status)}${members.length ? "" : " [no devices in scope]"}`,
      children,
    };
  }
  function ownerChildren(ownerId: string | null): Node[] {
    const children: Node[] = sorted(
      inventory.areas.filter((a) => a.ownerId === ownerId),
    ).map(areaNode);
    const unassigned = sorted(
      inventory.devices.filter((d) => d.ownerId === ownerId && !d.areaId),
    );
    if (unassigned.length)
      children.push({
        label: "Unassigned devices",
        children: unassigned.map((d) => deviceNode(d, ownerId)),
      });
    for (const d of sorted(
      inventory.devices.filter(
        (d) =>
          d.ownerId === ownerId &&
          d.areaId &&
          areaMap.get(d.areaId)?.ownerId !== ownerId,
      ),
    )) {
      const area = areaMap.get(d.areaId!);
      children.push(
        area
          ? {
              label: `Owned device #${d.handle}: ${d.name} → ${area.name} [area owner: ${person(area.ownerId)}]`,
            }
          : {
              label: `Placement outside inventory: ${d.areaId}`,
              children: [deviceNode(d, ownerId)],
            },
      );
    }
    for (const d of sorted(
      inventory.dashboards.filter((d) => d.ownerId === ownerId),
    ))
      children.push({
        label: `Dashboard: ${d.name} (${d.id})`,
        children: [
          ...sharing(d.id),
          ...d.areaIds.map((id) => ({
            label: `Area reference → ${areaMap.get(id)?.name ?? id}`,
          })),
          ...d.deviceIds.map((id) => ({
            label: `Device reference → ${deviceMap.get(id)?.name ?? id}`,
          })),
        ],
      });
    return children;
  }
  const roots: Node[] = sorted(inventory.users).map((u) => ({
    label: `${u.name}${u.email ? ` — ${u.email}` : ""}`,
    children: ownerChildren(u.id),
  }));
  const ownerless = ownerChildren(null);
  if (ownerless.length)
    roots.push({ label: "No owner / public", children: ownerless });
  const unattached = sorted(
    inventory.derivations.filter(
      (d) => !d.deviceIds.some((id) => deviceMap.has(id)),
    ),
  );
  if (unattached.length)
    roots.push({
      label: "Unattached derivations",
      children: unattached.map(derivationNode),
    });
  const lines = [`LiveOne (${inventory.scope}; ${inventory.generatedAt})`];
  function walk(nodes: Node[], prefix: string) {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      lines.push(`${prefix}${last ? "└── " : "├── "}${text(node.label)}`);
      if (node.children?.length)
        walk(node.children, prefix + (last ? "    " : "│   "));
    });
  }
  walk(roots, "");
  lines.push(
    "",
    `${inventory.users.length} users; ${inventory.areas.length} areas; ${inventory.devices.length} devices; ${inventory.derivations.length} derivations; ${inventory.automations.length} automations.`,
  );
  for (const warning of inventory.warnings)
    lines.push(`Note: ${text(warning)}`);
  return lines.join("\n");
}
