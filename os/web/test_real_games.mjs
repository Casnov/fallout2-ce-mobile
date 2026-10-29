import test from 'node:test';
import assert from 'node:assert/strict';
import {openAsBlob,readFileSync,existsSync} from 'node:fs';
import {openGameArchive,planGameArchive,readZipFile} from './zip-import.js';
import {decodeConfig} from './game-config.js';

// The web's files of real games' archives are Android's (RealGamesTest's
// plans/<name>.txt, out/dev/realgames.sh): the same paths, folders in the
// same case, the same sizes. Android also copies what the web keeps apart
// or leaves out: saves, logs, temporary maps, dot files. Skipped without
// FALLOUT_REAL_GAMES and FALLOUT_REAL_OUT.
const list = process.env.FALLOUT_REAL_GAMES, out = process.env.FALLOUT_REAL_OUT;
const androidOnly = path => /(^|\/)savegame(\/|$)/i.test(path) || /\.(log|old|tmp|bak)$/i.test(path)
  || /(^|\/)maps\/.*\.(sav|db)$/i.test(path) || path.split('/').some(part => part.startsWith('.'))
  || /^ce-(saves|game-composition|game-charset)\.txt$/i.test(path);

test('real games: the web puts in the files Android does',{skip:!list || !out},async () => {
  const failures = [];
  for (const line of readFileSync(list,'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [name,path,chosen] = line.split('\t');
    if (!path.toLowerCase().endsWith('.zip')) continue;
    const androidPlan = `${out}/plans/${name}.txt`;
    if (!existsSync(androidPlan)) { failures.push(`${name}: no Android plan`); continue; }
    const started = performance.now();
    const archive = await openGameArchive(await openAsBlob(path));
    try {
      const readText = async item => decodeConfig(await readZipFile(item,1024 ** 2));
      const {plan,choices} = await planGameArchive(archive,{choice:chosen || null,readText});
      if (!plan) { failures.push(`${name}: choose one of ${choices.join(', ')}`); continue; }
      const web = new Map(plan.files.map(file => [file.path,file.size]));
      const android = new Map(readFileSync(androidPlan,'utf8').split('\n').filter(Boolean).map(row => row.split('\t')).map(([file,size]) => [file,Number(size)]));
      const missing = [...android.keys()].filter(file => !web.has(file) && !androidOnly(file));
      const extra = [...web.keys()].filter(file => !android.has(file));
      const sizes = [...web].filter(([file,size]) => android.has(file) && android.get(file) !== size).map(([file]) => file);
      if (missing.length || extra.length || sizes.length) {
        failures.push(`${name}: not on the web ${missing.slice(0,5)}, only on the web ${extra.slice(0,5)}, other sizes ${sizes.slice(0,5)}`);
      }
      console.log(`${name}: ${web.size} files, ${Math.round(performance.now() - started)} ms`);
    } finally { await archive.dispose(); }
  }
  assert.deepEqual(failures,[]);
});
