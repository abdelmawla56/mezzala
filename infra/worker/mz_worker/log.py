"""One JSON object per line on stdout. Metric lines use CloudWatch Embedded Metric Format, so the
awslogs driver turns them into metrics with no SDK and no agent."""
import json
import sys
import time


def log(event: str, **kw) -> None:
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **kw},
                     default=str), file=sys.stdout, flush=True)


def metric(name: str, value: float, unit: str = "Count", **dims) -> None:
    dims = {"Service": "media-worker", **dims}
    print(json.dumps({
        "_aws": {"Timestamp": int(time.time() * 1000),
                 "CloudWatchMetrics": [{"Namespace": "MEZZALA/Media", "Dimensions": [sorted(dims)],
                                        "Metrics": [{"Name": name, "Unit": unit}]}]},
        **dims, name: value}), flush=True)
