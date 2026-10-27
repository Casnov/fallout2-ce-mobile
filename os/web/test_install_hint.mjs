import test from 'node:test';
import assert from 'node:assert/strict';
import {installHint} from './install-hint.js';

const page = ({standalone = false, mode = 'browser', coarse = true, userAgent = 'Android', platform = 'Linux', maxTouchPoints = 5} = {}) => ({
  navigator:{standalone, userAgent, platform, maxTouchPoints},
  matchMedia:query => ({matches:query === `(display-mode: ${mode})` || (coarse && query === '(pointer: coarse)')}),
});

test('a browser tab on a phone or tablet says how to install; the installed app and computers say nothing', () => {
  assert.match(installHint(false, page()), /browser menu/);
  assert.match(installHint(true, page({userAgent:'iPhone'})), /Поделиться.*сначала/);
  assert.match(installHint(false, page({userAgent:'Macintosh', platform:'MacIntel'})), /Home Screen/);
  assert.equal(installHint(false, page({userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:0, coarse:false})), null);
  assert.equal(installHint(false, page({mode:'standalone'})), null);
  assert.equal(installHint(false, page({userAgent:'iPhone', standalone:true})), null);
});
