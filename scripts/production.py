"""Run one API worker and the public Next.js server, with coordinated shutdown."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
HEALTH_URL = 'http://127.0.0.1:8000/api/v1/health'


def api_is_ready(opener, timeout):
    try:
        with opener.open(HEALTH_URL, timeout=timeout) as response:
            return response.status == 200 and json.loads(response.read(4096)).get('status') == 'online'
    except (URLError, OSError, ValueError, AttributeError):
        return False


def signal_process(process, signum):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass


def failure_code(process):
    return process.returncode if process.returncode and process.returncode > 0 else 1


def main(startup_timeout=180, shutdown_timeout=30):
    processes = []
    stopped = False

    def shutdown(signum=None, frame=None):
        nonlocal stopped
        stopped = True
        for process in processes:
            signal_process(process, signal.SIGTERM)

    previous_handlers = {signum: signal.signal(signum, shutdown) for signum in (signal.SIGTERM, signal.SIGINT)}
    try:
        api = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1'],
            cwd=ROOT / 'server', start_new_session=True,
        )
        processes.append(api)
        # Restoring encrypted data happens before Uvicorn can accept requests.
        # Keep the public server closed until the API is actually usable.
        opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + startup_timeout
        print('[dots] Waiting for API readiness before starting the web.', flush=True)
        while not stopped:
            if api.poll() is not None:
                print('[dots] API exited before becoming ready; the web was not started.', flush=True)
                return failure_code(api)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                print('[dots] API startup timed out; the web was not started. Check the API logs above.', flush=True)
                return 1
            if api_is_ready(opener, min(1, remaining)):
                break
            time.sleep(min(0.25, remaining))

        if stopped:
            return 0
        if api.poll() is not None:
            return failure_code(api)
        print('[dots] API ready. Starting the web.', flush=True)
        environment = {**os.environ, 'HOSTNAME': '0.0.0.0', 'PORT': os.getenv('PORT', '10000')}
        web = subprocess.Popen(['node', 'server.js'], cwd=ROOT / 'client', env=environment, start_new_session=True)
        processes.append(web)
        while not stopped and all(process.poll() is None for process in processes):
            time.sleep(0.25)
        if stopped:
            return 0
        return failure_code(next(process for process in processes if process.returncode is not None))
    finally:
        shutdown()
        deadline = time.monotonic() + shutdown_timeout
        for process in processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                signal_process(process, signal.SIGKILL)
                process.wait()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == '__main__':
    raise SystemExit(main())
