#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <emscripten.h>

#include "platform/web/storage.h"
#include "platform/web/window.h"
#include "save_catalog.h"
#include "save_records.h"
#include "save_storage.h"

using namespace fallout;
namespace disk = fallout::saveStorage;
static std::string read(const std::string& path)
{
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
static std::string save(char value)
{
    std::string data(1024, value);
    data.replace(0, 17, "FALLOUT SAVE FILE");
    return data;
}

EM_ASYNC_JS(int, diskStillOld, (), {
    try { await Module['midWrite']?.(); return 1; }
    catch (error) { console.error(error); return 0; }
});

static int exercise(const std::string& mode)
{
    const std::string root = std::string(kWebUserRoot) + "/savegame";
    SaveRecords records;
    records.configure(webPortDataPath("saves.txt"));
    SaveCatalog catalog;
    bool mass = mode == "mass" || mode == "mass-write" || mode == "mass-check";
    catalog.configure(root, mass ? 1000 : 10, 3, 2, &records);
    if (!catalog.refresh()) return 1;
    if (mass) {
        for (int slot = 0; slot < 1000; slot++) if (!catalog.entry(slot).present || catalog.entry(slot).recordId.empty()) return 90;
        auto byteAt = [&](int slot, int offset) {
            FILE* file = std::fopen(catalog.saveDatPath(slot).c_str(), "rb");
            if (!file || std::fseek(file, offset, SEEK_SET)) return -1;
            int value = std::fgetc(file); std::fclose(file); return value;
        };
        if (byteAt(999, 64 * 1024 * 1024 - 1) != 0) return 91;
        if (mode == "mass-write") {
            FILE* file = std::fopen(catalog.saveDatPath(0).c_str(), "r+b");
            if (!file || std::fseek(file, 20 * 1024 * 1024, SEEK_SET) || std::fputc('Z',file) != 'Z' || std::fclose(file) || !webCommitUserFiles()) return 92;
        } else if (mode == "mass-check") {
            if (byteAt(0,20 * 1024 * 1024) != 'Z' || byteAt(999,20 * 1024 * 1024) != 0) return 93;
        }
        return 0;
    }
    auto write = [&](int slot, char value, bool fail = false) {
        std::string path = catalog.saveDatPath(slot);
        return catalog.write(slot, [&] {
            return disk::writeFile(path, save(value))
                && disk::writeFile(path.substr(0, path.find_last_of('/')) + "/ce.sav", std::string(1, value))
                && (value == 'A' || slot != 0 || diskStillOld())
                && !fail;
        });
    };
    if (mode == "handoff") {
        if (!write(0, 'A') || !webCommitUserFiles()) return 94;
        const std::string retainedSession = "unsaved native session";
        // Warm both content and namespace caches before the external writer.
        if (read(catalog.saveDatPath(0)) != save('A')) return 95;
        if (!webExchangeSaves("saves_export") || read(catalog.saveDatPath(0)) != save('A')) return 96;
        if (!webExchangeSaves("saves_import")) return 97;
        records.reload();
        if (!catalog.refresh() || read(catalog.saveDatPath(0)) != save('Z')) return 98;
        if (retainedSession != "unsaved native session" || !write(1, 'B') || !webCommitUserFiles()) return 99;
    } else if (mode == "openfiles") {
        webOpenGameFiles("saves_export");
    } else if (mode == "exchange") {
        if (catalog.newest() != 0) return 80;
        const std::string path = catalog.saveDatPath(0);
        if (read(path).substr(0, 17) != "FALLOUT SAVE FILE" || read(path).substr(61, 9) != "roundtrip") return 81;
        SaveRecord record;
        if (!records.find(0, saveRecordId(path), &record)) return 82;
        if (record.composition != "mods/rpu.dat=0123:L" || record.created != 123) return 83;
    } else if (mode == "seed") {
        if (!write(0, 'A')) return 2;
        SaveRecord record;
        std::string identity = saveRecordId(catalog.saveDatPath(0));
        if (!records.find(0, identity, &record)) return 3;
        record.composition = "test-RPU";
        if (!records.put(0, identity, record)) return 4;
        if (!disk::writeFile("/game/fallout2.cfg", "[system]\nmaster_patches=data\n[preferences]\nbrightness=1.25\n")) return 5;
        if (!webCommitUserFiles()) return 6;
    } else if (mode == "verify") {
        if (catalog.newest() != 0 || read(catalog.saveDatPath(0)) != save('A')) return 7;
        SaveRecord record;
        if (!records.find(0, saveRecordId(catalog.saveDatPath(0)), &record) || record.composition != "test-RPU") return 8;
        if (read("/game/fallout2.cfg").find("brightness=1.25") == std::string::npos) return 9;
    } else if (mode == "quick") {
        if (catalog.nextQuick() != 3 || !write(3, 'B') || !webCommitUserFiles()) return 10;
        if (catalog.nextQuick() != 4 || !write(4, 'C') || !webCommitUserFiles()) return 11;
        if (catalog.newest() != 4 || catalog.nextQuick() != 3) return 12;
    } else if (mode == "overwrite") {
        if (!write(0, 'D') || !webCommitUserFiles()) return 13;
    } else if (mode == "failure") {
        if (!write(0, 'X') || webCommitUserFiles()) return 14;
        records.reload();
        if (!catalog.refresh() || read(catalog.saveDatPath(0)) != save('A')) return 15;
        // A later settings commit must not leak the failed replacement.
        if (!disk::writeFile("/game/ddraw.ini", "[misc]\nvalue=retry\n") || !webCommitUserFiles()) return 16;
    } else if (mode == "writer-failure") {
        if (write(0, 'X', true) || !webRollbackUserFiles()) return 17;
        records.reload();
        if (!catalog.refresh() || read(catalog.saveDatPath(0)) != save('A')) return 18;
        if (!webCommitUserFiles()) return 19;
    } else if (mode == "records-failure") {
        records.configure(root + "/missing/records.txt");
        if (!write(0, 'X') || records.writesSucceeded()) return 20;
        if (!webRollbackUserFiles()) return 21;
        if (read(catalog.saveDatPath(0)) != save('A')) return 22;
    } else if (mode == "delete") {
        if (!catalog.remove(0) || !webCommitUserFiles()) return 23;
    } else if (mode == "delete-failure") {
        if (!catalog.remove(0) || webCommitUserFiles()) return 24;
        records.reload();
        if (!catalog.refresh() || read(catalog.saveDatPath(0)) != save('A')) return 25;
    } else if (mode == "move") {
        if (!catalog.move(0, 1) || !webCommitUserFiles()) return 26;
    } else if (mode == "range" || mode == "range-failure") {
        if (!catalog.setQuickRange(3, 1)) return 28;
        if (!disk::writeFile("/game/fallout2.cfg", "[system]\nmaster_patches=data\n[ui]\nauto_quick_save=1\n")) return 29;
        bool committed = webCommitUserFiles();
        if (mode == "range") {
            if (!committed) return 30;
        } else {
            if (committed) return 31;
            records.reload(); catalog.configure(root, 10, 3, 2, &records);
            if (!catalog.refresh() || read(catalog.saveDatPath(3)) != save('B') || read(catalog.saveDatPath(4)) != save('C')) return 32;
        }
    } else if (mode == "recovery") {
        if (read(catalog.saveDatPath(0)) != save('A') || !webCommitUserFiles()) return 27;
    }
    return 0;
}

int main(int argc, char** argv)
{
    int result = exercise(argc > 1 ? argv[1] : "verify");
    webExit(result);
    return result;
}
