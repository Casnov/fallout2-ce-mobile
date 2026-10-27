// How to install the app from a phone's or tablet's browser tab; null in the
// installed app and on computers. iOS keeps a Home Screen app's storage apart
// from Safari's, so its hint says to install before choosing the game files.
export function installHint(ru, {navigator:device = globalThis.navigator, matchMedia:media = globalThis.matchMedia} = {}) {
  if (device.standalone || media('(display-mode: standalone)').matches || media('(display-mode: fullscreen)').matches) return null;
  if (/iP(hone|ad|od)/.test(device.userAgent) || (device.platform === 'MacIntel' && device.maxTouchPoints > 1)) {
    return ru ? 'Добавьте игру на экран «Домой» и запускайте оттуда: на весь экран и без сети. В Safari: «Поделиться» → «На экран „Домой“». Файлы игры, выбранные в Safari, туда не переносятся, поэтому сделайте это сначала.'
      : 'Add the game to your Home Screen and start it from there: full screen and offline. In Safari: Share → Add to Home Screen. Game files chosen in Safari don\'t carry over, so do this first.';
  }
  if (!media('(pointer: coarse)').matches) return null;
  return ru ? 'Установите игру через меню браузера (⋮ → «Установить приложение» или «Добавить на главный экран»): она откроется на весь экран и будет работать без сети.'
    : 'Install the game from the browser menu (⋮ → Install app or Add to Home screen) to play full screen and offline.';
}
