#!/usr/bin/env python3
"""Start a temporary HTTPS device check exposing only the verified static bundle."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from urllib.request import urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / 'out/web/iphone-test/https-session.json'


def alive(pid, *markers):
    check = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
    return check.returncode == 0 and all(marker in check.stdout for marker in markers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18767)
    parser.add_argument('--stop', action='store_true', help='Stop only the recorded static server and tunnel')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('Use an unprivileged fixed port from 1024 to 65535')
    if STATE.exists():
        previous = json.loads(STATE.read_text())
        markers = [('server_pid', str(ROOT / 'os/web/serve.py'), '--port ' + str(previous['port'])),
                   ('tunnel_pid', 'cloudflared', 'http://127.0.0.1:' + str(previous['port']))]
        if args.stop:
            for key, *identity in markers:
                if alive(previous[key], *identity): os.kill(previous[key], 15)
            print('HTTPS test stopped; game files and browser data were not changed.')
            return
        if all(alive(previous[key], *identity) for key, *identity in markers):
            if not previous.get('url'): parser.error('Existing tunnel is starting; inspect its log instead of starting another')
            print(previous['url']); return
        for key, *identity in markers:
            if alive(previous[key], *identity): os.kill(previous[key], 15)
    elif args.stop:
        print('No recorded HTTPS test.'); return
    cloudflared = shutil.which('cloudflared')
    if not cloudflared:
        parser.error('Install the official cloudflared CLI first')
    subprocess.run([sys.executable, str(ROOT / 'os/web/package.py'), '--verify', str(ROOT / 'out/web/dist')], check=True)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    server_log = STATE.parent / 'https-static-server.log'
    tunnel_log = STATE.parent / 'https-tunnel.log'
    with server_log.open('ab') as log:
        server = subprocess.Popen([sys.executable, '-u', str(ROOT / 'os/web/serve.py'),
            '--dist', str(ROOT / 'out/web/dist'), '--port', str(args.port)], cwd=ROOT,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    origin = 'http://127.0.0.1:' + str(args.port)
    try:
        for _ in range(30):
            if server.poll() is not None: raise RuntimeError('Static server failed; see ' + str(server_log))
            try:
                with urlopen(origin + '/manifest.webmanifest', timeout=1) as response: response.read()
                break
            except OSError: time.sleep(0.1)
        else: raise RuntimeError('Static server did not start')
        time.sleep(0.1)
        if server.poll() is not None: raise RuntimeError('Port already in use; no tunnel started')
        # Never tunnel a previously running game-enabled server on a conflicting port.
        try:
            urlopen(origin + '/__dev__/game.json', timeout=2).close()
        except HTTPError as error:
            if error.code != 404: raise
        else: raise RuntimeError('Refusing to expose a game resource endpoint')
        with tunnel_log.open('w') as log:
            tunnel = subprocess.Popen([cloudflared, 'tunnel', '--no-autoupdate', '--url', origin,
                '--http-host-header', '127.0.0.1:' + str(args.port), '--protocol', 'http2'], cwd=ROOT,
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        # Persist both PIDs before waiting, so a failed connection remains manageable.
        state = {'server_pid':server.pid, 'tunnel_pid':tunnel.pid, 'port':args.port,
                 'server_log':str(server_log),'tunnel_log':str(tunnel_log), 'url':None}
        STATE.write_text(json.dumps(state,indent=2) + '\n')
        for _ in range(100):
            if tunnel.poll() is not None: raise RuntimeError('Tunnel failed; see ' + str(tunnel_log))
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', tunnel_log.read_text())
            if match:
                state['origin'] = match[0]
                state['url'] = match[0] + '/index.html'
                state['build'] = json.loads((ROOT / 'out/web/dist/build-info.json').read_text())['buildId']
                STATE.write_text(json.dumps(state,indent=2) + '\n')
                print(state['url']); return
            time.sleep(0.2)
        raise RuntimeError('No HTTPS URL yet; see ' + str(tunnel_log))
    except Exception:
        # Keep logs; do not leave an untracked server after a failed start.
        server.terminate()
        if 'tunnel' in locals(): tunnel.terminate()
        raise


if __name__ == '__main__': main()
