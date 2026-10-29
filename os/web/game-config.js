// Byte-preserving INI handling: game configs may use an 8-bit game code page.
export const decodeConfig = bytes => Array.from(bytes,byte => String.fromCharCode(byte)).join('');
export const encodeConfig = text => Uint8Array.from(text,character => character.charCodeAt(0));
export function configValue(text,section,key) {
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(), heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) current = heading[1].trim().toLowerCase();
    else if (!/^[;#]/.test(line) && current === section.toLowerCase()) {
      const at = line.indexOf('=');
      if (at >= 0 && line.slice(0,at).trim().toLowerCase() === key.toLowerCase()) return line.slice(at + 1).split(/[;#]/)[0].trim();
    }
  }
  return null;
}
export const CONFIG = 'fallout2.cfg';
// The game's config as the engine finds it: sfall's [Misc] ConfigFile of
// ddraw.ini (a mod's own, as Fallout 1.5: Resurrection's fores.cfg), else
// fallout2.cfg. Android's GameFiles.configName is the same rule.
export function configName(ddraw) {
  const path = (ddraw ? configValue(ddraw,'misc','configfile') || '' : '').replaceAll('\\','/');
  if (!path || path.includes(':') || path.startsWith('/') || path.split('/').includes('..')) return CONFIG;
  return path;
}
export function fixGameConfig(text) {
  const defaults = {master_dat:'master.dat',critter_dat:'critter.dat',master_patches:'data',critter_patches:'data',music_path1:'sound/music/',music_path2:'data/sound/music/'};
  return text.split(/\r?\n/).map(line => {
    const match = /^\s*([^;#=]+?)\s*=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1].toLowerCase(), value = match[2].trim().replaceAll('\\','/');
    if (key in defaults && (value.includes(':') || value.startsWith('/') || value.split('/').includes('..'))) return key + '=' + defaults[key];
    return line;
  }).join('\n');
}
// The game's own settings stay the new game's: [system] (the language and the
// game's files), the music folders, [screen] (the device's, svga.cc) and what
// CE takes from the game's f2_res.ini (game_config_migration.cc): it does that
// at the game's first start, for the keys its config lacks, and only while it
// has no [screen] resolution_x. Fallout 1.5: Resurrection's own fores.dat is
// its f2_res.ini's f2_res_dat. Not the scroll limit around the player: in the
// browser it's the player's.
const F2_RES_UI_KEYS = new Set(['iface_bar_mode','iface_bar_width','iface_bar_side_art','iface_bar_sides_ori',
  'alternate_ammo_meter','ignore_map_edges','splash_screen_size',
  'death_screen_size','end_slide_size','movie_aspect_fit','main_menu_scale_mode']);
export function mergePlayerSettings(template,previous) {
  const settings = new Map(); let section = '';
  const player = (section,key) => section && !['system','screen'].includes(section) && !(section === 'sound' && /^music_path[12]$/.test(key)) && !(section === 'ui' && F2_RES_UI_KEYS.has(key));
  for (const raw of previous.split(/\r?\n/)) {
    const line = raw.trim(), heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) section = heading[1].trim().toLowerCase();
    else {
      const match = /^([^;#=]+?)\s*=(.*)$/.exec(line), key = match?.[1].trim().toLowerCase();
      if (match && player(section,key)) settings.set(section + '\t' + key,match[2]);
    }
  }
  section = '';
  const lines = template.split(/\r?\n/).map(line => {
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { section = heading[1].trim().toLowerCase(); return line; }
    const match = /^\s*([^;#=]+?)\s*=(.*)$/.exec(line), id = section + '\t' + match?.[1].trim().toLowerCase();
    if (!match || !settings.has(id)) return line;
    const value = settings.get(id); settings.delete(id); return line.slice(0,line.indexOf('=') + 1) + value;
  });
  // Repeated INI sections are supported by the engine; append missing player keys.
  for (const [id,value] of settings) { const [section,key] = id.split('\t'); lines.push('[' + section + ']',key + '=' + value); }
  return fixGameConfig(lines.join('\n'));
}
// master.dat and critter.dat may be folders too (CE opens both).
export const originalFile = path => /^(master\.dat|critter\.dat)(\/|$)/i.test(path) || /^patch000\.dat$/i.test(path)
  || /^(data\/)?sound\/music\//i.test(path);
export function describeGame(files,config = '') {
  return {language:configValue(config,'system','language') || 'english',
    mods:files.filter(file => /^mods\/[^/]+\.dat$/i.test(file.path)).map(file => file.path.slice(5,-4)),
    looseLogic:files.some(file => /^(data\/)?(scripts|maps|proto)\//i.test(file.path))};
}
