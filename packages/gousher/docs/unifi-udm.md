# UniFi UDM: independent WireGuard VPN client

Use this guide to add a separate outbound WireGuard connection from a UniFi UDM to
an independent trial host. Keep actual site names, endpoint addresses, device
addresses, peer keys, router backups and generated configurations in private
administration records outside this repository. The [client template](../deploy/wireguard/udm-client.conf.example)
uses documentation-only addresses and placeholder keys; it is not importable as-is.

## Configure your UDM — quick start

**Have these ready:** a prepared WireGuard host and its matching private client
`.conf` file. If you are preparing the file yourself, start with the
[client template](../deploy/wireguard/udm-client.conf.example) and the
[configuration checklist below](#prepare-the-client-file). The example file's
addresses and keys must be replaced before use.

1. **Save a backup.** Open UniFi Network → **Settings → Control Plane → Backups**.
   Create a fresh backup and download it. Keep the file privately.
2. **Check the tunnel address range.** Open **Settings → Networks** and compare
   the subnets with your proposed tunnel range. Also check existing VPNs and custom
   routes. If a range overlaps, have the host and client configs corrected together
   before continuing. [Details below](#prepare).
3. **Add the client.** Open **Settings → VPN → VPN Client → Create New**.
   Choose **WireGuard**, give it a distinct name such as `collector-trial`, and
   choose **File**. Upload your generated `.conf` file.
   On a Mac, **⌘⇧G** in the file picker lets you paste the full path to a file in
   a hidden folder. The `.conf.example` file is a template, not the upload file.
4. **Leave both wizards Off.** Set **Device Wizard → Off** and
   **Content Wizard → Off**. Keep the imported MTU. Do not select devices or
   networks: this first step establishes only the tunnel connection.
5. **Check for errors and create.** Look directly below the uploaded filename.
   If you see **Invalid DNS in [Interface]**, add `DNS = 1.1.1.1` (or your chosen
   reachable DNS IPv4 address) under `[Interface]` in the file, then **upload the
   file again**. Once validation passes, click **Create**. The Connection panel
   may not expand in file mode; this alone is not an error.
6. **Confirm connection.** The new client should show **Connected** or
   **Established**. Verify a recent handshake on the host too, and confirm the
   original VPN is still established. If the new client stays Connecting, check
   the host's public endpoint, UDP listener and matching keys; adding device
   routing will not fix authentication or endpoint reachability.

**Done for the initial setup.** Leave the new client connected with both wizards
Off. Device access is a separate step after supervision and qualification checks.
To undo this setup, disable only the new client.

### Prepare the client file

Use the template with these deployment-specific values:

| Field | What to supply |
| --- | --- |
| `[Interface] PrivateKey` | Fresh private key for this UDM; its public key must be configured on the host |
| `Address` | The chosen UDM tunnel address with `/32` |
| **`DNS`** | **An explicit resolver IPv4 address, such as `1.1.1.1`; never omit it** |
| `MTU` | The value agreed with the host; template uses `1280` |
| `[Peer] PublicKey` | The host's public key |
| `PresharedKey` | The same fresh preshared key configured on the host |
| `AllowedIPs` | Only the host's tunnel address with `/32` for initial setup |
| `Endpoint` | The host's reachable public IPv4 or DNS name followed by `:51820` |
| `PersistentKeepalive` | `25` |

Use WireGuard tooling or a trusted configuration generator for fresh keys. For
example, `wg genkey` generates a private key, `wg pubkey` derives the public key
from a private key supplied on standard input, and `wg genpsk` generates a shared
preshared key. Keep the resulting secrets in private files; never paste them into
chat, screenshots or Git. See the [official WireGuard setup guide](https://www.wireguard.com/quickstart/).

## Required DNS field — do not omit when generating configs

UniFi Network **10.6.101** rejected a client file without `DNS` with this error:

```text
Invalid DNS in [Interface]. Use: DNS = IP Address
```

**Always emit an explicit DNS IPv4 address in the `[Interface]` section.** The
checked-in template uses `DNS = 1.1.1.1`, a public resolver. Choose an appropriate,
reachable resolver for the deployment. Do not leave the field blank, substitute a
hostname, or point it at a trial host that does not provide DNS. A VPN endpoint
specified as an IP address does not remove the importer's DNS-field requirement.

Generic WireGuard tooling may accept a file without DNS; that is not sufficient
validation for UniFi's importer. Before writing generated configurations, validate
that `[Interface]` contains exactly one nonempty `DNS` value and that it is a valid
IPv4 address. Test generation with DNS present, absent, blank and malformed. Keep
the host-side configuration separate; this requirement concerns the UDM client
import and does not imply installing a DNS resolver on the host.

The DNS entry does not require a default tunnel route. Keep `AllowedIPs` scoped to
the intended remote tunnel address for the initial handshake stage. Device traffic
routing is a separate UniFi setting; do not enable it to resolve an import error.
See [Ubiquiti's client configuration reference](https://help.ui.com/hc/en-us/articles/16357883221015-UniFi-Gateway-WireGuard-VPN-Client).

## Prepare

1. In **Settings → Control Plane → Backups**, create and download a current backup.
   Store it privately. See [Ubiquiti's backup guide](https://help.ui.com/hc/en-us/articles/360008976393-Backups-and-Migration-in-UniFi).
2. Check **Settings → Networks**, existing VPN clients, VPN servers, site-to-site
   connections and custom routes for overlap with the proposed tunnel addresses.
   Check containing ranges as well as exact matches. A blank subnet column does
   not prove that a service is inactive or has no routes; inspect the routing
   configuration if a relevant range is not visible.
3. Record the existing production client's name and connected status. Provision
   the independent host and its UDP listener before applying the new client.
4. Generate fresh matched keys and a preshared key. Never reuse an active peer's
   identity on another host. Keep private files mode 0600 in a private directory
   mode 0700. Validate the DNS field and all resolved placeholders before import.

For the initial handshake stage, the router peer's `AllowedIPs` contains only the
remote host tunnel address. The host peer allows only the router tunnel address.
Do not put local device addresses in the router's remote AllowedIPs. Host-side
firewall blocks and disabled forwarding keep device access unavailable until the
[isolated trial qualification gates](isolated-trial.md) pass.

## Import in UniFi Network

1. Open **Settings → VPN → VPN Client → Create New**. VPN Client is the setup
   category; VPN Server and Site-to-Site VPN are only inspected for conflicts.
2. Select **WireGuard**, enter a new client name, select **File**, and upload the
   generated client `.conf` file. Do not upload a `.conf.example` template.
3. Keep **Device Wizard: Off** and **Content Wizard: Off**. Those wizards create
   policy-based routes. Do not select devices, networks, domains, IPs or regions.
4. Verify the configured MTU (1280 in the template), client address, endpoint and
   allowed remote address. File mode may show a **Connection** section that does
   not expand; inspect the local file privately if values are not displayed.
5. Check for inline validation errors directly below the uploaded filename before
   clicking **Create**. An enabled Create button does not prove the file is valid.
6. If the DNS error appears, correct the file's `[Interface]` DNS entry and upload
   it again. The browser retains the earlier uploaded contents; editing the local
   file alone does not update the form. Cancel and reopen the unsaved form if the
   UI offers no way to replace the upload. Preserve the existing keys when fixing
   DNS; this correction does not require regenerating the configuration pair.
7. Once validation passes, create the client and confirm the existing production
   client remains established. Do not add device routing or firewall permissions
   merely to establish a handshake.

## Verify and stop at the handshake stage

On the independent host, inspect `wg show INTERFACE latest-handshakes` and
`wg show INTERFACE transfer`. Confirm a recent handshake for the expected router
public key, and verify the host's route and firewall restrictions. Do not use
`wg showconf` or dump output in shared logs because they can expose private keys.

A handshake verifies authentication and UDP reachability. It does not qualify LAN
access, DNS service, safe device polling or the supervisor's shutdown path. Keep
the collector stopped until those gates pass. If rollback is needed, disable only
the newly created client and its trial-specific rules; preserve the production VPN.
