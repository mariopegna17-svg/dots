"""Exercise the production supervisor with real child processes and local HTTP."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


LAUNCHER = r'''
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('production', os.environ['SUPERVISOR_SOURCE'])
production = importlib.util.module_from_spec(spec)
spec.loader.exec_module(production)
production.ROOT = Path(os.environ['FIXTURE_ROOT'])
production.HEALTH_URL = os.environ['FIXTURE_HEALTH_URL']
real_popen = subprocess.Popen

def launch(command, **kwargs):
    kind = 'api' if '-m' in command else 'web'
    return real_popen([sys.executable, str(production.ROOT / 'child.py'), kind], **kwargs)

production.subprocess.Popen = launch
raise SystemExit(production.main(
    startup_timeout=float(os.environ['FIXTURE_STARTUP_TIMEOUT']),
    shutdown_timeout=0.5,
))
'''


CHILD = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import sys
import time
from urllib.request import build_opener, ProxyHandler

root = Path(os.environ['FIXTURE_ROOT'])
kind = sys.argv[1]
(root / (kind + '.pid')).write_text(str(os.getpid()))

def stop(signum, frame):
    (root / (kind + '.stopped')).touch()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, signal.SIG_IGN if os.environ.get('FIXTURE_IGNORE_TERM') else stop)

if kind == 'web':
    with build_opener(ProxyHandler({})).open(os.environ['FIXTURE_HEALTH_URL'], timeout=1) as response:
        health = json.loads(response.read())
    (root / 'web.started').write_text(json.dumps({
        'health': health, 'ready_seen': (root / 'api.ready').exists(),
        'host': os.environ['HOSTNAME'], 'port': os.environ['PORT'],
    }))
    if os.environ.get('FIXTURE_WEB_EXIT'):
        raise SystemExit(7)
    while True:
        time.sleep(0.1)

time.sleep(float(os.environ.get('FIXTURE_API_DELAY', '0')))
if os.environ.get('FIXTURE_API_EXIT'):
    raise SystemExit(7)

class Handler(BaseHTTPRequestHandler):
    attempts = 0

    def do_GET(self):
        Handler.attempts += 1
        if os.environ.get('FIXTURE_OFFLINE'):
            status, body = 200, b'{"status":"starting"}'
        elif Handler.attempts == 1:
            status, body = 503, b'{"status":"online"}'
        elif Handler.attempts == 2:
            status, body = 200, b'[]'
        elif Handler.attempts == 3:
            status, body = 200, b'not-json'
        else:
            status, body = 200, b'{"status":"online"}'
            (root / 'api.ready').touch()
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

HTTPServer(('127.0.0.1', int(os.environ['FIXTURE_API_PORT'])), Handler).serve_forever()
'''


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'server').mkdir()
        (self.root / 'client').mkdir()
        (self.root / 'launcher.py').write_text(LAUNCHER)
        (self.root / 'child.py').write_text(CHILD)
        self.source = Path(__file__).resolve().parents[2] / 'scripts/production.py'
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            self.port = listener.getsockname()[1]
        self.log = (self.root / 'launcher.log').open('w+')
        self.launcher = None

    def tearDown(self):
        if self.launcher and self.launcher.poll() is None:
            self.launcher.terminate()
            try:
                self.launcher.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.launcher.kill()
                self.launcher.wait()
        for kind in ('api', 'web'):
            path = self.root / (kind + '.pid')
            if path.exists():
                try:
                    os.killpg(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.log.close()
        self.temp.cleanup()

    def start(self, timeout=5, **options):
        environment = {
            **os.environ, 'SUPERVISOR_SOURCE': str(self.source), 'FIXTURE_ROOT': str(self.root),
            'FIXTURE_HEALTH_URL': f'http://127.0.0.1:{self.port}/api/v1/health',
            'FIXTURE_API_PORT': str(self.port), 'FIXTURE_STARTUP_TIMEOUT': str(timeout),
            'PORT': '10000', **{f'FIXTURE_{key}': str(value) for key, value in options.items()},
        }
        self.launcher = subprocess.Popen(
            [sys.executable, str(self.root / 'launcher.py')], env=environment,
            stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
        )

    def wait_for(self, name):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if (self.root / name).exists():
                return
            if self.launcher.poll() is not None:
                break
            time.sleep(0.02)
        self.log.seek(0)
        self.fail(f'{name} was not created. {self.log.read()}')

    def assert_children_stopped(self):
        for kind in ('api', 'web'):
            path = self.root / (kind + '.pid')
            if path.exists():
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(path.read_text()), 0)

    def test_web_waits_for_delayed_api_and_valid_online_health(self):
        self.start(API_DELAY=0.4)
        self.wait_for('api.pid')
        self.assertFalse((self.root / 'web.pid').exists())
        self.wait_for('web.started')
        result = json.loads((self.root / 'web.started').read_text())
        self.assertEqual(result['health']['status'], 'online')
        self.assertTrue(result['ready_seen'])
        self.assertEqual((result['host'], result['port']), ('0.0.0.0', '10000'))
        self.launcher.terminate()
        self.assertEqual(self.launcher.wait(timeout=3), 0)
        self.assert_children_stopped()

    def test_api_crash_keeps_web_closed_and_preserves_failure_code(self):
        self.start(API_EXIT=1)
        self.assertEqual(self.launcher.wait(timeout=3), 7)
        self.assertFalse((self.root / 'web.pid').exists())
        self.assert_children_stopped()

    def test_non_ready_api_times_out_and_is_stopped(self):
        self.start(timeout=0.8, OFFLINE=1)
        self.assertEqual(self.launcher.wait(timeout=3), 1)
        self.assertFalse((self.root / 'web.pid').exists())
        self.assertTrue((self.root / 'api.stopped').exists())
        self.assert_children_stopped()

    def test_stop_during_startup_never_launches_web(self):
        self.start(API_DELAY=30)
        self.wait_for('api.pid')
        self.launcher.terminate()
        self.assertEqual(self.launcher.wait(timeout=3), 0)
        self.assertFalse((self.root / 'web.pid').exists())
        self.assert_children_stopped()

    def test_web_crash_stops_api_and_preserves_failure_code(self):
        self.start(WEB_EXIT=1)
        self.assertEqual(self.launcher.wait(timeout=4), 7)
        self.assertTrue((self.root / 'api.stopped').exists())
        self.assert_children_stopped()

    def test_shutdown_kills_a_child_that_ignores_sigterm(self):
        self.start(timeout=0.8, OFFLINE=1, IGNORE_TERM=1)
        self.assertEqual(self.launcher.wait(timeout=3), 1)
        self.assert_children_stopped()
