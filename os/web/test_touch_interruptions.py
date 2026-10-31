"""Canceled browser contacts must never activate a queued native map/UI tap."""
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest


class TouchInterruptionsTest(unittest.TestCase):
    def test_native_gesture_and_widget_queues(self):
        compiler, config = shutil.which('c++'), shutil.which('sdl2-config')
        if not compiler or not config:
            self.skipTest('A C++ compiler and SDL2 development library are required')
        flags = shlex.split(subprocess.check_output([config, '--cflags', '--libs'], text=True))
        # Only the input paths are linked; drawing/audio/game logic is unused.
        strip = '-Wl,-dead_strip' if sys.platform == 'darwin' else '-Wl,--gc-sections'
        with tempfile.TemporaryDirectory() as temporary:
            binary = str(Path(temporary) / 'touch-check')
            compiled = subprocess.run([compiler, '-std=c++17', '-O2',
                '-DFALLOUT_FORCE_TOUCH_ONLY', '-ffunction-sections', '-fdata-sections',
                str(Path(__file__).with_suffix('.cc')), strip, '-o', binary, *flags],
                capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            subprocess.run([binary], check=True, timeout=15)


if __name__ == '__main__':
    unittest.main()
