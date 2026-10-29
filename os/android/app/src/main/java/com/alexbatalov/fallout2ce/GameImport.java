package com.alexbatalov.fallout2ce;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

// The game's files from the player's own copy of Fallout 2, a folder or an
// archive of it (.zip, .7z, .rar, .tar: NativeArchive) put on the phone,
// copied where the game reads them (the app's files folder). The game is the
// shallowest folder with master.dat and critter.dat (files or folders), at
// any depth. Mods (RPU...) and saves in it come along. A mod in its subfolder
// whose config names Fallout 2's files outside it (Fallout Et Tu, Fallout
// 1.5: Resurrection) is a game too, the player chooses (`findLinked`). The
// config is the one ddraw.ini names (`GameFiles.configName`), as for CE on
// a computer. docs/android-touch-notes.md "Game layouts".
final class GameImport {
    // An earlier version's mark of a game copied in part (copies go through
    // GameFiles' staging folder now): such a game isn't started.
    private static final String INCOMPLETE_MARK = ".import-incomplete";

    private GameImport() {
    }

    // With a replacement not finished (GameFiles' journal) it isn't: the
    // caller finishes it first (GameFiles.finish).
    static boolean isInstalled(File target) {
        // Either may be a folder (CE opens both).
        return target != null
            && new File(target, "master.dat").exists()
            && new File(target, "critter.dat").exists()
            && !new File(target, INCOMPLETE_MARK).exists()
            && !GameFiles.isCommitPending(target);
    }

    // A file of the chosen folder or archive, [path] with "/" from its root.
    static final class Entry {
        final String path;
        final long size;
        final Object handle;
        // Encrypted, or compressed in a way that can't be read (archives).
        final boolean encrypted;
        final boolean unsupported;

        Entry(String path, long size, Object handle, boolean encrypted, boolean unsupported) {
            this.path = path;
            this.size = size;
            this.handle = handle;
            this.encrypted = encrypted;
            this.unsupported = unsupported;
        }
    }

    // Gets the data of the entries read, one entry after another.
    interface EntrySink {
        void begin(Entry entry) throws IOException;

        void data(byte[] buffer, int length) throws IOException;

        void end(Entry entry) throws IOException;
    }

    abstract static class Source implements Closeable {
        abstract List<Entry> list() throws IOException;

        // Gives [wanted] (from `list`) to [sink], in the source's own order.
        abstract void read(List<Entry> wanted, EntrySink sink) throws IOException;

        @Override
        public void close() throws IOException {
        }
    }

    // A folder chosen through the system's picker (`ACTION_OPEN_DOCUMENT_TREE`).
    static final class FolderSource extends Source {
        private final ContentResolver resolver;
        private final Uri tree;

        FolderSource(ContentResolver resolver, Uri tree) {
            this.resolver = resolver;
            this.tree = tree;
        }

        @Override
        List<Entry> list() throws IOException {
            List<Entry> entries = new ArrayList<>();
            listChildren(DocumentsContract.getTreeDocumentId(tree), "", entries);
            return entries;
        }

        // One query per folder (the DocumentFile helpers ask per property).
        private void listChildren(String documentId, String prefix, List<Entry> entries) throws IOException {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId);
            String[] projection = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
            };

