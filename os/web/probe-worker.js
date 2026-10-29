import {prepareGameZip,importErrorInfo} from './zip-import.js';
import {openResourceStore} from './resource-store.js';
import {prepareSaveZip,exportSaveZip,launcherFont} from './save-streams.js';
let controller = null, prepared = null, phase = 'idle';
let resources = null;
function resourceOwner() {
  if (!resources) return openResourceStore();
  // The paused engine owns the immutable installation lease. Its two config
  // snapshots are the only resource payloads save exchange can read.
  return {active:async () => resources.active,close:async () => {},
    async read(active,file,offset,length) {
      const bytes = resources.configs.find(config => config.path === file.path)?.bytes;
      if (!bytes || offset < 0 || offset + length > bytes.length) throw new Error('Invalid pinned resource read');
      return bytes.subarray(offset,offset + length);
    }};
}
function progress(value) {
  phase = value.phase;
  self.postMessage({type:'progress',value});
}
async function disposePlan() {
  const old = prepared; prepared = null;
  await old?.dispose();
}
async function activeSnapshot() {
  const store = resources ? resourceOwner() : await openResourceStore();
  try { return await store.active(); } finally { await store.close(); }
}
self.onmessage = async ({data}) => {
  if (data.type === 'cancel') {
    if (!['commit','cleanup','complete'].includes(phase)) controller?.abort();
    else progress({phase,cancelAllowed:false});
    return;
  }
  if (controller) { self.postMessage({type:'error',code:'busy',message:'Another operation is running'}); return; }
  controller = new AbortController(); phase = 'inspect';
  try {
    if (data.resources) {
      if (resources || data.type !== 'status' || !data.resources.active?.run) throw new Error('Invalid exchange initialization');
      resources = data.resources;
    }
    if (resources && !['status','discard','inspect-saves','install-saves','export-saves','export-before-replace'].includes(data.type)) throw new Error('Only save exchange is allowed over a live game');
    let active, exchange;
    switch (data.type) {
      case 'inspect':
        await disposePlan();
        prepared = await prepareGameZip(data.file,{signal:controller.signal,choice:data.choice ?? null});
        active = await activeSnapshot();
        break;
      case 'install': {
        if (!prepared || prepared.summary.kind === 'saves' || data.token !== prepared.summary.token) {
          await disposePlan();
          const error = new Error('Choose the ZIP again');
          error.name = 'StalePlanError'; throw error;
        }
        const plan = prepared; prepared = null;
        active = await plan.install({signal:controller.signal,progress});
        break;
      }
      case 'inspect-saves':
        await disposePlan();
        active = await activeSnapshot();
        prepared = await prepareSaveZip(data.file,{signal:controller.signal,progress,rootHint:data.rootHint,storeFactory:resourceOwner});
        break;
      case 'install-saves': {
        if (!prepared || prepared.summary.kind !== 'saves' || data.token !== prepared.summary.token) {
          const error = new Error('Choose the ZIP again'); error.name = 'StalePlanError'; throw error;
        }
        const plan = prepared; prepared = null;
        active = plan.active;
        exchange = await plan.install({signal:controller.signal,progress,replaceAll:data.replaceAll === true});
        break;
      }
      case 'export-before-replace':
        if (!prepared || prepared.summary.kind !== 'saves' || data.token !== prepared.summary.token) throw new Error('Choose the ZIP again');
        active = prepared.active; exchange = await prepared.export({signal:controller.signal,progress}); break;
      case 'export-saves':
        await disposePlan(); exchange = await exportSaveZip({signal:controller.signal,progress,storeFactory:resourceOwner});
        active = await activeSnapshot(); break;
      case 'discard':
        await disposePlan(); active = await activeSnapshot(); break;
      case 'status': active = await activeSnapshot(); break;
      default: throw new Error('Unknown storage action');
    }
    self.postMessage({type:'result',action:data.type,active,exchange,plan:prepared?.summary || null,
      font:await launcherFont().catch(() => 0)});
  } catch (error) {
    await disposePlan().catch(() => {});
    const detail = importErrorInfo(error), response = {type:'error',...detail,cancelled:detail.code === 'cancelled'};
    try { response.active = await activeSnapshot(); } catch { /* Keep the UI's previous known installation. */ }
    self.postMessage(response);
  } finally { controller = null; phase = 'idle'; }
};
