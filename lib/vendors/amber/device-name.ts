import type { AmberSite } from "./types";

export function amberDeviceName(
  site: Pick<AmberSite, "network" | "nmi">,
): string {
  return `Amber ${site.network} NMI ${site.nmi}`;
}

/** Read the identity of the stored site, never the first site available to an API key. */
export async function readAmberIdentity(apiKey: string, siteId: string) {
  const response = await fetch("https://api.amber.com.au/v1/sites", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Amber identity request failed (${response.status})`);
  const sites: unknown = await response.json();
  if (!Array.isArray(sites))
    throw new Error("Amber returned an invalid site list");
  const site = sites.find((value) => value && value.id === siteId);
  if (!site)
    throw new Error("The device's stored site was not returned by Amber");
  if (
    typeof site.network !== "string" ||
    !site.network.trim() ||
    typeof site.nmi !== "string" ||
    !site.nmi.trim()
  )
    throw new Error("Amber returned an incomplete distributor or NMI");
  return {
    vendorSiteId: siteId,
    distributor: site.network as string,
    nmi: site.nmi as string,
    suggestedName: amberDeviceName(site),
  };
}
