import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {startAppCache} from './app-cache.js';

// The production sw.js runs in a VM with an in-memory Cache API and a fake
// server, the same way package.py fills in its build.
const SCOPE = 'https://example.test/app/';
const encoder = new TextEncoder();
const sha256 = text => createHash('sha256').update(text).digest('hex');
const site = {'index.html':'<!doctype html>', 'files.html':'<!doctype html>files', 'app.js':'export {};', 'fallout2-ce.wasm':'\0asm'};
const buildOf = (buildId, contents = site) => ({buildId, files:Object.fromEntries(Object.entries(contents)
  .map(([path, text]) => [path, {bytes:encoder.encode(text).length, sha256:sha256(text)}]))});

class MemoryCaches {
  stores = new Map();
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    const store = this.stores.get(name);
    return {
      async put(url, response) { store.set(String(url), response); },
      async match(url) { return store.get(String(url))?.clone(); },
      delete: async url => store.delete(String(url)),
    };
  }
  async delete(name) { return this.stores.delete(name); }
  async keys() { return [...this.stores.keys()]; }
}

function serve(build, contents = site, {info = {buildId:build.buildId, files:{...build.files, 'sw.js':{bytes:1, sha256:'0'}}}} = {}) {
  return async url => {
    const path = new URL(url).pathname.slice(new URL(SCOPE).pathname.length);
    if (path === 'build-info.json') return new Response(JSON.stringify(info), {headers:{'Content-Type':'application/json'}});
    if (!(path in contents)) return new Response('missing', {status:404});
    return new Response(contents[path], {headers:{'Content-Type':path.endsWith('.wasm') ? 'application/wasm' : 'text/html'}});
  };
}

async function worker(build, {server = serve(build), caches = new MemoryCaches(), windows = 1} = {}) {
  const template = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
  const listeners = {}, network = [];
  const state = {online:true, skipped:false};
  const self = {location:new URL('sw.js', SCOPE), addEventListener:(type, fn) => { listeners[type] = fn; },
    clients:{matchAll:async () => Array.from({length:windows})}, skipWaiting:async () => { state.skipped = true; }};
  const fetch = async request => {
    const url = String(request.url ?? request);
    network.push(url);
    if (!state.online) throw new TypeError('Network is offline');
    return server(url);
  };
  vm.runInNewContext(template.replace('__FALLOUT_BUILD__', JSON.stringify(build)), {self, caches, fetch, crypto, Response, URL});
  const extendable = (type, fields = {}) => {
    const event = {...fields, promise:Promise.resolve(), waitUntil(promise) { this.promise = promise; }};
    listeners[type](event);
    return event.promise;
  };
  return {
    caches, network, state,
    install:() => extendable('install'),
    activate:() => extendable('activate'),
    async message(data) {
      let reply;
      await extendable('message', {data, ports:[{postMessage:value => { reply = value; }}]});
      return reply;
    },
    // undefined: the request is left to the browser's network.
    async fetch(url, init) {
      let response;
      listeners.fetch({request:new Request(url, init), respondWith(value) { response = value; }});
      return response && await response;
    },
  };
}

test('install caches the verified build; its files then load offline, other requests use the network', async () => {
  const build = buildOf('b1'), sw = await worker(build);
  await sw.install();
  assert.deepEqual(await sw.caches.keys(), ['fallout2-app:/app/:b1']);
  assert.equal(sw.caches.stores.get('fallout2-app:/app/:b1').size, Object.keys(site).length + 1);
  sw.state.online = false;
  assert.equal(await (await sw.fetch(SCOPE)).text(), site['index.html']);
  assert.equal(await (await sw.fetch(SCOPE + 'files.html?mode=saves_import')).text(), site['files.html']);
  const wasm = await sw.fetch(SCOPE + 'fallout2-ce.wasm');
  assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
  assert.equal(JSON.parse(await (await sw.fetch(SCOPE + 'build-info.json')).text()).buildId, 'b1');
  for (const [url, init] of [[SCOPE + '__dev__/game.json'], [SCOPE + 'unknown.js'], ['https://other.test/app/index.html'],
    [SCOPE + 'app.js', {method:'POST', body:'x'}], [SCOPE + 'fallout2-ce.wasm', {headers:{Range:'bytes=0-1'}}]]) {
    assert.equal(await sw.fetch(url, init), undefined, url);
  }
});

