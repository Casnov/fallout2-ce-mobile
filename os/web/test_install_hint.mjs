import test from 'node:test';
import assert from 'node:assert/strict';
import {installHint} from './install-hint.js';
import {webText} from './strings.js';

const page = ({standalone = false, mode = 'browser', coarse = true, userAgent = 'Android', platform = 'Linux', maxTouchPoints = 5} = {}) => ({
  navigator:{standalone, userAgent, platform, maxTouchPoints},
  matchMedia:query => ({matches:query === `(display-mode: ${mode})` || (coarse && query === '(pointer: coarse)')}),
});

test('a browser tab on a phone or tablet says how to install; the installed app and computers say nothing', () => {
  assert.equal(installHint(page()), 'install_hint_browser');
  assert.equal(installHint(page({userAgent:'iPhone'})), 'install_hint_ios');
  assert.equal(installHint(page({userAgent:'Macintosh', platform:'MacIntel'})), 'install_hint_ios');
  assert.equal(installHint(page({userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:0, coarse:false})), null);
  assert.equal(installHint(page({mode:'standalone'})), null);
  assert.equal(installHint(page({userAgent:'iPhone', standalone:true})), null);
  assert.match(webText(installHint(page({userAgent:'iPhone'}))), /Home Screen/);
});
