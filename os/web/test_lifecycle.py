"""Exercise the web window bridge and Asyncify exit with a live runtime."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class RuntimeExitTest(unittest.TestCase):
    def test_async_main_exit_with_pending_keepalive(self):
        sdk = Path(os.environ.get('EMSDK', ROOT / 'out/web/emsdk'))
        emcc = sdk / 'upstream/emscripten/emcc.py'
        node = shutil.which('node')
        if not emcc.is_file() or not node or sys.version_info < (3, 10):
            self.skipTest('Emscripten SDK, Node and Python 3.10+ required; run again after the web build')
        env = os.environ.copy()
        env['EM_CONFIG'] = str(sdk / '.emscripten')
        env['EMSDK_PYTHON'] = sys.executable
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'exit.cc').write_text('''#include <cstdlib>
#include <emscripten.h>
#include <emscripten/eventloop.h>
#include "platform/web/window.h"
EM_JS(void, mark, (int phase), {
    Module['events'].push(phase);
    if (phase === 2) Module['done']();
});
int main() {
#ifdef FORCE_EXIT
    // The actual JS window bridge retained a blur/focus cycle between polls.
    if (fallout::webPollWindowState() != (fallout::kWebWindowActive
            | fallout::kWebCancelTouches | fallout::kWebWindowInterrupted)) std::abort();
    if (fallout::webPollWindowState() != fallout::kWebWindowActive) std::abort();
#else
    // Small engine fixtures may omit browser-window integration.
    if (fallout::webPollWindowState() != fallout::kWebWindowActive) std::abort();
#endif
    std::atexit([] { mark(3); });
    // Model a pending browser callback: an implicit main return may not exit.
    emscripten_runtime_keepalive_push();
    mark(1);
    emscripten_sleep(1);
    mark(2);
#ifdef FORCE_EXIT
    fallout::webExit(0);
#endif
    return 0;
}
''')
            (directory / 'check.cjs').write_text('''const assert = require('node:assert/strict');
(async () => {
  const create = require(process.argv[2]);
  const force = process.argv[3] === 'force';
  const events = [];
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  let exited;
  const exitDone = new Promise(resolve => { exited = resolve; });
  const engine = await create({noInitialRun:true, events, done,
    onExit(status) { assert.equal(status, 0); events.push(4); exited(); }});
  if (force) {
    const {createGameWindow} = await import(process.argv[4]);
    const environment = new EventTarget();
    environment.document = new EventTarget();
    environment.document.hidden = false;
    const surface = new EventTarget();
    surface.getBoundingClientRect = () => ({left:0,top:0,width:900,height:400});
    engine.webWindow = createGameWindow(surface,{environment});
    environment.dispatchEvent(new Event('blur'));
    environment.dispatchEvent(new Event('focus'));
  }
  engine.callMain([]);
  assert.deepEqual(events, [1], 'Asyncify yield must not look like game completion');
  let timer;
  try {
    await Promise.race([completed.then(() => force ? exitDone : undefined), new Promise((_,reject) => {
      timer = setTimeout(() => reject(Error('Asyncify did not resume')), 3000);
    })]);
  } finally { clearTimeout(timer); }
  assert.deepEqual(events, force ? [1,2,3,4] : [1,2]);
  console.log(force ? 'webExit: cleanup and onExit completed' : 'Implicit return: runtime stays alive, onExit missing');
})().catch(error => { console.error(error); process.exitCode = 1; });
''')
            for force in (False, True):
                with self.subTest(force=force):
                    output = directory / ('forced.cjs' if force else 'implicit.cjs')
                    command = [sys.executable, str(emcc), '-std=c++17', '-O2',
                               str(directory / 'exit.cc'), str(ROOT / 'src/platform/web/window.cc'),
                               '-I' + str(ROOT / 'src'), '--use-port=sdl2', '-sASYNCIFY',
                               '-sEXIT_RUNTIME', '-sMODULARIZE', '-sENVIRONMENT=node',
                               '-sEXPORTED_RUNTIME_METHODS=callMain', '-o', str(output)]
                    if force:
                        command.append('-DFORCE_EXIT')
                    compiled = subprocess.run(command, env=env, capture_output=True, text=True)
                    self.assertEqual(compiled.returncode, 0, compiled.stderr)
                    checked = subprocess.run([node, str(directory / 'check.cjs'), str(output),
                                              'force' if force else 'implicit',
                                              (ROOT / 'os/web/browser.js').as_uri()],
                                             capture_output=True, text=True, timeout=15)
                    self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
                    print(checked.stdout.strip())


if __name__ == '__main__':
    unittest.main()
