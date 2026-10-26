const $ = id => document.getElementById(id);
let worker, active = null, plan = null, busy = false, lastRead = null, build = null, cancelling = false;
const measurements = {schema:1,test:'fallout2-stage6',started:new Date().toISOString()};
const mib = value => (value / 1024 ** 2).toFixed(1) + ' МиБ';
const errors = {
  cancelled:'Подготовка отменена. Прежняя игра и сохранения остаются.',
  no_space:'По оценке хранилища не хватает места для новой установки. Прежняя игра и сохранения остаются.',
  invalid_path:'В ZIP есть небезопасные, повторяющиеся или конфликтующие имена файлов.',
  invalid_zip:'ZIP повреждён или его структура противоречива. Новая установка не активирована.',
  unsupported_zip:'Поддерживаются обычные файлы ZIP Store/Deflate без шифрования и ссылок.',
  base_required:'Сначала установи полную игру, затем можно добавить подготовленные файлы RPU.',
  missing_game:'В ZIP не найдена полная игра: нужны master.dat и critter.dat в одной папке.',
  ambiguous_root:'Найдено несколько папок с игрой на одном уровне. Подготовь архив одной игры.',
  limit:'Архив превышает допустимый размер, число файлов, длину пути или объём списка файлов.',
  stale_plan:'Установка изменилась после проверки ZIP. Выбери архив заново, чтобы пересчитать замену.',
  busy:'Закрой другие окна игры или установки и повтори.',
  io:'Не удалось прочитать архив или записать файлы. Прежняя игра не заменена.',
};
function message(text,failed = false) { $('status').textContent = text; $('status').classList.toggle('failed',failed); }
function controls(value) {
  busy = value;
  $('choose').disabled = value;
  $('choose').textContent = active ? 'Выбрать ZIP для замены игры' : 'Выбрать ZIP';
  $('read').disabled = value || !active || !!plan;
  $('clear').disabled = value || !!plan;
  $('copy').disabled = value || (!active && !measurements.error);
  $('cancel').hidden = !value; $('cancel').disabled = false;
  $('launch').hidden = value || !active || !!plan;
  $('zip-review').hidden = !plan;
  $('install').disabled = value; $('discard').disabled = value;
}
function review() {
  if (!plan) return;
  $('install').textContent = plan.replaces ? 'Заменить игру' : 'Установить игру';
  const delta = plan.changes;
  $('zip-summary').textContent = `${plan.filename}\nПапка: ${plan.root || 'корень архива'}\n`
    + `Игровых файлов: ${plan.files}; объём: ${mib(plan.bytes)}; пропущено служебных файлов: ${plan.ignored}.\n`
    + (plan.replaces ? `Новых: ${delta.added}; другого размера: ${delta.replaced}; того же размера: ${delta.sameSize}; отсутствуют в новом архиве: ${delta.removed}.\n` : '')
    + `Ориентировочный запас для подготовки новой установки: ${mib(plan.space.requiredUpper)}.`
    + (plan.space.free === null ? '' : ` По оценке свободно ${mib(plan.space.free)}.`);
  $('zip-summary').style.whiteSpace = 'pre-line';
}
function report() {
  measurements.build = build;
  measurements.installed = active ? {run:active.run,completed:active.completed,files:active.files.length,...active.measurements} : null;
  measurements.read = lastRead;
  measurements.storage = active ? {databaseVersion:2,format:active.format,installation:active.run} : null;
  $('report').hidden = !active;
  if (active) {
    const info = active.measurements, timing = info.stage5;
    $('report').textContent = `Сборка: ${build || '?'}\nФайлов: ${active.files.length}; объём: ${mib(info.bytes)}\n`
      + `Распаковка и запись: ${(info.importMs / 1000).toFixed(1)} с\nБлок: ${info.blockSize / 1024} КиБ\n`
      + (timing ? `Транзакций блоков: ${timing.transactions}; хеширование: ${(timing.hashMs / 1000).toFixed(1)} с; запись: ${(timing.writeMs / 1000).toFixed(1)} с\n`
        + `Новых данных: ${mib(timing.newBytes)}; переиспользовано: ${mib(timing.reusedBytes)}\n` : '')
      + (lastRead ? `Повторное открытие: ${lastRead.openMs.toFixed(1)} мс\nЧтений: ${lastRead.reads}; медиана: ${lastRead.medianMs.toFixed(1)} мс; максимум: ${lastRead.maxMs.toFixed(1)} мс\nЦелостность прочитанных блоков: подтверждена SHA-256` : 'Отдельное чтение ещё не проверено.')
      + (measurements.userStorage ? `\nСлотов на устройстве: ${measurements.userStorage.saveSlots ?? '?'}; файлов настроек: ${measurements.userStorage.settingsFiles ?? '?'}` : '');
  }
}
function run(type,extra = {}) {
  cancelling = false;
  controls(true); $('cancel').hidden = !['inspect','install'].includes(type);
  worker.postMessage({type,...extra});
}
async function environment() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const estimate = await navigator.storage?.estimate?.();
  measurements.environment = {secure:isSecureContext,standalone,userAgent:navigator.userAgent,
    quota:estimate?.quota,usage:estimate?.usage,persisted:await navigator.storage?.persisted?.()};
  $('environment').textContent = `${standalone ? 'Запуск с экрана «Домой»' : 'Запуск в браузере'} · ${isSecureContext ? 'защищённый адрес' : 'нужен HTTPS'}`
    + (estimate?.quota ? ` · доступно сайту примерно ${mib(Math.max(0,estimate.quota-estimate.usage))}` : '');
}
async function start() {
  if (!isSecureContext || !globalThis.indexedDB || !crypto.subtle || !navigator.locks || !globalThis.Worker) {
    throw new Error('Нужен современный браузер по HTTPS с поддержкой местного хранилища.');
  }
  const response = await fetch('./build-info.json',{cache:'no-store'});
  if (!response.ok) throw new Error('Не удалось загрузить версию проверки.');
  build = (await response.json()).buildId;
  await environment();
  worker = new Worker(new URL('./probe-worker.js',import.meta.url),{type:'module'});
  worker.onerror = () => {
    worker.terminate(); plan = null; controls(false);
    for (const id of ['choose','read','clear']) $(id).disabled = true;
    message('Проверка прервана. Закрой и открой приложение снова; незавершённая установка восстановится безопасно.',true);
  };
  worker.onmessage = async ({data}) => {
    if (data.type === 'progress') {
      const value = data.value;
      if (value.cancelAllowed === false) { $('cancel').hidden = true; $('cancel').disabled = true; }
      if (value.phase === 'migrate') { message('Обновляю местное хранилище. ZIP повторно выбирать не нужно…'); return; }
      if (value.phase === 'commit') { message('Завершаю проверку и переключаю установленную игру…'); return; }
      if (value.phase === 'cleanup') { message('Убираю неиспользуемые временные данные…'); return; }
      if (value.phase === 'complete') return;
      $('import-progress').max = value.total || 1; $('import-progress').value = value.bytes;
      if (!cancelling) message(`Подготовлено: ${mib(value.bytes)} из ${mib(value.total)}\nФайлы: ${value.index} из ${value.files}\n${value.file || ''}`);
      return;
    }
    cancelling = false; $('import-progress').hidden = true;
    const previous = active?.run;
    if ('active' in data) active = data.active;
    if (active?.run !== previous) lastRead = null;
    if (data.userStorage) measurements.userStorage = data.userStorage;
    if (data.type === 'error') {
      plan = null;
      measurements.error = {code:data.code,cancelled:data.cancelled,message:data.message};
      message(errors[data.code] || errors.io,!data.cancelled);
    } else {
      plan = data.plan || null;
      if (data.action === 'inspect') {
        delete measurements.error; measurements.zipPlan = plan;
        message('Список файлов проверен. Проверь состав и подтверди установку.');
      } else if (data.action === 'install') {
        delete measurements.error; measurements.lastImport = active?.importResult;
        message('Установка завершена. Местные ресурсы готовы, сохранения и настройки остаются.');
      } else if (data.action === 'read') {
        lastRead = data.read || null;
        message(lastRead ? 'База открыта заново. Прочитанные блоки прошли проверку целостности.' : 'Установка изменилась. Повтори чтение.');
      } else message(active ? 'Игра найдена на устройстве. Можно запустить её или проверить новый ZIP.'
        : data.action === 'clear' ? 'Местные ресурсы удалены. Сохранения и настройки не очищались.' : 'Выбери ZIP полной установленной игры с RPU.');
    }
    controls(false); review(); report(); await environment();
  };
  run('status');
}
$('choose').onclick = () => $('archive').click();
$('archive').onchange = async () => {
  const file = $('archive').files[0]; $('archive').value = '';
  if (!file || busy) return;
  controls(true); $('cancel').hidden = true;
  try { measurements.persistRequest = await navigator.storage?.persist?.(); } catch {}
  delete measurements.error;
  $('import-progress').hidden = false; $('import-progress').removeAttribute('value');
  message('Проверяю список файлов ZIP…'); run('inspect',{file});
};
$('install').onclick = () => {
  if (!plan || busy) return;
  $('import-progress').hidden = false; $('import-progress').removeAttribute('value');
  message('Готовлю новую установку…'); run('install',{token:plan.token});
};
$('discard').onclick = () => run('discard');
$('cancel').onclick = () => {
  cancelling = true; $('cancel').disabled = true; message('Отменяю подготовку новой установки…');
  worker.postMessage({type:'cancel'});
};
$('read').onclick = () => { message('Открываю базу заново и проверяю чтение…'); run('read'); };
$('clear').onclick = () => {
  if (confirm('Удалить местные ресурсы игры этого адреса? ZIP в «Файлах» и отдельная область сохранений не удаляются. Сначала закрой игру в других окнах.')) run('clear');
};
$('copy').onclick = async () => {
  report();
  try { await navigator.clipboard.writeText(JSON.stringify(measurements,null,2)); message('Результат скопирован. Его можно прислать в чат.'); }
  catch { message('Не удалось скопировать результат. Можно прислать скриншот.'); }
};
addEventListener('pagehide',() => worker?.terminate(),{once:true});
addEventListener('pageshow',event => { if (event.persisted) location.reload(); });
start().catch(error => message(String(error.message || error),true));
