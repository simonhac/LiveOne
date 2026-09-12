#!/usr/bin/env python3
"""Exercise compiled trial binaries on loopback with disposable storage only."""
import datetime as dt
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    return subprocess.run(args, cwd=ROOT, check=True, capture_output=True, text=True).stdout


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    with tempfile.TemporaryDirectory(prefix="gousher-deployment-") as directory:
        work = Path(directory)
        for name in ("gousher", "trial-receiver", "trial-ops"):
            run("go", "build", "-o", str(work / name), "./cmd/" + name)
        token = secrets.token_hex(32)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def request(path, data=None, authenticated=True):
            headers = {"Authorization": "Bearer " + token} if authenticated else {}
            req = urllib.request.Request(origin + path, data=data, headers=headers)
            try:
                with opener.open(req, timeout=3) as response:
                    return response.status, response.read()
            except urllib.error.HTTPError as error:
                return error.code, error.read()

        process = None

        def start():
            nonlocal process
            process = subprocess.Popen(
                [str(work / "trial-receiver"), "-data", str(work / "receiver"),
                 "-listen", f"127.0.0.1:{port}"],
                env={**os.environ, "GOUSHER_RECEIVER_TOKEN": token},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                check(process.poll() is None, "receiver exited during startup")
                try:
                    if request("/", authenticated=False)[0] == 401:
                        return
                except OSError:
                    pass
                time.sleep(0.05)
            raise RuntimeError("receiver startup timed out")

        def stop():
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        try:
            start()
            batches = []
            for vendor in ("deepsea", "fronius", "selectronic", "sigenergy"):
                output = work / (vendor + ".jsonl")
                run(str(work / "gousher"), "-replay", str(ROOT / "internal/gousher/testdata" / (vendor + ".jsonl")),
                    "-replay-batches", str(output))
                lines = output.read_bytes().splitlines()
                check(bool(lines), vendor + " produced no batches")
                for raw in lines:
                    check(request("/capture", raw, False)[0] == 401, "unauthenticated capture accepted")
                    check(request("/capture", raw)[0] == 200, "capture rejected")
                    batch = json.loads(raw)
                    at = dt.datetime.fromisoformat(batch["measurementTime"].replace("Z", "+00:00"))
                    query = urllib.parse.urlencode({"pollerId": batch["pollerId"], "revision": batch["revision"],
                        "start": at.isoformat(), "end": (at + dt.timedelta(seconds=1)).isoformat()})
                    status, body = request("/export?" + query)
                    check(status == 200 and any(b["id"] == batch["id"] for b in json.loads(body)["batches"]),
                          "accepted batch missing from export")
                    batches.append((raw, batch))
            stop()
            for capture in (work / "receiver").glob("*.json"):
                capture.unlink()
            start()
            for raw, batch in batches:
                check(request("/capture", raw)[0] == 200, "receipt lost across capture removal/restart")
                batch["vendorSiteId"] += "-conflict"
                check(request("/capture", json.dumps(batch).encode())[0] == 409, "conflicting retry accepted")
            check(not list((work / "receiver").glob("*.json")), "duplicate retry recaptured")
            print(f"PASS: four-vendor replay, {len(batches)} batches, auth/export, restart, durable retries and conflicts")
        finally:
            stop()


if __name__ == "__main__":
    main()
