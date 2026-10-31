"""HTTP range and isolation checks; fixtures contain no original game data."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from serve import handler_for, listen_address


class DevelopmentServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cls.dist = root / 'dist'
        cls.dist.mkdir()
        (cls.dist / 'index.html').write_text('STATIC APP')
        (cls.dist / 'engine.wasm').write_bytes(b'\0asmDATA')
        game = root / 'game'
        game.mkdir()
        (game / 'master.dat').write_bytes(b'0123456789')
        (game / 'critter.dat').write_bytes(b'CRITTER')
        (game / 'ce.dat').write_bytes(b'OLD APP ASSET')
        (game / 'data/SAVEGAME/SLOT01').mkdir(parents=True)
        (game / 'data/SAVEGAME/SLOT01/SAVE.DAT').write_bytes(b'PRIVATE SAVE')
        (root / 'outside.txt').write_text('OUTSIDE')
        (game / 'link.txt').symlink_to(root / 'outside.txt')
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(cls.dist, game, '/preview/'))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:%d/preview/' % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def get(self, path, headers=None, method='GET'):
        return urlopen(Request(self.base + path, headers=headers or {}, method=method), timeout=5)

    def test_range(self):
        with self.get('__dev__/game/master.dat', {'Range': 'bytes=2-5'}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers['Content-Range'], 'bytes 2-5/10')
            self.assertEqual(response.read(), b'2345')

    def test_end_clamped(self):
        with self.get('__dev__/game/master.dat', {'Range': 'bytes=8-99'}) as response:
            self.assertEqual(response.read(), b'89')

    def test_bad_ranges(self):
        for value in ['bytes=10-11', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-2']:
            with self.subTest(value=value), self.assertRaises(HTTPError) as context:
                self.get('__dev__/game/master.dat', {'Range': value})
            self.assertEqual(context.exception.code, 416)

    def test_private_files_excluded(self):
        with self.get('__dev__/game.json') as response:
            paths = {entry['path'] for entry in json.load(response)['files']}
        self.assertEqual(paths, {'master.dat', 'critter.dat'})
        for path in ['__dev__/game/ce.dat', '__dev__/game/link.txt', '__dev__/game/data/SAVEGAME/SLOT01/SAVE.DAT']:
            with self.subTest(path=path), self.assertRaises(HTTPError) as context:
                self.get(path)
            self.assertEqual(context.exception.code, 404)

    def test_path_escape_rejected(self):
        for path in ['%2e%2e/outside.txt', '__dev__/game/%2e%2e/outside.txt', '%2foutside.txt']:
            with self.subTest(path=path), self.assertRaises(HTTPError) as context:
                self.get(path)
            self.assertEqual(context.exception.code, 404)

    def test_head_and_wasm_mime(self):
        with self.get('engine.wasm', method='HEAD') as response:
            self.assertEqual(response.headers['Content-Type'], 'application/wasm')
            self.assertEqual(int(response.headers['Content-Length']), 8)
            self.assertEqual(response.read(), b'')

    def test_static_subpath(self):
        with self.get('') as response:
            self.assertEqual(response.read(), b'STATIC APP')

    def test_wrong_host_rejected(self):
        with self.assertRaises(HTTPError) as context:
            self.get('__dev__/game.json', {'Host': 'unrelated.example'})
        self.assertEqual(context.exception.code, 404)

    def test_missing_session_path_rejected(self):
        with self.assertRaises(HTTPError) as context:
            urlopen(self.base.replace('/preview/', '/wrong-session/') + '__dev__/game.json', timeout=5)
        self.assertEqual(context.exception.code, 404)

    def test_write_not_supported(self):
        with self.assertRaises(HTTPError) as context:
            self.get('__dev__/game/master.dat', method='POST')
        self.assertEqual(context.exception.code, 501)
        with self.get('__dev__/game/master.dat') as response:
            self.assertEqual(response.read(), b'0123456789')

    def test_no_referrer_and_no_sniff(self):
        with self.get('') as response:
            self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
            self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')

    def test_listen_scope(self):
        for address in ['127.0.0.1', '192.168.3.6', '10.0.0.2', '172.16.0.2', '172.31.255.254']:
            self.assertEqual(listen_address(address), address)
        for address in ['0.0.0.0', '8.8.8.8', '172.15.0.1', '172.32.0.1', '::', 'localhost']:
            with self.subTest(address=address), self.assertRaises(ValueError):
                listen_address(address)


if __name__ == '__main__':
    unittest.main()
