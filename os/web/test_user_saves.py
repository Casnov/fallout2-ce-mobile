"""Loss-sensitive checks using real SaveCatalog/SaveRecords/SaveStorage in WASM."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UserSaveTest(unittest.TestCase):
    def test_native_catalog_with_atomic_user_storage(self):
        sdk = Path(os.environ.get('EMSDK', ROOT / 'out/web/emsdk'))
        emcc = sdk / 'upstream/emscripten/emcc.py'
        node = shutil.which('node')
        if not emcc.is_file() or not node or sys.version_info < (3, 10):
            self.skipTest('Emscripten SDK, Node and Python 3.10+ required; run after web build')
        env = os.environ.copy()
        env.update(EM_CONFIG=str(sdk / '.emscripten'), EMSDK_PYTHON=sys.executable)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'saves.cjs'
            sources = ['os/web/test_user_saves.cc', 'src/save_catalog.cc', 'src/save_records.cc',
                       'src/save_storage.cc', 'src/platform/web/storage.cc', 'src/platform/web/window.cc']
            command = [sys.executable, str(emcc), '-std=c++17', '-O2', '-I' + str(ROOT / 'src'),
                       *[str(ROOT / path) for path in sources], '-sASYNCIFY', '-sEXIT_RUNTIME',
                       '-sMODULARIZE', '-sENVIRONMENT=node', '-sCASE_INSENSITIVE_FS', '--use-port=sdl2',
                       '-sEXPORTED_RUNTIME_METHODS=FS,callMain',
                       '--js-library=' + str(ROOT / 'os/web/gamefs.js'),
                       '--js-library=' + str(ROOT / 'os/web/userfs.js'), '-o', str(output)]
            built = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            checked = subprocess.run([node, str(ROOT / 'os/web/fixtures/user-saves-v3.mjs'), str(output)],
                                     capture_output=True, text=True, timeout=60)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            print(checked.stdout.strip())


if __name__ == '__main__':
    unittest.main()
