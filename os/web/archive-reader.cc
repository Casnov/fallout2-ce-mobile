// Maintained libarchive ZIP decoder; sequential callbacks, no central directory
// tree, no mounted full archive or per-entry payload allocation in wasm32.
#include <archive.h>
#include <archive_entry.h>
#include <emscripten.h>
#include <cstdint>
#include <string>
#include <vector>
#include <clocale>
#include "save_composition.h"

static archive* input;
static archive_entry* entry;
static unsigned char buffer[256 * 1024];
static std::string changes;
EM_ASYNC_JS(int, readInput, (unsigned char* target, int capacity), {
    try {
        const bytes = await Module['input'](capacity);
        HEAPU8.set(bytes,target); return bytes.length;
    } catch (error) { Module['inputError'] = error; return -1; }
});
static la_ssize_t readCallback(archive*, void*, const void** data)
{
    *data = buffer;
    return readInput(buffer, sizeof(buffer));
}
extern "C" {
EMSCRIPTEN_KEEPALIVE int zip_open()
{
    input = archive_read_new();
    if (!input) return -1;
    archive_read_support_format_zip_streamable(input);
    std::setlocale(LC_ALL,"C.UTF-8");
    // Path policy/CP866 and Unicode-extra decoding use the bounded local ZIP
    // record in JS. No dependence on the WASM libc's optional iconv tables.
    return archive_read_open(input, nullptr, nullptr, readCallback, nullptr);
}
EMSCRIPTEN_KEEPALIVE int zip_next()
{
    int result = archive_read_next_header(input, &entry);
    return result == ARCHIVE_EOF ? 0 : result == ARCHIVE_OK ? 1 : -1;
}
EMSCRIPTEN_KEEPALIVE const char* zip_name() { return archive_entry_pathname_utf8(entry); }
EMSCRIPTEN_KEEPALIVE double zip_size() { return archive_entry_size_is_set(entry) ? static_cast<double>(archive_entry_size(entry)) : -1; }
EMSCRIPTEN_KEEPALIVE int zip_type() { return archive_entry_filetype(entry); }
EMSCRIPTEN_KEEPALIVE int zip_encrypted() { return archive_entry_is_encrypted(entry); }
EMSCRIPTEN_KEEPALIVE int zip_link() { return archive_entry_symlink(entry) != nullptr || archive_entry_hardlink(entry) != nullptr; }
EMSCRIPTEN_KEEPALIVE double zip_position() { return static_cast<double>(archive_read_header_position(input)); }
EMSCRIPTEN_KEEPALIVE double zip_consumed() { return static_cast<double>(archive_filter_bytes(input, -1)); }
EMSCRIPTEN_KEEPALIVE int zip_read(unsigned char* target, int capacity) { return archive_read_data(input,target,capacity); }
EMSCRIPTEN_KEEPALIVE const char* zip_error() { return archive_error_string(input); }
EMSCRIPTEN_KEEPALIVE int zip_close() { int result = archive_read_free(input); input = nullptr; return result; }
EMSCRIPTEN_KEEPALIVE int save_compare(const char* made, const char* now)
{
    std::vector<fallout::SaveCompatibilityChange> list;
    auto level = fallout::saveCompositionCompare(made,now,&list);
    changes.clear();
    for (const auto& change : list) changes += std::to_string(static_cast<int>(change.kind)) + "\t" + change.name + "\n";
    return static_cast<int>(level);
}
EMSCRIPTEN_KEEPALIVE const char* save_changes() { return changes.c_str(); }
}
