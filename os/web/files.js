import {nativeText as n} from './import-native.js';

export function createFilesManager({root = document, mode = null, resources = null, buildId = null, onReturn = () => { location.href = './index.html'; }, download = null} = {}) {
  const ru = navigator.language.toLowerCase().startsWith('ru');
  const t = (r,e) => ru ? r : e, $ = id => root.getElementById(id);
  const surface = root.host || document.body;
  document.documentElement.lang = ru ? 'ru' : 'en';
  const size = value => (value / 1024 ** 2).toFixed(1) + t(' МиБ',' MiB');
  let worker, active = resources?.active, plan, file, pickMode = 'game', busy = true, downloaded = null, cancelling = false, pendingAction = null;
  let previousStep = null, returning = false, doneTimer = null, failedWorker = false;
  const initialMode = mode;
  const labels = {
    title:n('import_title'), saves:n('saves_title'), choose:n('import_choose_archive'),
    play:resources ? n('import_back_to_game') : t('Начать игру','Play'), other:n('import_choose_other'), cancel:n('import_cancel'),
  };
  const errors = {
    cancelled:t('Подготовка отменена. Прежние файлы и сохранения остались.','Preparation cancelled. Existing files and saves are unchanged.'),
    no_space:t('Недостаточно места для безопасной подготовки. Прежняя установка сохранена.','Not enough storage to prepare the installation safely. Existing installation is unchanged.'),
    invalid_zip:t('ZIP повреждён. Новые файлы не установлены.','The ZIP is damaged. New files were not installed.'),
    invalid_path:t('В ZIP есть небезопасные или конфликтующие пути.','The ZIP contains unsafe or conflicting paths.'),
    unsupported_zip:t('Нужен ZIP Store/Deflate без пароля, ссылок и специальных файлов.','Use a Store/Deflate ZIP without encryption, links or special files.'),
    missing_game:t('Не найдена полная игра: master.dat и critter.dat должны лежать вместе.','A full game needs master.dat and critter.dat in the same folder.'),
    base_required:t('Сначала установи полную игру. Затем можно добавить подготовленные файлы RPU.','Install the full game before adding prepared RPU files or saves.'),
    ambiguous_root:t('В архиве несколько подходящих папок. Подготовь ZIP одной игры или одного набора сейвов.','Several matching folders found. Choose one game or one set of saves.'),
    limit:t('Архив превышает допустимые размеры каталога или метаданных. Прежние данные сохранены.','Archive directory or metadata exceeds supported bounds. Existing data is unchanged.'),
    invalid_save:t('Повреждённый сейв или неподдерживаемое пользовательское хранилище. Текущие сейвы сохранены.','Invalid save or unsupported user storage. Existing saves are unchanged.'),
    no_saves:t('Сохранения не найдены. Нужны папки SLOT… с SAVE.DAT.','No saves found. Choose SLOT folders containing SAVE.DAT.'),
    slot_limit:t('Не хватает свободных обычных слотов. Текущие сейвы не удалялись.','Not enough free manual slots. Existing saves were not deleted.'),
    busy:t('Закрой другие окна игры или импорта и повтори.','Close other game or import windows and try again.'),
    stale_plan:t('План устарел. Выбери ZIP ещё раз.','This plan has expired. Choose the ZIP again.'),
    recovery_needed:t('Сначала запусти игру один раз: она восстановит прерванную старую запись сейва. Затем повтори перенос.','Start the game once to recover an interrupted legacy save, then try the transfer again.'),
  };
  function revoke() { if (downloaded) URL.revokeObjectURL(downloaded); downloaded = null; $('download').hidden = true; }
  function buttons(primary,secondary) {
    for (const [id,action] of [['primary',primary],['secondary',secondary]]) {
      $(id).hidden = !action; $(id).disabled = false;
      if (action) { $(id).textContent = action[0]; $(id).onclick = action[1]; }
    }
  }
  // The corner arrow has Android's meaning: leave the manager for the game.
  // A previous step (e.g. replace confirmation -> review) is separate, like
  // Android's system Back, and is also available through Escape here.
  function back(action) { previousStep = action; $('back').hidden = busy || !active; }
  function show(title,message,details = '',note = '') {
    clearTimeout(doneTimer); doneTimer = null;
    $('download').hidden = true;
    $('title').textContent = title; $('message').textContent = message; $('details').textContent = details; $('note').textContent = note;
    $('progress').hidden = $('progress-text').hidden = true; $('saves-actions').hidden = true; back(null);
    surface.classList.remove('error');
  }
  async function play() {
    busy = true;
    try { await onReturn(); }
    catch (error) {
      busy = false; returning = false;
      show(labels.saves,t('Не удалось вернуться в игру. Повтори попытку.','Could not return to the game. Try again.'),String(error.message || error));
      buttons([t('Повторить','Retry'),play]); back(null);
    }
  }
  function returnToGame() {
    if (busy || !active) return;
    returning = true;
    show(labels.title,t('Возвращаюсь в игру…','Returning to the game…'));
    if (failedWorker) { play(); return; }
    // Dispose staged imports and release their leases before the next engine
    // starts. Merely terminating the worker leaves cleanup to a future launch.
    send('discard');
  }
  function importWelcome() {
    pickMode = 'saves';
    show(labels.saves,t('Выберите ZIP с сохранениями: папку SAVEGAME, папки SLOT или всю игру. Экспорт из этой игры переносит и даты, и сведения о совместимости.',
      'Choose a ZIP with saves: the SAVEGAME folder, SLOT folders or the whole game. An export of this game brings their dates and compatibility along.'));
    buttons([labels.choose,() => choose('saves')]);
  }
  function welcome() {
    if (resources) {
      if (initialMode === 'saves_export') { show(labels.saves,n('saves_exporting')); send('export-saves'); }
      else importWelcome();
      return;
    }
    plan = null; revoke();
    show(labels.title,active ? t('Fallout 2 установлена на этом устройстве.','Fallout 2 is installed on this device.')
      : t('Для игры нужны файлы твоей копии Fallout 2. Выбери ZIP полной игры; установленный RPU может находиться внутри.','Choose a ZIP of your own Fallout 2 installation. It may include installed RPU files.'),
      active ? `${active.files.length} ${t('файлов','files')} · ${size(active.measurements.bytes)}` : '',
      t('Принимаются ZIP и ZIP64. Windows-установщик RPU нужно заранее запустить на компьютере и упаковать полученные файлы.','ZIP and ZIP64 are supported. Run the RPU Windows installer on a computer first, then archive the installed files.'));
    buttons([active ? t('Заменить игру / моды','Replace game / mods') : labels.choose,() => choose('game')],active ? [labels.play,play] : null);
    $('saves-actions').hidden = !active;
  }
  function choose(mode) { pickMode = mode; $('archive').click(); }
  function send(type,extra = {}) {
    if (busy) return;
    pendingAction = type;
    busy = true; cancelling = false; revoke(); $('saves-actions').hidden = true; back(null);
    $('progress').hidden = false; $('progress').removeAttribute('value'); $('progress-text').hidden = false;
    buttons(null,['inspect','inspect-saves','install','install-saves','export-saves','export-before-replace','export-legacy'].includes(type)
      ? [labels.cancel,() => { cancelling = true; $('secondary').disabled = true; $('message').textContent = t('Отменяю…','Cancelling…'); worker.postMessage({type:'cancel'}); }] : null);
    if (type === 'install-saves') $('message').textContent = n('saves_copying');
    worker.postMessage({type,...extra,...(type === 'status' && resources ? {resources} : {})});
  }
  function inspect(mode,chosen,rootHint) {
    file = chosen;
    show(mode === 'saves' ? labels.saves : labels.title,t('Проверяю архив…','Checking the archive…'));
    send(mode === 'saves' ? 'inspect-saves' : 'inspect',{file:chosen,rootHint});
  }
  function review() {
    const saves = plan.kind === 'saves';
    if (saves) {
      const compatibility = ['saves_count_same','saves_count_likely','saves_count_unlikely','saves_count_unknown'];
      const changeText = ([kind,path]) => n(['saves_change_game','saves_change_updated','saves_change_added','saves_change_removed'][Number(kind)] || 'saves_change_removed',path.split('/').at(-1));
      show(labels.saves,[n('saves_found',plan.found),
        ...plan.compatibility.map((count,i) => count ? n(compatibility[i],count) : ''),
        plan.skipped ? n('saves_count_duplicate',plan.skipped) : ''].filter(Boolean).join('\n'),
        plan.saves.map(s => `${[' ','?','×','·'][s.level]} ${s.title || t('Без названия','Untitled')}${s.date ? '  ' + s.date : ''}${s.duplicate ? '  (' + n('saves_already_there') + ')' : ''}` + s.changes.map(change => '\n    ' + changeText(change)).join('')).join('\n'),
        plan.addError ? errors.slot_limit : '');
      buttons(!plan.addError && plan.added ? [n('saves_add'),() => send('install-saves',{token:plan.token})] : null,
        !plan.replaceError ? [n('saves_replace_all'),confirmReplace] : null);
      back(() => send('discard'));
    } else {
      const game = plan.description, delta = plan.changes;
      show(labels.title,n('import_found'),
        `${t('Язык','Language')}: ${game.language}\n${t('Моды','Mods')}: ${game.mods.join(', ') || t('DAT-моды не обнаружены','No DAT mods detected')}`
        + (game.looseLogic ? '\n' + t('Есть отдельные скрипты, карты или прототипы.','Loose scripts, maps or prototypes found.') : '')
        + `\n${plan.files} ${t('файлов','files')} · ${size(plan.bytes)}`
        + (plan.replaces ? '\n' + t(`Новых: ${delta.added}; другого размера: ${delta.replaced}; того же размера: ${delta.sameSize}; удаляется: ${delta.removed}.`,
          `New: ${delta.added}; different size: ${delta.replaced}; same size: ${delta.sameSize}; removed: ${delta.removed}.`) : '')
        + (plan.mode === 'mods' ? '\n' + t(`База и музыка сохраняются (${plan.keptFiles} файлов). Прежние моды, отсутствующие в ZIP, удаляются.`,`Base files and music are preserved (${plan.keptFiles} files). Previous mods missing from this ZIP are removed.`) : '')
        + `\n${t('Ориентировочный запас места','Estimated storage reserve')}: ${size(plan.space.requiredUpper)}`
        + (plan.archiveSaves ? '\n' + t(`Сохранений в ZIP: ${plan.archiveSaves}. После установки их можно добавить отдельно.`,`Saves in ZIP: ${plan.archiveSaves}. You can add them separately after installation.`) : ''),
        t('Текущие сохранения и пользовательские настройки остаются. Смена RPU может повлиять на совместимость старых сейвов.','Existing saves and player settings are preserved. Changing RPU may affect save compatibility.'));
      buttons([plan.replaces ? n('import_replace') : t('Установить','Install'),() => send('install',{token:plan.token})],[labels.other,() => send('discard')]);
    }
  }
  function confirmReplace() {
    if (!plan) return;
    if (!plan.current && !plan.replaceConverted) { send('install-saves',{token:plan.token,replaceAll:true}); return; }
    show(labels.saves,plan.current ? n('saves_replace_confirm',plan.current) : t('Восстановить выбранные сохранения?','Restore selected saves?'),
      plan.replaceConverted ? t(`Быстрых слотов сейчас меньше: ${plan.replaceConverted} быстрых сохранений станут обычными. Все выбранные сейвы будут сохранены.`,`There are fewer quick slots now: ${plan.replaceConverted} quick saves will become manual saves. All selected saves will be retained.`) : '');
    buttons([n('saves_replace'),() => send('install-saves',{token:plan.token,replaceAll:true})],
      plan.current ? [n('saves_export_first'),() => send('export-before-replace',{token:plan.token})] : null);
    back(review);
  }
  function complete(action = returnToGame) {
    busy = true; back(null); buttons(null,null);
    doneTimer = setTimeout(() => { busy = false; action(); },1500);
  }
  function exported(result,after = null) {
    if (download) {
      function attempt() {
        try {
          download(result);
          show(labels.saves,t('ZIP подготовлен. Скачивание запрошено.','ZIP ready. Download requested.'));
          complete(after || returnToGame);
        } catch (error) {
          busy = false;
          show(labels.saves,t('Не удалось начать скачивание ZIP. Повтори попытку или вернись в игру.','Could not start the ZIP download. Try again or return to the game.'),String(error.message || error));
          buttons([t('Повторить','Retry'),attempt]);
          back(null);
        }
      }
      attempt();
      return;
    }
    downloaded = URL.createObjectURL(result.blob);
    show(labels.saves,n('saves_exported',result.slots),
      t('Нажми «Сохранить ZIP». Готовый файл можно найти в загрузках браузера или в «Файлах».','Choose Save ZIP. Find the downloaded file in browser downloads or Files.'));
    // WebKit's Web Share path uses ReadAsArrayBuffer for the entire file before
    // opening the sheet. The iPhone >4GiB probe confirmed that download works
    // while share fails reading. Keep one disk-backed download path at all sizes.
    $('download').href = downloaded; $('download').download = result.filename; $('download').textContent = t('Сохранить ZIP','Save ZIP'); $('download').hidden = false;
    // Browsers cannot report when the file has actually reached Files. Keep
    // its URL alive until the user leaves; never auto-return after a download.
    buttons(null,after ? [n('saves_replace_all'),after] : null);
  }
  async function start() {
    $('saves-import').textContent = t('Импорт сохранений','Import saves'); $('saves-export').textContent = t('Экспорт сохранений','Export saves');
    $('back').setAttribute('aria-label',n('import_back_to_game'));
    $('technical').textContent = t('Техническая проверка','Technical check');
    if (!isSecureContext || !navigator.locks || !globalThis.indexedDB) throw new Error(t('Нужен современный браузер по HTTPS.','A modern browser over HTTPS is required.'));
    if (!buildId) {
      const response = await fetch('./build-info.json',{cache:'no-store'}); if (!response.ok) throw new Error('build-info');
      buildId = (await response.json()).buildId;
    }
    $('build').textContent = buildId;
    if (resources) { $('technical').target = '_blank'; $('technical').rel = 'noopener'; }
    failedWorker = false;
    worker = new Worker(new URL('./probe-worker.js',import.meta.url),{type:'module'});
    worker.onerror = () => {
      worker.terminate(); failedWorker = true; busy = false;
      show(labels.title,t('Операция прервалась. Повтори попытку или вернись в игру.','Operation interrupted. Try again or return to the game.'));
      buttons([t('Повторить','Retry'),() => start().catch(startFailure)]); back(null);
    };
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') {
        const value = data.value;
        if (value.cancelAllowed === false) buttons(null,null);
        if (value.phase === 'commit' || value.phase === 'cleanup') { $('message').textContent = t('Завершаю установку…','Finishing installation…'); return; }
        if (value.phase === 'migrate') { $('message').textContent = t('Обновляю местное хранилище…','Upgrading local storage…'); return; }
        if (value.phase === 'complete') return;
        $('progress').max = value.total || 1; $('progress').value = value.bytes || 0;
        $('progress-text').textContent = `${size(value.bytes || 0)} / ${size(value.total || 0)} · ${value.file || ''}`;
        if (!cancelling) $('message').textContent = value.phase === 'export' ? t('Готовлю ZIP сохранений…','Preparing save ZIP…') : t('Подготавливаю файлы…','Preparing files…');
        return;
      }
      const oldPlan = plan; busy = false;
      if ('active' in data) active = data.active;
      surface.classList.toggle('has-game',!!active);
      if ('font' in data) (root.host || document.documentElement).dataset.font = data.font === 1 ? 'mono' : 'classic';
      if (data.type === 'error') {
        returning = false;
        if (resources && data.cancelled) { returnToGame(); return; }
        if (resources && data.code === 'no_saves' && pendingAction === 'export-saves') {
          show(labels.saves,n('saves_export_none')); complete(); return;
        }
        plan = null; show(resources ? labels.saves : labels.title,errors[data.code] || t('Операция не выполнена. Прежние данные не заменены.','Operation failed. Previous data was not replaced.'));
        $('details').textContent = data.message; surface.classList.add('error');
        if (!resources && (data.userStorage?.migration || (data.userStorage?.format === 2 && data.code === 'no_space'))) {
          $('note').textContent = t('Прежние сейвы сохранены. Можно экспортировать их без завершения переноса; для ZIP тоже потребуется свободное место.','Legacy saves are intact. You can export them without finishing migration; the ZIP also needs free space.');
          buttons([t('Экспорт прежних сейвов','Export legacy saves'),() => send('export-legacy')],[t('Повторить','Retry'),welcome]);
        } else buttons([t('Попробовать снова','Try again'),welcome],active ? [labels.play,play] : null);
        return;
      }
      plan = data.plan;
      if (returning) { returning = false; play(); return; }
      if (['export-saves','export-before-replace','export-legacy'].includes(data.action)) { exported(data.exchange,data.action === 'export-before-replace' ? confirmReplace : null); return; }
      if (plan) { review(); return; }
      if (data.action === 'install' && oldPlan?.archiveSaves && file) {
        show(labels.title,t('Игра установлена. В архиве также есть сохранения.','Game installed. The archive also contains saves.'),t('Их можно проверить и добавить отдельно. Текущие слоты останутся.','Review and add them separately. Existing slots are preserved.'));
        buttons([t('Проверить сохранения','Review saves'),() => inspect('saves',file,oldPlan.root)],[labels.play,play]); return;
      }
      if (data.action === 'install-saves') {
        show(labels.saves,n('saves_done',data.exchange.added),data.exchange.skipped ? n('saves_count_duplicate',data.exchange.skipped) : '');
        complete(); return;
      }
      if (data.action === 'discard' && oldPlan?.kind === 'saves') { importWelcome(); return; }
      welcome();
      if (data.action === 'status' && initialMode === 'saves_import') {
        importWelcome();
      } else if (data.action === 'status' && initialMode === 'saves_export') {
        show(labels.saves,n('saves_exporting')); send('export-saves');
      }
    };
    busy = false; send('status');
  }
  $('archive').onchange = async () => {
    const chosen = $('archive').files[0]; $('archive').value = '';
    if (!chosen || busy) return;
    // Lock the UI before any permission-sensitive promise can yield.
    busy = true; buttons(null,null);
    try { await navigator.storage?.persist?.(); } catch {}
    busy = false; inspect(pickMode,chosen);
  };
  $('back').onclick = returnToGame;
  const keydown = event => {
    if (event.key !== 'Escape' || busy) return;
    event.preventDefault();
    if (previousStep) previousStep(); else returnToGame();
  };
  root.addEventListener('keydown',keydown);
  $('saves-import').onclick = importWelcome;
  $('saves-export').onclick = () => { show(labels.saves,n('saves_exporting')); send('export-saves'); };
  function destroy() {
    clearTimeout(doneTimer); revoke();
    if (worker) { worker.onmessage = worker.onerror = null; worker.terminate(); }
    root.removeEventListener('keydown',keydown); removeEventListener('pagehide',destroy);
  }
  addEventListener('pagehide',destroy,{once:true});
  function startFailure(error) {
    busy = false; failedWorker = true;
    show(labels.title,t('Не удалось открыть хранилище.','Could not open storage.'),String(error.message || error));
    buttons([t('Повторить','Retry'),() => { worker?.terminate(); start().catch(startFailure); }]); back(null);
  }
  show(labels.saves,t('Открываю хранилище…','Opening storage…')); buttons(null,null);
  const ready = start().catch(startFailure);
  return {ready,destroy};
}

