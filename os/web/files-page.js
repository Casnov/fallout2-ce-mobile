import {createFilesView} from './files-view.js';
import {createFilesManager} from './files.js';
createFilesView(document.body);
createFilesManager({mode:new URLSearchParams(location.search).get('mode')});
addEventListener('pageshow',event => { if (event.persisted) location.reload(); });
