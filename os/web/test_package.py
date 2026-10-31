"""The packaged service worker lists exactly the bundle's other files."""
import json
from pathlib import Path
import tempfile
import unittest

import package


def stage_bundle(root):
    names = ['fallout2-ce.js', 'fallout2-ce.wasm', 'fallout2-archive.js', 'fallout2-archive.wasm',
             'ce.dat', 'LICENSE.md', 'licenses/libarchive.txt', *package.SITE_FILES, *package.NATIVE_FILES,
             *['fonts/' + font for font in package.FONT_FILES]]
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'\0asm' if name.endswith('.wasm') else name.encode())


def embedded(root):
    worker = (root / package.SERVICE_WORKER).read_text()
    return json.loads(worker.split('const BUILD = ', 1)[1].split(';\n', 1)[0])


class PackageTest(unittest.TestCase):
    def test_worker_lists_every_other_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage_bundle(root)
            info = package.seal(root, 'test', 'Release')
            build = embedded(root)
            self.assertEqual(build['buildId'], info['buildId'])
            self.assertEqual(build['files'], {name: value for name, value in info['files'].items() if name != 'sw.js'})
            self.assertIn('sw.js', info['files'])
            self.assertNotIn('__FALLOUT_BUILD__', (root / 'sw.js').read_text())

    def test_any_changed_file_is_a_new_build(self):
        ids = []
        for css in ['a', 'a', 'b']:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                stage_bundle(root)
                (root / 'app.css').write_text(css)
                ids.append(package.seal(root, 'test', 'Release')['buildId'])
        self.assertEqual(ids[0], ids[1])
        self.assertNotEqual(ids[0], ids[2])

    def test_worker_for_another_build_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage_bundle(root)
            info = package.seal(root, 'test', 'Release')
            build = embedded(root)
            build['files']['app.css']['sha256'] = '0' * 64
            worker = package.service_worker((package.ROOT / 'os/web/sw.js').read_text(), build['buildId'], build['files']).encode()
            (root / 'sw.js').write_bytes(worker)
            # Hashes in build-info.json match the replaced worker; only its list is wrong.
            info['files']['sw.js'] = {'bytes': len(worker), 'sha256': package.hashlib.sha256(worker).hexdigest()}
            (root / 'build-info.json').write_text(json.dumps(info))
            with self.assertRaisesRegex(ValueError, 'service worker'):
                package.verify(root)


if __name__ == '__main__':
    unittest.main()
