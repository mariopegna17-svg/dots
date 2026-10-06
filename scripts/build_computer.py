"""Build through the environment's existing proxy, without exposing its values."""
import os
from pathlib import Path
import socket
import hashlib
import subprocess
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[1]
os.environ.setdefault('DOCKER_CONFIG', str(root / '.cache' / 'docker'))
arguments = ['docker', 'build', '--network=host']
for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'):
    if os.environ.get(name):
        arguments.extend(['--build-arg', name])
hosts = {urlsplit(os.environ[name]).hostname for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy') if os.environ.get(name)}
for host in sorted(hosts):
    if host:
        arguments.extend(['--add-host', f'{host}:{socket.gethostbyname(host)}'])
certificate = os.environ.get('SSL_CERT_FILE')
if certificate and Path(certificate).is_file():
    arguments.extend(['--secret', f'id=proxy_ca,src={certificate}'])
    arguments.extend(['--build-arg', 'PROXY_CA_SHA256=' + hashlib.sha256(Path(certificate).read_bytes()).hexdigest()])
arguments.extend(['-t', 'open-dots-computer:1.62.1', './runtime'])
# Deliberately avoid check=True's exception: it would echo all proxy arguments.
raise SystemExit(subprocess.run(arguments, cwd=root).returncode)
