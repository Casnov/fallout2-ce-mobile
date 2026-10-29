import assert from 'node:assert/strict';
import {test} from 'node:test';
import {developmentFiles, isDevelopmentHost} from './filesystem.js';
import {gameConfigPath,configsToMerge} from './working-files.js';

test('development adapter accepts only loopback and private IPv4 hosts', () => {
  for (const host of ['localhost', '[::1]', '127.0.0.1', '127.0.0.2', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.3.6']) {
    assert.equal(isDevelopmentHost(host), true, host);
  }
  for (const host of ['example.com', '192.168.3.6.example.com', '8.8.8.8', '0.0.0.0', '172.15.0.1', '172.32.0.1', '10.1.2.999', '10.1.2', '10.1.2.-1']) {
    assert.equal(isDevelopmentHost(host), false, host);
  }
});

test('network adapter remains opt-in and keeps all reads under the session path', async () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({url:String(url), options});
      if (String(url).endsWith('game.json')) {
        return {ok:true, status:200, json:async () => ({schema:1, readOnly:true,
          files:[{path:'master.dat', size:10}, {path:'critter.dat', size:7}]})};
      }
      return {status:206, arrayBuffer:async () => new Uint8Array([2, 3, 4]).buffer};
    };
    for (const url of ['http://192.168.3.6/session/', 'https://example.com/session/?dev=1']) {
      globalThis.window = {location:{href:url}};
      assert.equal(await developmentFiles(), null);
    }
    assert.equal(calls.length, 0);
    globalThis.window = {location:{href:'http://192.168.3.6:8090/session/?dev=1'}};
    const source = await developmentFiles();
    assert.equal(source.mouseAsTouch, false);
    assert.deepEqual(await source.read(source.entries[0], 2, 3), new Uint8Array([2, 3, 4]));
    assert.equal(calls[0].url, 'http://192.168.3.6:8090/session/__dev__/game.json');
    assert.equal(calls[1].url, 'http://192.168.3.6:8090/session/__dev__/game/master.dat');
    assert.equal(calls[1].options.headers.Range, 'bytes=2-4');
  } finally {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('the game\'s config is the one ddraw.ini names, in the case the game has it', () => {
  const fake = files => ({
    analyzePath:() => ({exists:true}),
    readdir:() => Object.keys(files),
    readFile:path => new TextEncoder().encode(files[path.split('/').at(-1)]),
  });
  assert.equal(gameConfigPath(fake({'master.dat':'', 'fallout2.cfg':''}), '/game'), 'fallout2.cfg');
  assert.equal(gameConfigPath(fake({'DDRAW.INI':'[Misc]\r\nConfigFile=fores.cfg\r\n', 'Fores.cfg':''}), '/game'), 'Fores.cfg');
  assert.equal(gameConfigPath(fake({'ddraw.ini':'[Misc]\nConfigFile=..\\other.cfg\n'}), '/game'), 'fallout2.cfg');
});

test('the player\'s settings come from the saved game\'s own config, whatever its name', () => {
  const files = entries => new Map(Object.entries(entries).map(([path,text]) => [path,new TextEncoder().encode(text)]));
  // Resurrection (fores.cfg) before Fallout 2 (fallout2.cfg), and back.
  const resurrection = files({'ddraw.ini':'[Misc]\nConfigFile=fores.cfg\n', 'fores.cfg':''});
  const fallout2 = files({'fallout2.cfg':''});
  assert.deepEqual(configsToMerge(fallout2,resurrection),{config:'fallout2.cfg',old:'fores.cfg'});
  assert.deepEqual(configsToMerge(resurrection,fallout2),{config:'fores.cfg',old:'fallout2.cfg'});
  assert.deepEqual(configsToMerge(fallout2,files({'FALLOUT2.CFG':''})),{config:'fallout2.cfg',old:'FALLOUT2.CFG'});
});
