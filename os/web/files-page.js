import {createFilesView} from './files-view.js';
import {createFilesManager} from './files.js';
import {startAppCache} from './app-cache.js';
import {webText as t} from './strings.js';
document.title = 'Fallout 2 — ' + t('game_files').toLowerCase();
createFilesView(document.body);
createFilesManager({mode:new URLSearchParams(location.search).get('mode')});
// Registers the offline cache on a first run that starts here; new builds
// are applied by the launcher.
startAppCache();
addEventListener('pageshow',event => { if (event.persisted) location.reload(); });
