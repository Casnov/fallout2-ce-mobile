"""Check the production web audio branch against SDL's reference conversion."""
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


class WebAudioMixerTest(unittest.TestCase):
    def test_pcm_conversion_and_playback(self):
        compiler = shutil.which('c++')
        config = shutil.which('sdl2-config')
        if not compiler or not config:
            self.skipTest('A C++ compiler and SDL2 development library are required')
        flags = shlex.split(subprocess.check_output([config, '--cflags', '--libs'], text=True))
        with tempfile.TemporaryDirectory() as temporary:
            binary = str(Path(temporary) / 'mixer-check')
            subprocess.run([compiler, '-std=c++17', '-O2',
                            str(Path(__file__).with_suffix('.cc')), '-o', binary, *flags], check=True)
            subprocess.run([binary], check=True, timeout=30)


if __name__ == '__main__':
    unittest.main()
