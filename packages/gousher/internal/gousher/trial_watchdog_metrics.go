package gousher

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"
)

func (w *TrialWatchdog) telemetryPayload(now time.Time) any {
	attr := func(k, v string) any { return map[string]any{"key": k, "value": map[string]string{"stringValue": v}} }
	attrs := []any{attr("service", "liveone-trial-supervisor"), attr("service.instance.id", w.telemetryInstance), attr("environment", "production"), attr("poller.id", w.cfg.PollerID), map[string]any{"key": "revision", "value": map[string]string{"intValue": strconv.Itoa(w.cfg.Revision)}}, attr("policy.id", w.cfg.PolicyID), attr("reason", "supervision-unavailable")}
	return map[string]any{"resourceMetrics": []any{map[string]any{
		"resource": map[string]any{"attributes": []any{attr("service.name", "liveone-trial-supervisor"), attr("service.instance.id", w.telemetryInstance), attr("service.version", os.Getenv("SERVICE_VERSION"))}},
		"scopeMetrics": []any{map[string]any{"scope": map[string]string{"name": "liveone/watchdog"}, "metrics": []any{map[string]any{
			"name": "liveone.trial.shutdown.requests", "unit": "{request}", "sum": map[string]any{"aggregationTemporality": 2, "isMonotonic": true, "dataPoints": []any{map[string]any{
				"attributes": attrs, "startTimeUnixNano": strconv.FormatInt(w.telemetryStarted.UnixNano(), 10), "timeUnixNano": strconv.FormatInt(now.UnixNano(), 10), "asInt": strconv.FormatUint(w.stopRequests.Load(), 10),
			}}},
		}}}},
	}}}
}

// Independent export loop: a failed telemetry destination cannot delay permit
// renewal or shutdown. The counter is cumulative for this process lifetime.
func (w *TrialWatchdog) RunTelemetry(ctx context.Context, endpoint, token string) {
	if endpoint == "" && token == "" {
		return
	}
	for ctx.Err() == nil {
		if err := exportTelemetryPayload(ctx, endpoint, token, w.telemetryPayload(time.Now())); err != nil {
			log.Print("watchdog telemetry unavailable")
		}
		if !sleep(ctx, time.Minute) {
			return
		}
	}
}