test('a missing cache entry falls back to the network', async () => {
  const build = buildOf('b1'), sw = await worker(build);
  await sw.install();
  await (await sw.caches.open('fallout2-app:/app/:b1')).delete(SCOPE + 'app.js');
  const before = sw.network.length;
  assert.equal(await (await sw.fetch(SCOPE + 'app.js')).text(), site['app.js']);
  assert.equal(sw.network.length, before + 1);
});

test('a damaged, missing or foreign file never leaves a usable cache', async () => {
  const build = buildOf('b1');
  const cases = {
    damaged:serve(build, {...site, 'app.js':'export {}; // changed'}),
    missing:serve(build, {'index.html':site['index.html']}),
    foreign:serve(build, site, {info:{buildId:'b2', files:build.files}}),
  };
  for (const [name, server] of Object.entries(cases)) {
    const sw = await worker(build, {server});
    await assert.rejects(sw.install(), name);
    assert.deepEqual(await sw.caches.keys(), [], name);
  }
});

test('activation removes only older caches of the same app scope', async () => {
  const caches = new MemoryCaches();
  for (const name of ['fallout2-app:/app/:old', 'fallout2-app:/other/:old', 'unrelated']) await caches.open(name);
  const sw = await worker(buildOf('b1'), {caches});
  await sw.install(); await sw.activate();
  assert.deepEqual((await caches.keys()).sort(), ['fallout2-app:/app/:b1', 'fallout2-app:/other/:old', 'unrelated']);
});

test('a waiting build takes over only when the app has a single window', async () => {
  const lone = await worker(buildOf('b1'));
  assert.equal((await lone.message({type:'apply-update'})).applied, true);
  assert.equal(lone.state.skipped, true);
  const shared = await worker(buildOf('b1'), {windows:2});
  assert.equal((await shared.message({type:'apply-update'})).applied, false);
  assert.equal(shared.state.skipped, false);
});

// app-cache.js in a page with a fake service worker container.
async function page({controlled = true, idle = true, applied = true} = {}) {
  const previous = new Map(), events = new Map(), calls = {reloads:0, messages:0, applying:[]};
  const define = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {value, configurable:true, writable:true});
  };
  const waiting = {postMessage(data, [port]) {
    calls.messages++;
    assert.equal(data.type, 'apply-update');
    port.postMessage({applied});
    if (applied) setImmediate(() => events.get('controllerchange')());
  }};
  const registration = {waiting, addEventListener() {}, update:async () => {}};
  define('isSecureContext', true);
  define('navigator', {serviceWorker:{controller:controlled ? {} : null, register:async () => registration,
    addEventListener:(type, fn) => events.set(type, fn)}});
  define('document', {hidden:false, addEventListener() {}});
  define('location', {reload:() => { calls.reloads++; }});
  try {
    startAppCache({idle:() => idle, onApplying:value => calls.applying.push(value)});
    await new Promise(resolve => setTimeout(resolve, 20));
    return calls;
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
}

test('an idle launcher applies a waiting build and reloads once it takes over', async () => {
  const calls = await page();
  assert.deepEqual(calls, {reloads:1, messages:1, applying:[true]});
});

test('a refused update keeps Play available; a busy or first-visit page never asks', async () => {
  assert.deepEqual(await page({applied:false}), {reloads:0, messages:1, applying:[true, false]});
  assert.deepEqual(await page({idle:false}), {reloads:0, messages:0, applying:[]});
  assert.deepEqual(await page({controlled:false}), {reloads:0, messages:0, applying:[]});
});
