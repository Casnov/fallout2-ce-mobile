"""Reuse Android's import texts, palette and back icon in the web bundle."""
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

RES = Path(__file__).resolve().parents[1] / 'android/app/src/main/res'
ANDROID = '{http://schemas.android.com/apk/res/android}'
TEXTS = '''import_title import_choose_archive import_checking import_found import_language
import_mods import_no_mods import_choose_other import_cancel import_again import_replace
import_back_to_game saves_title saves_found saves_count_same saves_count_likely
saves_count_unlikely saves_count_unknown saves_count_duplicate saves_already_there
saves_change_game saves_change_updated saves_change_added saves_change_removed
saves_add saves_replace_all saves_replace_confirm saves_replace saves_export_first
saves_copying saves_done saves_export_none saves_exporting saves_exported'''.split()


def texts(locale):
    resources = ET.parse(RES / locale / 'strings.xml').getroot()
    values = {e.attrib['name']: ''.join(e.itertext()) for e in resources.findall('string')}
    # Android escapes literal punctuation and newlines in resource strings.
    return {key: re.sub(r'\\(.)', lambda m: {'n': '\n', 't': '\t'}.get(m[1], m[1]), values[key]) for key in TEXTS}


def write_native_assets(output):
    strings = {'en': texts('values'), 'ru': texts('values-ru')}
    (output / 'import-native.js').write_text(
        '// Generated from Android resources by import_ui.py.\n'
        'const strings = ' + json.dumps(strings, ensure_ascii=False, indent=2) + ';\n'
        "const locale = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';\n"
        'export function nativeText(key, ...values) {\n'
        '  let next = 0;\n'
        "  return strings[locale][key].replace(/%(?:(\\d+)\\$)?[sd]/g, (_, index) => String(values[index ? Number(index) - 1 : next++]));\n"
        '}\n')
    colors = {e.attrib['name']: e.text for e in ET.parse(RES / 'values/import_colors.xml').getroot()}
    names = {'background':'background', 'panel':'panel', 'border':'panel_border', 'text':'text',
             'dim':'text_dim', 'accent':'accent', 'warning':'warning', 'button':'button',
             'button-pressed':'button_pressed', 'button-border':'button_border',
             'button-text':'button_text', 'primary':'button_primary', 'primary-text':'button_primary_text'}
    (output / 'import-native.css').write_text('/* Generated from Android import_colors.xml. */\n:root {\n'
        + ''.join('  --' + key + ': ' + colors['import_' + name] + ';\n' for key, name in names.items()) + '}\n')
    vector = ET.parse(RES / 'drawable/import_back.xml').getroot()
    svg = ET.Element('svg', xmlns='http://www.w3.org/2000/svg',
                     viewBox='0 0 ' + vector.attrib[ANDROID + 'viewportWidth'] + ' ' + vector.attrib[ANDROID + 'viewportHeight'])
    for path in vector.findall('path'):
        attrs = {key: path.attrib[ANDROID + source] for key, source in
                 [('d', 'pathData'), ('stroke-width', 'strokeWidth'), ('stroke-linecap', 'strokeLineCap'), ('stroke-linejoin', 'strokeLineJoin')]}
        attrs.update(fill='none', stroke=colors[path.attrib[ANDROID + 'strokeColor'].removeprefix('@color/')])
        ET.SubElement(svg, 'path', attrs)
    (output / 'icons/import-back.svg').write_text(ET.tostring(svg, encoding='unicode') + '\n')
