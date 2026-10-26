const $ = id => document.getElementById(id), worker = new Worker(new URL('./large-zip-probe-worker.js',import.meta.url),{type:'module'});
const report = {test:'large-zip-probe-v2',started:new Date().toISOString(),userAgent:navigator.userAgent,secure:isSecureContext,standalone:matchMedia('(display-mode:standalone)').matches};
let file, url, many = false;
function render() { $('report').textContent = JSON.stringify(report,null,2); }
function busy(value) { $('large').disabled = $('many').disabled = $('clear').disabled = $('check').disabled = value; $('cancel').hidden = !value; }
for (const id of ['large','many']) $(id).onclick = () => { many = id === 'many'; busy(true); $('download').hidden = true; $('status').textContent = 'Создаю тестовый ZIP…'; worker.postMessage({type:id}); };
$('cancel').onclick = () => worker.postMessage({type:'cancel'});
$('clear').onclick = () => { if (url) URL.revokeObjectURL(url); file = null; $('download').hidden = true; worker.postMessage({type:'clear'}); };
$('check').onchange = () => { if ($('check').files[0]) worker.postMessage({type:'check',file:$('check').files[0],expectedBytes:report.created?.bytes}); };
$('copy').onclick = async () => { await navigator.clipboard.writeText(JSON.stringify(report,null,2)); $('status').textContent = 'Отчёт скопирован.'; };
$('download').onclick = () => {
  report.handoff = {method:'download',started:new Date().toISOString(),size:file.size};
  $('status').textContent = 'Скачивание запрошено. После сохранения выбери полученный ZIP в поле проверки ниже.'; render();
};
worker.onmessage = ({data}) => {
  if (data.type === 'progress') { $('progress').value = Math.min(1,(many ? data.files : data.bytes) / data.total); return; }
  busy(false);
  if (data.type === 'ready') {
    if (url) URL.revokeObjectURL(url);
    file = data.file; url = URL.createObjectURL(file); report.created = data.result;
    report.receivedSize = file.size;
    if (file.size !== data.result.bytes) { $('status').textContent = 'Размер файла изменился при передаче со страницы подготовки. Скопируй отчёт; сохранять такой ZIP не нужно.'; render(); return; }
    $('download').href = url; $('download').download = 'fallout2-zip-probe.zip'; $('download').hidden = false;
    $('status').textContent = 'ZIP подготовлен. Теперь сохрани его в «Файлы».'; $('progress').value = 1;
  } else if (data.type === 'checked') {
    report.selected = {...data,name:undefined}; $('status').textContent = data.zipStructure && data.matchesExpected ? 'Размер совпадает, крайние записи ZIP проверены. Это не полная проверка CRC содержимого.' : 'Файл не совпадает по размеру или не прошёл проверку структуры ZIP.';
  } else if (data.type === 'cleared') { report.cleared = new Date().toISOString(); $('status').textContent = 'Временные файлы теста удалены. Копию в «Файлах» удали отдельно.'; }
  else { report.error = data; $('status').textContent = data.name === 'AbortError' ? 'Тест отменён.' : data.message; }
  render();
};
render();
