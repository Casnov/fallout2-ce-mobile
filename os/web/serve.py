#!/usr/bin/env python3
"""Local development server; optional game files are read-only and never bundled."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import mimetypes
from pathlib import Path, PurePosixPath
import re
import secrets
import socket
import subprocess
import sys
from urllib.parse import unquote, urlsplit

LAN_NETWORKS = tuple(ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def listen_address(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise ValueError('Use a literal loopback or private LAN IPv4 address') from error
    if not address.is_loopback and not any(address in network for network in LAN_NETWORKS):
        raise ValueError('Only loopback and private LAN addresses are supported; not 0.0.0.0 or public IPs')
    return str(address)


def lan_address():
    # Prefer Wi-Fi on a Mac even when a VPN owns the default route.
    if sys.platform == 'darwin':
        ports = subprocess.check_output(['/usr/sbin/networksetup', '-listallhardwareports'], text=True)
        wifi = re.search(r'Hardware Port: (?:Wi-Fi|AirPort)\nDevice: (\S+)', ports)
        if wifi:
            result = subprocess.run(['/usr/sbin/ipconfig', 'getifaddr', wifi[1]], capture_output=True, text=True)
            if result.returncode == 0:
                return listen_address(result.stdout.strip())
        raise ValueError('No private Wi-Fi IPv4 address found. Connect to Wi-Fi or use --listen ADDRESS.')
    # UDP connect selects a route without sending a packet to this documentation address.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.connect(('192.0.2.1', 9))
        return listen_address(probe.getsockname()[0])


def game_files(root):
    root = root.resolve()
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        parts = relative.parts
        lower = relative.as_posix().lower()
        if any(p.startswith('.') or p.lower().endswith('.app') for p in parts):
            continue
        if lower == 'ce.dat' or lower.startswith('ce.dat/') or 'savegame' in lower.split('/'):
            continue
        if path.is_symlink() or not path.is_file() or path.resolve().is_relative_to(root) is False:
            continue
        if path.suffix.lower() in ('.exe', '.dll', '.log', '.old'):
            continue
        if lower in files:
            raise ValueError('Case-colliding game paths: ' + str(relative))
        files[lower] = (relative.as_posix(), path, path.stat().st_size)
    if 'master.dat' not in files or 'critter.dat' not in files:
        raise ValueError('--game must contain master.dat and critter.dat')
    return files


def byte_range(header, size):
    if not header:
        return 0, size
    match = re.fullmatch(r'bytes=(\d+)-(\d*)', header)
    if not match:
        raise ValueError('Only one explicit byte range is supported')
    start = int(match[1])
    end = min(int(match[2]) + 1, size) if match[2] else size
    if start >= size or end <= start:
        raise ValueError('Unsatisfiable range')
    return start, end


def handler_for(dist, game=None, base='/', verbose=False):
    dist = dist.resolve()
    game = game.resolve() if game else None
    resources = game_files(game) if game else {}

    class Handler(BaseHTTPRequestHandler):
        def log_request(self, code='-', size='-'):
            if verbose or (str(code).isdigit() and int(code) >= 400):
                super().log_request(code, size)

        def end_headers(self):
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            super().end_headers()

        def do_HEAD(self):
            self.respond(head=True)

        def do_GET(self):
            self.respond(head=False)

        def respond(self, head):
            host, port = self.server.server_address[:2]
            allowed_hosts = {host + ':' + str(port)}
            if ipaddress.ip_address(host).is_loopback:
                allowed_hosts.add('localhost:' + str(port))
            if port == 80:
                allowed_hosts.add(host)
            if self.headers.get('Host', '').lower() not in allowed_hosts:
                self.send_error(404); return
            request_path = urlsplit(self.path).path
            if not request_path.startswith(base):
                self.send_error(404); return
            relative = unquote(request_path[len(base):])
            parts = PurePosixPath(relative).parts
            if relative.startswith('/') or '\\' in relative or any(p in ('.', '..') or p.startswith('.') for p in parts):
                self.send_error(404); return
            if relative == '__dev__/game.json':
                if not resources:
                    self.send_error(404); return
                data = json.dumps({'schema': 1, 'readOnly': True,
                                   'files': [{'path': name, 'size': size} for name, _, size in resources.values()]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                if not head:
                    self.wfile.write(data)
                return
            if relative.startswith('__dev__/game/'):
                item = resources.get(relative[len('__dev__/game/'):].lower())
                if not item:
                    self.send_error(404); return
                path = item[1]
                if path.is_symlink() or not path.resolve().is_relative_to(game):
                    self.send_error(404); return
            else:
                path = dist / (relative or 'index.html')
                if not path.resolve().is_relative_to(dist) or not path.is_file():
                    self.send_error(404); return
            size = path.stat().st_size
            try:
                start, end = byte_range(self.headers.get('Range'), size)
            except ValueError:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */' + str(size))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            ranged = self.headers.get('Range') is not None
            self.send_response(206 if ranged else 200)
            mime = {'.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json'}.get(path.suffix)
            mime = mime or mimetypes.guess_type(path.name)[0]
            self.send_header('Content-Type', mime or 'application/octet-stream')
            self.send_header('Content-Length', str(end - start))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-store')
            if ranged:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end - 1, size))
            self.end_headers()
            if not head:
                try:
                    with path.open('rb') as stream:
                        stream.seek(start)
                        left = end - start
                        while left:
                            data = stream.read(min(left, 256 * 1024))
                            if not data:
                                break
                            self.wfile.write(data)
                            left -= len(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=Path(__file__).resolve().parents[2] / 'out/web/dist')
    parser.add_argument('--game', type=Path, help='Own local game folder; never copied or modified')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--base-path', default='/')
    bind = parser.add_mutually_exclusive_group()
    bind.add_argument('--lan', action='store_true', help='Use the Mac Wi-Fi address and a new random URL path')
    bind.add_argument('--listen', help='Bind to a specific loopback or private LAN IPv4 address')
    parser.add_argument('--verbose', action='store_true', help='Log successful resource reads too')
    args = parser.parse_args()
    dist = args.dist.resolve()
    if not (dist / 'build-info.json').is_file():
        parser.error('Build the web bundle first; --dist must contain build-info.json')
    base = '/' + args.base_path.strip('/') + '/' if args.base_path.strip('/') else '/'
    if not re.fullmatch(r'/[A-Za-z0-9_/-]*', base) or '..' in base:
        parser.error('Invalid --base-path')
    try:
        host = lan_address() if args.lan else listen_address(args.listen or '127.0.0.1')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    remote = not ipaddress.ip_address(host).is_loopback
    if remote:
        base += 'test-' + secrets.token_urlsafe(18) + '/'
    server = ThreadingHTTPServer((host, args.port), handler_for(dist, args.game, base, args.verbose))
    query = ('?dev=1' + ('' if remote else '&mouse=1')) if args.game else ''
    print('http://%s:%d%s%s' % (host, server.server_port, base, query), flush=True)
    if remote:
        print('Wi-Fi test: same network, Mac awake. Keep this session URL private; a restart changes it.', flush=True)
    print('Game folder is read-only. Saves disappear on page reload. Stop with Ctrl+C.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
