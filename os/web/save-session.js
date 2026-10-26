import {createFilesManager} from './files.js';

// The resource lease never leaves the engine. Only the user writer is handed
// to the worker, while the calling native preferences stack waits in Asyncify.
export function createSaveSession({host,root,canvas,user,source,audio,textInput,buildId,download,
  managerFactory = createFilesManager} = {}) {
  let active = false;
  return async function exchange(mode) {
    if (active || !['saves_import','saves_export'].includes(mode)) throw new Error('Invalid save exchange');
    active = true;
    const ru = navigator.language.toLowerCase().startsWith('ru');
    const $ = id => root.getElementById(id);
    textInput.end(); host.hidden = false; canvas.inert = true;
    document.body.classList.add('exchanging');
    $('title').textContent = ru ? 'Сохранения' : 'Saves';
    $('message').textContent = ru ? 'Открываю хранилище…' : 'Opening storage…';
    for (const id of ['details','note','progress-text']) $(id).textContent = '';
    for (const id of ['back','download','primary','secondary','saves-actions','progress','progress-text']) $(id).hidden = true;
    let manager, finishing = false;
    return new Promise(resolve => {
      function failure(error,again) {
        $('title').textContent = ru ? 'Сохранения' : 'Saves';
        $('message').textContent = ru ? 'Операция не завершена. Текущая игра остаётся на паузе.' : 'Operation incomplete. Your current game is still paused.';
        $('details').textContent = String(error.message || error);
        for (const id of ['progress','progress-text','back','download','secondary','saves-actions']) $(id).hidden = true;
        const button = $('primary'); button.hidden = false; button.disabled = false;
        button.textContent = ru ? 'Вернуться в игру' : 'Return to game'; button.onclick = again;
        button.focus();
      }
      async function finish() {
        if (finishing) return;
        finishing = true;
        try {
          if (user.status().suspended) await user.resume();
          manager?.destroy();
          host.hidden = true; canvas.inert = false;
          document.body.classList.remove('exchanging');
          canvas.focus(); audio.unpause(); active = false; resolve();
        } catch (error) {
          finishing = false;
          // Never let C++ run against a closed store. Retry can reacquire the
          // writer if another window briefly owned it, without losing RAM state.
          failure(error,finish);
        }
      }
      (async () => {
        await audio.pause();
        await user.commit();
        const resources = await source.saveExchangeResources();
        await user.suspend();
        manager = managerFactory({root,mode,resources,buildId,download,onReturn:finish});
        await manager.ready;
      })().catch(error => failure(error,finish));
    });
  };
}
