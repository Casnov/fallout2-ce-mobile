"""A slow browser frame must still return control for paint and input."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class FrameYieldTest(unittest.TestCase):
    def test_fast_and_slow_frames(self):
        compiler = shutil.which('c++')
        if not compiler:
            self.skipTest('A C++ compiler is required')
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'SDL.h').write_text('''#pragma once
#include <cstdint>
using Uint64 = uint64_t;
unsigned int SDL_GetTicks();
void SDL_Delay(unsigned int);
''')
            (directory / 'emscripten.h').write_text('void emscripten_sleep(unsigned int);\n')
            (directory / 'check.cc').write_text('''#include "fps_limiter.h"
#include <initializer_list>
static unsigned int ticks;
static int delays, yields;
static unsigned int slept;
unsigned int SDL_GetTicks() { return ticks; }
void SDL_Delay(unsigned int ms) { ++delays; slept = ms; }
void emscripten_sleep(unsigned int ms) { ++yields; slept = ms; }
namespace fallout { void perfMonitorSleep(unsigned int) {} }
int main() {
    fallout::FpsLimiter limiter(60);
    for (unsigned int duration : {5u, 16u, 25u, 100u}) {
        ticks = 0; delays = yields = 0; slept = 999;
        limiter.mark();
        ticks = duration;
        limiter.throttle();
        if (duration < 16) {
            if (delays != 1 || yields != 0 || slept != 16 - duration) return 1;
        } else {
#ifdef __EMSCRIPTEN__
            if (delays != 0 || yields != 1 || slept != 0) return 2;
#else
            if (delays != 0 || yields != 0) return 3;
#endif
        }
    }
    return 0;
}
''')
            for web in (False, True):
                with self.subTest(web=web):
                    executable = directory / ('web-check' if web else 'native-check')
                    command = [compiler, '-std=c++17', '-I' + str(directory), '-I' + str(ROOT / 'src')]
                    if web:
                        command.append('-D__EMSCRIPTEN__')
                    command += [str(ROOT / 'src/fps_limiter.cc'), str(directory / 'check.cc'), '-o', str(executable)]
                    subprocess.run(command, check=True, capture_output=True, text=True)
                    subprocess.run([str(executable)], check=True)


if __name__ == '__main__':
    unittest.main()
