"""Real Emscripten filesystem integration; synthetic data, no game UI simulation."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class StorageRuntimeTest(unittest.TestCase):
    def test_real_wasm_storage_and_workspace(self):
        sdk = Path(os.environ.get('EMSDK', ROOT / 'out/web/emsdk'))
        emcc = sdk / 'upstream/emscripten/emcc.py'
        node = shutil.which('node')
        if not emcc.is_file() or not node or sys.version_info < (3, 10):
            self.skipTest('Emscripten SDK, Node and Python 3.10+ required; run after the web build')
        env = os.environ.copy()
        env.update(EM_CONFIG=str(sdk / '.emscripten'), EMSDK_PYTHON=sys.executable)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'storage.cjs'
            command = [sys.executable, str(emcc), '-std=c++17', '-O2',
                       str(ROOT / 'os/web/test_storage_runtime.cc'), '-sASYNCIFY', '-sEXIT_RUNTIME',
                       '-sMODULARIZE', '-sENVIRONMENT=node', '-sCASE_INSENSITIVE_FS',
                       '-sEXPORTED_RUNTIME_METHODS=FS,callMain',
                       '--js-library=' + str(ROOT / 'os/web/gamefs.js'),
                       '--js-library=' + str(ROOT / 'os/web/userfs.js'), '-o', str(output)]
            built = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            checked = subprocess.run([node, str(ROOT / 'os/web/fixtures/storage-runtime.mjs'), str(output)],
                                     capture_output=True, text=True, timeout=20)
            self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
            print(checked.stdout.strip())


if __name__ == '__main__':
    unittest.main()
