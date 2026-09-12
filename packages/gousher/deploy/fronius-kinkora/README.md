# First trial: Fronius at Kinkora

Selected by the user on 2026-09-13. Repository production configuration identifies one aggregated
site (`kinkora`) with master `10.0.1.190` and slave `10.0.1.191`, sampled every two seconds and
harvested every minute. These are configuration references, not a new live discovery result.

`bootstrap.json` keeps replay mode and permits only two loopback forwarding destinations. The
LiveOne origin is inferred from production Usher's configured gush endpoint (`www.liveone.energy`).
Its collector configuration endpoint returned HTTP 404 in read-only preflight: deploy the management
API and migration before attempting enrollment. Do not substitute a production gusher key for a
scoped managed collector token.

Prepare restricted forwarding through the hub:

| Local destination | Hub-reachable inverter | Role |
| --- | --- | --- |
| `127.0.0.1:18080` | `10.0.1.190:80` | Master |
| `127.0.0.1:18081` | `10.0.1.191:80` | Slave |

Use the authenticated SSH recipe in [deployment.md](../../docs/deployment.md), with both exact
`permitopen` destinations. Provisioning and host-key verification are still outstanding. The shadow
assignment must use `pollMs=2000`, `pushMs=60000`, both forwarded hosts, exactly one master and the
battery flags confirmed from production discovery. Keep it paused initially. Resolve the existing
`fusher` device's UUID from the management API; the historical system number is not that UUID.

`trial-ops.json` is an incomplete configuration template. Fill the receiver/inspector/private
production-feed URLs, assigned poller ID/revision, measured baseline and actual dates before use.
The public Usher URL redirects to Cloudflare Access; this runner does not send Access service-token
headers, so it cannot use that redirect as a production evidence feed. Provide authenticated private
HTTPS forwarding as specified in the deployment recipe. The dedicated monitor bearer token remains
required. Never disable Access or share a production device delivery credential to make this work.

For this site, production read metrics come from the two real background inverter reads, not the
cached minutely harvest. A complete 15-minute window normally has about 900 attempts. The suggested
minimum of 800 is an initial coverage threshold to review against measured scheduling and outages,
not a measured baseline. The bounded monitor supports 1024 attempts per window; overflow is unhealthy.
Failed reads (including malformed responses) count toward failure rate. Discovery is not included in
this recurring-read metric. New baseline measurement is mandatory after deploying the monitoring fix.

Enable capture and the monitor in the production Usher only when its reviewed build is deployed.
Collect a full post-startup baseline before enabling the shadow reader. Both inverters are needed to
compare the aggregated site; a one-inverter run is only a connectivity check. Then qualify coexistence
and verify the independent shutdown path before daily comparisons and the seven-clean-day count.
Fronius energy comparisons need compatible harvest boundaries and earlier integration state; startup
and retained-context limitations are described in [automation.md](../../docs/automation.md).

No trial app, tunnel, production setting or device read has been changed by this preparation.
