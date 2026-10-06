"""Run one API worker and the public Next.js server, with coordinated shutdown."""
import os
from pathlib import Path
import signal
import subprocess
import time

root = Path(__file__).resolve().parents[1]
processes = []


def shutdown(signum=None, frame=None):
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

try:
    api = subprocess.Popen(
        ['python', '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--workers', '1'],
        cwd=root / 'server', start_new_session=True,
    )
    processes.append(api)
    environment = {**os.environ, 'HOSTNAME': '0.0.0.0', 'PORT': os.getenv('PORT', '10000')}
    web = subprocess.Popen(['node', 'server.js'], cwd=root / 'client', env=environment, start_new_session=True)
    processes.append(web)
    while all(process.poll() is None for process in processes):
        time.sleep(0.25)
    code = next(process.returncode for process in processes if process.returncode is not None)
finally:
    shutdown()
    for process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

raise SystemExit(code)