            List<String[]> folders = new ArrayList<>();
            try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
                if (cursor == null) {
                    throw new IOException("can't list " + prefix);
                }
                while (cursor.moveToNext()) {
                    String id = cursor.getString(0);
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    long size = cursor.isNull(3) ? 0 : cursor.getLong(3);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        folders.add(new String[] { id, prefix + name + "/" });
                    } else {
                        entries.add(new Entry(prefix + name, size, id, false, false));
                    }
                }
            }

            for (String[] folder : folders) {
                listChildren(folder[0], folder[1], entries);
            }
        }

        @Override
        void read(List<Entry> wanted, EntrySink sink) throws IOException {
            byte[] buffer = new byte[256 * 1024];
            for (Entry entry : wanted) {
                Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, (String) entry.handle);
                try (InputStream stream = resolver.openInputStream(uri)) {
                    if (stream == null) {
                        throw new IOException("can't read " + entry.path);
                    }
                    sink.begin(entry);
                    int read;
                    while ((read = stream.read(buffer)) > 0) {
                        sink.data(buffer, read);
                    }
                    sink.end(entry);
                }
            }
        }
    }

    // An archive chosen through the system's picker (`ACTION_OPEN_DOCUMENT`),
    // read in place through its descriptor. Opening it lists it (some kinds
    // are read through for that: [progress], which may cancel).
    static final class ArchiveSource extends Source {
        private final ParcelFileDescriptor descriptor;
        private final NativeArchive archive;
        private final List<Entry> entries = new ArrayList<>();

        ArchiveSource(ContentResolver resolver, Uri uri, NativeArchive.Progress progress) throws IOException {
            ParcelFileDescriptor opened;
            try {
                opened = resolver.openFileDescriptor(uri, "r");
            } catch (SecurityException e) {
                throw new IOException(e.getMessage(), e);
            }
            if (opened == null) {
                throw new IOException("can't open the archive");
            }
            descriptor = opened;

            try {
                archive = NativeArchive.open(descriptor, progress);
            } catch (IOException | RuntimeException e) {
                descriptor.close();
                throw e;
            }

            for (int index = 0; index < archive.paths.length; index++) {
                int flags = archive.flags[index];
                entries.add(new Entry(archive.paths[index], archive.sizes[index], index, (flags & 1) != 0, (flags & 2) != 0));
            }
        }

        @Override
        List<Entry> list() {
            return entries;
        }

        @Override
        void read(List<Entry> wanted, EntrySink sink) throws IOException {
            int[] indices = new int[wanted.size()];
            for (int position = 0; position < indices.length; position++) {
                indices[position] = (Integer) wanted.get(position).handle;
            }
            archive.read(indices, new NativeArchive.Sink() {
                @Override
                public void begin(int index) throws IOException {
                    sink.begin(entries.get(index));
                }

                @Override
                public void data(byte[] buffer, int length) throws IOException {
                    sink.data(buffer, length);
                }

                @Override
                public void end(int index) throws IOException {
                    sink.end(entries.get(index));
                }
            });
        }

        @Override
        public void close() throws IOException {
            archive.close();
            descriptor.close();
        }
    }

    // What was found: the game's folder in the source, what is copied.
    static final class Found {
        // "" or ending with "/".
        String root;
        final List<Entry> files = new ArrayList<>();
        long size;
        String language;
        final List<String> mods = new ArrayList<>();
        int saves;
        // Without Fallout 2's own files (master.dat, critter.dat): its mods
        // and configs only, for "Replace game" (the original files stay).
        boolean modsOnly;
        // Its config's name (`GameFiles.configName`).
        String config = GameFiles.CONFIG;
        // Files from outside the folder its config names (a mod installed
        // in a subfolder, as Fallout Et Tu: "..\master.dat"), and their
        // paths in the game.
        final Map<Entry, String> outside = new HashMap<>();

        // [entry]'s path in the game's folder.
        String pathOf(Entry entry) {
            String path = outside.get(entry);
            return path != null ? path : entry.path.substring(root.length());
        }
    }

    // More than one game at the same depth: which one is meant isn't known.
    static final class SeveralGamesException extends IOException {
        final List<String> roots;

        SeveralGamesException(List<String> roots) {
            super("several games: " + roots);
            this.roots = roots;
        }
    }

    // Fallout 2 with a mod in its subfolder that uses its files (as Fallout
    // Et Tu): which of them is meant isn't known. [roots]: Fallout 2's
    // folder first, then the mods'.
    static final class ChooseGameException extends IOException {
        final List<String> roots;

        ChooseGameException(List<String> roots) {
            super("choose a game: " + roots);
            this.roots = roots;
        }
    }

    static Found find(Source source, boolean modsOnly) throws IOException {
        return find(source, modsOnly, null);
    }

    // Null without the game. Its files encrypted or compressed in a way that
    // can't be read: NativeArchive.Failure. [modsOnly]: a game without
    // Fallout 2's own files is found too (for "Replace game"). [chosen]: the
    // root of ChooseGameException the player chose, else null.
    static Found find(Source source, boolean modsOnly, String chosen) throws IOException {
        List<Entry> entries = source.list();

        Layout layout = new Layout(entries);

        // The game's folder: the shallowest with master.dat and critter.dat,
        // files or folders.
        List<String> roots = new ArrayList<>();
        for (String folder : layout.folders) {
            if (layout.has(folder + "master.dat") && layout.has(folder + "critter.dat")) {
                roots.add(folder);
            }
        }
        boolean withoutOriginals = false;
        if (roots.isEmpty() && modsOnly) {
            // Mods only: the shallowest folder with the game's config,
            // sfall's or the mods' folder.
            for (Entry entry : entries) {
                String name = baseName(entry.path);
                String lower = entry.path.toLowerCase(Locale.ROOT);
                int mods = ("/" + lower).indexOf("/mods/");
                if (name.equalsIgnoreCase("fallout2.cfg") || name.equalsIgnoreCase("ddraw.ini") || name.equalsIgnoreCase("sfall.dat")) {
                    roots.add(entry.path.substring(0, entry.path.length() - name.length()));
                } else if (mods != -1) {
                    roots.add(entry.path.substring(0, mods));
                }
            }
            withoutOriginals = true;
        }
        roots = shallowest(roots);
        if (roots.isEmpty()) {
            return null;
        }
        if (roots.size() > 1) {
            throw new SeveralGamesException(roots);
        }

        // Mods in subfolders of the game that use its files.
        Map<String, Map<Entry, String>> linked = withoutOriginals ? new HashMap<>() : findLinked(source, layout, roots.get(0));

        Found found = new Found();
        found.root = roots.get(0);
        if (chosen != null && linked.containsKey(chosen)) {
            found.root = chosen;
            found.outside.putAll(linked.get(chosen));
        } else if (chosen == null && !linked.isEmpty()) {
            List<String> choice = new ArrayList<>();
            choice.add(found.root);
            choice.addAll(linked.keySet());
            Collections.sort(choice.subList(1, choice.size()));
            throw new ChooseGameException(choice);
        }
        found.modsOnly = withoutOriginals;
        for (Entry entry : found.outside.keySet()) {
            found.files.add(entry);
            found.size += entry.size;
        }
        for (Entry entry : entries) {
            if (!entry.path.startsWith(found.root) || isInLinked(entry.path, found.root, linked.keySet()) || found.outside.containsKey(entry)) {
                continue;
            }
            String path = entry.path.substring(found.root.length());
            if (isSkipped(path)) {
                continue;
            }
            if (entry.encrypted) {
                throw new NativeArchive.Failure(NativeArchive.ENCRYPTED, path);
            }
            if (entry.unsupported) {
                throw new NativeArchive.Failure(NativeArchive.UNSUPPORTED, path);
            }
            found.files.add(entry);
            found.size += entry.size;

            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.startsWith("mods/") && lower.endsWith(".dat") && lower.indexOf('/', 5) == -1) {
                found.mods.add(path.substring(5, path.length() - 4));
            } else if (lower.startsWith("data/savegame/slot") && lower.endsWith("/save.dat")) {
                found.saves++;
            }
        }

        found.config = configName(source, layout, found.root);
        found.language = readLanguage(source, found);
        return found;
    }

    // The source's files by their lower case paths, and its folders ("" and
    // ending with "/"), for the game's files that may be folders.
    private static final class Layout {
        final List<Entry> entries;
        final Map<String, Entry> files = new HashMap<>();
        final Set<String> folders = new LinkedHashSet<>();
        private final Set<String> lowerFolders = new HashSet<>();

        Layout(List<Entry> entries) {
            this.entries = entries;
            folders.add("");
            for (Entry entry : entries) {
                files.put(entry.path.toLowerCase(Locale.ROOT), entry);
                int slash = entry.path.indexOf('/');
                while (slash != -1) {
                    String folder = entry.path.substring(0, slash + 1);
                    folders.add(folder);
                    lowerFolders.add(folder.toLowerCase(Locale.ROOT));
                    slash = entry.path.indexOf('/', slash + 1);
                }
            }
        }

        // [path] is a file or a folder of the source.
        boolean has(String path) {
            String lower = path.toLowerCase(Locale.ROOT);
            return files.containsKey(lower) || lowerFolders.contains(lower + "/");
        }

        Entry file(String path) {
            return files.get(path.toLowerCase(Locale.ROOT));
        }

        // The files at [path]: the file, or all in the folder, with their
        // paths from it ("" for the file itself).
        Map<Entry, String> filesAt(String path) {
            Map<Entry, String> found = new LinkedHashMap<>();
            Entry file = file(path);
            if (file != null) {
                found.put(file, "");
                return found;
            }
            String prefix = path.toLowerCase(Locale.ROOT) + "/";
            for (Entry entry : entries) {
                if (entry.path.toLowerCase(Locale.ROOT).startsWith(prefix)) {
                    found.put(entry, entry.path.substring(prefix.length()));
                }
            }
            return found;
        }
    }

    // `GameFiles.configName` of [folder]'s ddraw.ini in the source.
    private static String configName(Source source, Layout layout, String folder) throws IOException {
        Entry ddraw = layout.file(folder + GameFiles.SFALL_CONFIG);
        return GameFiles.configName(ddraw != null ? readText(source, ddraw) : null);
    }

    // Folders under [root] with a config (`configName`) that names master.dat
    // and critter.dat outside them, both in the source: the files to take
    // from outside, by folder, with their paths in the game. The music
    // folders the config names outside come along too (Fallout 1.5:
    // Resurrection keeps its own in Fallout 2's sound\music), at the paths
    // `fixConfig` gives them; the mod's own files win.
    private static Map<String, Map<Entry, String>> findLinked(Source source, Layout layout, String root) throws IOException {
        Map<String, Map<Entry, String>> linked = new HashMap<>();
        for (String folder : layout.folders) {
            if (folder.equals(root) || !folder.startsWith(root)) {
                continue;
            }
            Entry configEntry = layout.file(folder + configName(source, layout, folder));
            if (configEntry == null) {
                continue;
            }

            Map<String, String> config = readConfig(source, configEntry);
            Map<Entry, String> outside = new LinkedHashMap<>();
            boolean dats = true;
            for (String[] file : new String[][] { { "master_dat", "master.dat" }, { "critter_dat", "critter.dat" } }) {
                String path = config.get(file[0]) != null ? resolve(folder, config.get(file[0])) : null;
                if (path == null || path.toLowerCase(Locale.ROOT).startsWith(folder.toLowerCase(Locale.ROOT)) || !layout.has(path)) {
                    dats = false;
                    break;
                }
                for (Map.Entry<Entry, String> found : layout.filesAt(path).entrySet()) {
                    outside.put(found.getKey(), found.getValue().isEmpty() ? file[1] : file[1] + "/" + found.getValue());
                }
            }
            if (!dats) {
                continue;
            }

            Set<String> own = new HashSet<>();
            for (Entry entry : layout.entries) {
                if (entry.path.startsWith(folder)) {
                    own.add(entry.path.substring(folder.length()).toLowerCase(Locale.ROOT));
                }
            }
            for (String[] music : new String[][] { { "music_path1", "sound/music/" }, { "music_path2", "data/sound/music/" } }) {
                String path = config.get(music[0]) != null ? resolve(folder, config.get(music[0])) : null;
                if (path == null || path.isEmpty() || path.toLowerCase(Locale.ROOT).startsWith(folder.toLowerCase(Locale.ROOT))) {
                    continue;
                }
                for (Map.Entry<Entry, String> found : layout.filesAt(path).entrySet()) {
                    String target = music[1] + found.getValue();
                    if (!found.getValue().isEmpty() && !outside.containsKey(found.getKey()) && !own.contains(target.toLowerCase(Locale.ROOT))) {
                        outside.put(found.getKey(), target);
                    }
                }
            }
            linked.put(folder, outside);
        }
        return linked;
    }

    // [path] is in a mod's folder of [linked] under [root] (Fallout 2's own
    // files don't take a mod that uses them).
    private static boolean isInLinked(String path, String root, Set<String> linked) {
        for (String folder : linked) {
            if (!folder.equals(root) && root.length() < folder.length() && path.startsWith(folder)) {
                return true;
            }
        }
        return false;
    }

    // [value], a config's relative path, from [folder] of the source; null
    // for a full path or one out of the source.
    private static String resolve(String folder, String value) {
        String path = value.trim().replace('\\', '/');
        if (path.isEmpty() || path.contains(":") || path.startsWith("/")) {
            return null;
        }
        List<String> parts = new ArrayList<>(Arrays.asList(folder.split("/")));
        parts.removeIf(String::isEmpty);
        for (String part : path.split("/")) {
            if (part.equals("..")) {
                if (parts.isEmpty()) {
                    return null;
                }
                parts.remove(parts.size() - 1);
            } else if (!part.isEmpty() && !part.equals(".")) {
                parts.add(part);
            }
        }
        return String.join("/", parts);
    }

    // The least deep of [folders], each once.
    private static List<String> shallowest(List<String> folders) {
        List<String> result = new ArrayList<>();
        int least = Integer.MAX_VALUE;
        for (String folder : folders) {
            int depth = depth(folder);
            if (depth < least) {
                least = depth;
                result.clear();
            }
            if (depth == least && !result.contains(folder)) {
                result.add(folder);
            }
        }
        return result;
    }

    private static int depth(String folder) {
        int depth = 0;
        for (int index = 0; index < folder.length(); index++) {
            if (folder.charAt(index) == '/') {
                depth++;
            }
        }
        return depth;
    }

    // Files of the computer's game nobody needs on the phone: Windows
    // programs and libraries, shortcuts, folder icons, macOS leftovers and
    // programs (CE's .app); and the engine's ce.dat (the app brings its own,
    // see MainActivity).
    private static boolean isSkipped(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        String name = baseName(lower);
        return lower.equals("ce.dat")
            || lower.startsWith("ce.dat/")
            || lower.startsWith("__macosx/")
            || ("/" + lower).contains(".app/")
            || name.startsWith("._")
            || name.equals(".ds_store")
            || name.equals("thumbs.db")
            || name.equals("desktop.ini")
            || name.endsWith(".exe")
            || name.endsWith(".dll")
            || name.endsWith(".lnk");
    }

    private static String baseName(String path) {
        int slash = path.lastIndexOf('/');
        return slash == -1 ? path : path.substring(slash + 1);
    }

    // `[system] language` of the copied fallout2.cfg ("english" without it).
    private static String readLanguage(Source source, Found found) throws IOException {
        for (Entry entry : found.files) {
            if (found.pathOf(entry).equalsIgnoreCase(found.config)) {
                String language = readConfig(source, entry).get("language");
                return language != null ? language : "english";
            }
        }
        return "english";
    }

    // [entry]'s keys (lower case) and values, a config's.
    private static Map<String, String> readConfig(Source source, Entry entry) throws IOException {
        Map<String, String> values = new HashMap<>();
        for (String line : readText(source, entry).split("\r?\n")) {
            int equals = line.indexOf('=');
            if (equals != -1) {
                values.put(line.substring(0, equals).trim().toLowerCase(Locale.ROOT), line.substring(equals + 1).trim());
            }
        }
        return values;
    }

    // [entry]'s text, a config's (up to a megabyte).
    private static String readText(Source source, Entry entry) throws IOException {
        ByteArrayOutputStream text = new ByteArrayOutputStream();
        source.read(Collections.singletonList(entry), new EntrySink() {
            @Override
            public void begin(Entry entry) {
            }

            @Override
            public void data(byte[] buffer, int length) {
                // A config, not a megabyte.
                if (text.size() < 1024 * 1024) {
                    text.write(buffer, 0, length);
                }
            }

            @Override
            public void end(Entry entry) {
            }
        });
        return new String(text.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    interface Progress {
        void update(long copied, long total, String path);

        boolean isCancelled();
    }

    static final class CancelledException extends IOException {
        CancelledException() {
            super("cancelled");
        }
    }

    // What putting [found] into the game's folder [target] does
    // (GameFiles.plan). [withSaves]: the source's saves come along (the
    // first install); else the installed ones are left as they are.
    static GameFiles.Plan plan(Found found, File target, boolean withSaves) {
        List<String> paths = new ArrayList<>();
        List<Long> sizes = new ArrayList<>();
        for (Entry entry : wanted(found, withSaves)) {
            paths.add(found.pathOf(entry));
            sizes.add(entry.size);
        }
        return GameFiles.plan(paths, sizes, target, GameFiles.installedGameFiles(target), found.modsOnly);
    }

    private static List<Entry> wanted(Found found, boolean withSaves) {
        List<Entry> wanted = new ArrayList<>();
        for (Entry entry : found.files) {
            String path = found.pathOf(entry).toLowerCase(Locale.ROOT);
            if (withSaves || !path.startsWith("data/savegame/")) {
                wanted.add(entry);
            }
        }
        return wanted;
    }

    // Puts [found] into the game's folder [target] as [plan] says: copied
    // next to the game first, then moved in (GameFiles). On failure or
    // cancel the game is as it was and the exception is thrown.
    static void install(Source source, Found found, GameFiles.Plan plan, boolean withSaves, File target, Progress progress) throws IOException {
        if (!target.isDirectory() && !target.mkdirs()) {
            throw new IOException("can't make " + target);
        }
        // An earlier import's leftovers: finished, or its copies removed.
        GameFiles.finish(target);

        Map<String, String> installed = GameFiles.installedGameFiles(target);
        List<Entry> wanted = wanted(found, withSaves);
        Map<Entry, String> pathOf = new HashMap<>();
        for (Entry entry : wanted) {
            pathOf.put(entry, found.pathOf(entry));
        }

        GameFiles.StagingSink sink = new GameFiles.StagingSink(target, installed, pathOf, plan.bytesToRead, (done, total, path) -> {
            if (progress.isCancelled()) {
                throw new CancelledException();
            }
            progress.update(done, total, path);
        });
        try {
            source.read(wanted, sink);
        } catch (IOException | RuntimeException e) {
            sink.abandon();
            GameFiles.deleteRecursively(new File(target, GameFiles.STAGING));
            throw e;
        }

        GameFiles.commit(target, sink.staged, plan.removed, installed);
        // An earlier version's mark of a copy left in part.
        //noinspection ResultOfMethodCallIgnored
        new File(target, INCOMPLETE_MARK).delete();
    }

    // The source's path inside [target], never outside it ("../" in an
    // archive).
    static File targetFile(File target, String path) throws IOException {
        File file = new File(target, path);
        String root = target.getCanonicalPath() + File.separator;
        if (!file.getCanonicalPath().startsWith(root)) {
            throw new IOException("bad path " + path);
        }
        return file;
    }

    // A computer's config may name the game's files and music with full
    // Windows paths ("C:\Games\Fallout 2\master.dat") or outside the game's
    // folder ("..\master.dat"): the copied ones are in it. The music is
    // looked for in both folders the games keep it in (as the web version's
    // fixGameConfig).
    static void fixConfig(File config) throws IOException {
        if (!config.isFile()) {
            return;
        }

        Map<String, String> defaults = new HashMap<>();
        defaults.put("master_dat", "master.dat");
        defaults.put("critter_dat", "critter.dat");
        defaults.put("master_patches", "data");
        defaults.put("critter_patches", "data");
        defaults.put("music_path1", "sound/music/");
        defaults.put("music_path2", "data/sound/music/");

        String text = new String(readFile(config), StandardCharsets.ISO_8859_1);
        String newline = text.contains("\r\n") ? "\r\n" : "\n";
        String[] lines = text.split("\r?\n", -1);
        boolean changed = false;
        for (int index = 0; index < lines.length; index++) {
            int equals = lines[index].indexOf('=');
            if (equals == -1) {
                continue;
            }
            String key = lines[index].substring(0, equals).trim().toLowerCase(Locale.ROOT);
            String value = lines[index].substring(equals + 1).trim().replace('\\', '/');
            if (defaults.containsKey(key) && (value.contains(":") || value.startsWith("/") || Arrays.asList(value.split("/")).contains(".."))) {
                lines[index] = key + "=" + defaults.get(key);
                changed = true;
            }
        }

        if (changed) {
            writeFile(config, String.join(newline, lines).getBytes(StandardCharsets.ISO_8859_1));
        }
    }

    private static byte[] readFile(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    private static void writeFile(File file, byte[] data) throws IOException {
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }
}
