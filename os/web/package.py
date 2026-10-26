#!/usr/bin/env python3
"""Assemble only the engine, current ce.dat and explicitly listed app assets."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from import_ui import write_native_assets

ROOT = Path(__file__).resolve().parents[2]
SITE_FILES = ['index.html', 'app.css', 'app.js', 'filesystem.js', 'browser.js',
              'resource-store.js', 'working-files.js', 'storage-common.js', 'user-report.js',
              'zip-import.js', 'probe-worker.js', 'manifest.webmanifest',
              'game-config.js', 'files.html', 'files.css', 'files.js', 'files-view.js', 'files-page.js',
              'save-session.js', 'save-download.js',
              'user-store.js', 'user-lazy-filesystem.js', 'user-runtime.js',
              'save-format.js', 'save-streams.js', 'save-zip-reader.js', 'zip-directory.js',
              'zip-output.js', 'opfs-export.js',
              'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
              'vendor/zipjs/zip.min.js', 'vendor/zipjs/LICENSE', 'vendor/zipjs/README.md']
FONT_FILES = ['FalloutClassicDialog.ttf', 'FalloutClassicDialog-LICENSE.txt', 'PTM55FT.ttf', 'OFL.txt']
NATIVE_FILES = ['import-native.js', 'import-native.css', 'icons/import-back.svg']


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ''


def verify(directory):
    info = json.loads((directory / 'build-info.json').read_text())
    if info['schema'] != 1 or not info['version']:
        raise ValueError('Invalid build metadata')
    files = info['files']
    for name in ['fallout2-ce.js', 'fallout2-ce.wasm', 'fallout2-archive.js', 'fallout2-archive.wasm',
                 'ce.dat', 'LICENSE.md', 'licenses/libarchive.txt', *SITE_FILES, *NATIVE_FILES,
                 *['fonts/' + font for font in FONT_FILES]]:
        if name not in files:
            raise ValueError('Missing app asset: ' + name)
    if (directory / 'fallout2-ce.wasm').read_bytes()[:4] != b'\0asm':
        raise ValueError('Not a WASM module')
    if (directory / 'fallout2-archive.wasm').read_bytes()[:4] != b'\0asm':
        raise ValueError('Not an archive WASM module')
    actual = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()}
    if actual != set(files) | {'build-info.json'}:
        raise ValueError('Missing or unlisted files in app output')
    for name, expected in files.items():
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Invalid app asset path: ' + name)
        if Path(name).name.lower() in ('master.dat', 'critter.dat'):
            raise ValueError('Original game data in output')
        data = (directory / name).read_bytes()
        if len(data) != expected['bytes']:
            raise ValueError('Wrong size: ' + name)
        if hashlib.sha256(data).hexdigest() != expected['sha256']:
            raise ValueError('Wrong hash: ' + name)
    return info


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', type=Path)
    parser.add_argument('--engine', type=Path)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--dat-tool', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--app-version')
    parser.add_argument('--configuration', default='Release')
    args = parser.parse_args()
    if args.verify:
        info = verify(args.verify.resolve())
        print('Verified ' + info['version'] + ': ' + str(len(info['files'])) + ' assets')
        return
    if not all([args.engine, args.archive, args.dat_tool, args.output, args.app_version]):
        parser.error('Packaging requires --engine, --archive, --dat-tool, --output, --app-version')
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents:
        parser.error('Output must not replace the source tree or its parents')
    if output.exists() and (not output.is_dir() or (any(output.iterdir()) and not (output / 'build-info.json').is_file())):
        parser.error('Refusing to replace a nonempty directory that is not a web bundle')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.web-package-', dir=output.parent) as temporary:
        stage = Path(temporary) / 'dist'
        stage.mkdir()
        for name in SITE_FILES:
            (stage / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'os/web' / name, stage / name)
        write_native_assets(stage)
        for name in ['fallout2-ce.js', 'fallout2-ce.wasm']:
            shutil.copyfile(args.engine.parent / name, stage / name)
        for name in ['fallout2-archive.js', 'fallout2-archive.wasm']:
            shutil.copyfile(args.archive.parent / name, stage / name)
        (stage / 'licenses').mkdir()
        shutil.copyfile(ROOT / 'files/ce.dat/licenses/libarchive.txt',stage / 'licenses/libarchive.txt')
        (stage / 'fonts').mkdir()
        for name in FONT_FILES:
            shutil.copyfile(ROOT / 'files/ce.dat/fonts' / name, stage / 'fonts' / name)
        shutil.copyfile(ROOT / 'LICENSE.md', stage / 'LICENSE.md')
        subprocess.run([str(args.dat_tool.resolve()), 'create', str(ROOT / 'files/ce.dat'), str(stage / 'ce.dat')], check=True)
        files = {}
        for path in sorted(stage.rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                files[path.relative_to(stage).as_posix()] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        # Include frontend assets: a keyboard/CSS-only fix must be identifiable
        # on a tester's phone even when the WASM binary has not changed.
        build_id = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:8]
        info = {'schema': 1, 'version': args.app_version, 'buildId': build_id,
                'source': {'commit': git('rev-parse', 'HEAD'), 'dirty': bool(git('status', '--porcelain'))},
                'toolchain': {'emscripten': (ROOT / 'os/web/emscripten-version.txt').read_text().strip(),
                              'configuration': args.configuration, 'wasm': 32, 'asyncify': True},
                'files': files}
        (stage / 'build-info.json').write_text(json.dumps(info, indent=2) + '\n')
        verify(stage)
        previous = Path(temporary) / 'previous'
        if output.exists():
            output.rename(previous)
        try:
            stage.rename(output)
        except OSError:
            if previous.exists():
                previous.rename(output)
            raise
    print('Packaged ' + args.app_version + ': ' + str(sum(f['bytes'] for f in files.values())) + ' bytes')


if __name__ == '__main__':
    main()
