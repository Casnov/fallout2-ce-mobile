package com.alexbatalov.fallout2ce;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import org.junit.Test;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;

// The import on real games (archives and folders, out/dev/realgames.sh):
// each installed as the first install, every game replaced by every other
// (the plan: the result must be the other game's first install), and a
// chain of real replacements, each compared with the first install of the
// game it ends with. Skipped without FALLOUT_REAL_GAMES: a list of
// "name<TAB>path<TAB>chosen root (a mod in Fallout 2's subfolder) or empty".
// FALLOUT_REAL_OUT: where the games go (fresh/<name>, plans/<name>.txt with
// each file's path and size, for the web's check).
public class RealGamesTest {
    private static final class Game {
        String name;
        File path;
        String chosen;
        GameImport.Found found;
        File fresh;
    }

    // An archive read with java.util.zip (the phone's NativeArchive is native).
    static final class ZipSource extends GameImport.Source {
        private final ZipFile zip;

        ZipSource(File file) throws IOException {
            ZipFile opened;
            try {
                opened = new ZipFile(file, StandardCharsets.UTF_8);
                for (Enumeration<? extends ZipEntry> entries = opened.entries(); entries.hasMoreElements();) {
                    entries.nextElement();
                }
            } catch (IllegalArgumentException | ZipException e) {
                opened = new ZipFile(file, Charset.forName("Cp437"));
            }
            zip = opened;
        }

        @Override
        List<GameImport.Entry> list() {
            List<GameImport.Entry> entries = new ArrayList<>();
            for (Enumeration<? extends ZipEntry> all = zip.entries(); all.hasMoreElements();) {
                ZipEntry entry = all.nextElement();
                if (!entry.isDirectory()) {
                    entries.add(new GameImport.Entry(entry.getName().replace('\\', '/'), entry.getSize(), entry, false, false));
                }
            }
            return entries;
        }

        @Override
        void read(List<GameImport.Entry> wanted, GameImport.EntrySink sink) throws IOException {
            byte[] buffer = new byte[1 << 20];
            for (GameImport.Entry entry : wanted) {
                sink.begin(entry);
                try (InputStream in = zip.getInputStream((ZipEntry) entry.handle)) {
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        sink.data(buffer, read);
                    }
                }
                sink.end(entry);
            }
        }

        @Override
        public void close() throws IOException {
            zip.close();
        }
    }

    // A folder on this computer.
    static final class FolderSource extends GameImport.Source {
        private final File root;

        FolderSource(File root) {
            this.root = root;
        }

        @Override
        List<GameImport.Entry> list() {
            List<GameImport.Entry> entries = new ArrayList<>();
            walk(root, "", entries);
            return entries;
        }

        private void walk(File folder, String prefix, List<GameImport.Entry> entries) {
            File[] children = folder.listFiles();
            if (children == null) {
                return;
            }
            for (File child : children) {
                if (Files.isSymbolicLink(child.toPath())) {
                    continue;
                }
                if (child.isDirectory()) {
                    walk(child, prefix + child.getName() + "/", entries);
                } else {
                    entries.add(new GameImport.Entry(prefix + child.getName(), child.length(), child, false, false));
                }
            }
        }

        @Override
        void read(List<GameImport.Entry> wanted, GameImport.EntrySink sink) throws IOException {
            byte[] buffer = new byte[1 << 20];
            for (GameImport.Entry entry : wanted) {
                sink.begin(entry);
                try (InputStream in = Files.newInputStream(((File) entry.handle).toPath())) {
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        sink.data(buffer, read);
                    }
                }
                sink.end(entry);
            }
        }
    }

    private static final GameImport.Progress NO_PROGRESS = new GameImport.Progress() {
        @Override
        public void update(long copied, long total, String path) {
        }

        @Override
        public boolean isCancelled() {
            return false;
        }
    };

    private static GameImport.Source open(Game game) throws IOException {
        return game.path.isDirectory() ? new FolderSource(game.path) : new ZipSource(game.path);
    }

    private static GameImport.Found find(Game game, GameImport.Source source, boolean replacing) throws IOException {
        try {
            return GameImport.find(source, replacing, game.chosen);
        } catch (GameImport.ChooseGameException e) {
            throw new AssertionError(game.name + ": choose one of " + e.roots + " (the list's third column)");
        }
    }

    @Test
    public void realGames() throws IOException {
        String list = System.getenv("FALLOUT_REAL_GAMES");
        String outPath = System.getenv("FALLOUT_REAL_OUT");
        assumeTrue("FALLOUT_REAL_GAMES isn't set", list != null && outPath != null);
        File out = new File(outPath);
        List<Game> games = new ArrayList<>();
        for (String line : new String(Files.readAllBytes(new File(list).toPath()), StandardCharsets.UTF_8).split("\n")) {
            if (line.trim().isEmpty() || line.startsWith("#")) {
                continue;
            }
            String[] parts = line.split("\t", -1);
            Game game = new Game();
            game.name = parts[0];
            game.path = new File(parts[1]);
            game.chosen = parts.length > 2 && !parts[2].isEmpty() ? parts[2] : null;
            games.add(game);
        }
        List<String> failures = new ArrayList<>();
        File plans = new File(out, "plans");
        plans.mkdirs();

        // The first install of each.
        long started = System.currentTimeMillis();
        for (Game game : games) {
            game.fresh = new File(out, "fresh/" + game.name);
            GameFiles.deleteRecursively(game.fresh);
            game.fresh.mkdirs();
            try (GameImport.Source source = open(game)) {
                game.found = find(game, source, false);
                assertTrue(game.name + ": no game found", game.found != null);
                GameFiles.Plan plan = GameImport.plan(game.found, game.fresh, true);
                GameImport.install(source, game.found, plan, true, game.fresh, NO_PROGRESS);
                try (PrintWriter writer = new PrintWriter(new File(plans, game.name + ".txt"), "UTF-8")) {
                    for (int index = 0; index < plan.paths.size(); index++) {
                        writer.println(plan.paths.get(index) + "\t" + plan.sizes.get(index));
                    }
                }
                check(game.name + " first install", game.fresh, new TreeSet<>(plan.paths), failures);
            }
        }
        System.out.println("first installs: " + games.size() + " in " + (System.currentTimeMillis() - started) + " ms");

        // Every game replaced by every other: the plan's result is the other
        // game's first install.
        started = System.currentTimeMillis();
        int pairs = 0;
        for (Game from : games) {
            Map<String, String> installed = GameFiles.installedGameFiles(from.fresh);
            for (Game to : games) {
                if (to == from) {
                    continue;
                }
                pairs++;
                GameFiles.Plan plan = GameImport.plan(to.found, from.fresh, false);
                Map<String, String> result = new TreeMap<>(installed);
                for (String removed : plan.removed) {
                    result.remove(removed.toLowerCase(Locale.ROOT));
                }
                for (String path : plan.paths) {
                    if (GameFiles.isGameFile(path)) {
                        result.putIfAbsent(path.toLowerCase(Locale.ROOT), path);
                    }
                }
                TreeSet<String> expected = new TreeSet<>(GameFiles.installedGameFiles(to.fresh).keySet());
                String config = GameFiles.configName(to.fresh).toLowerCase(Locale.ROOT);
                if (!expected.contains(config) && installed.containsKey(config)) {
                    // The player's config of that name stays.
                    expected.add(config);
                }
                if (!expected.equals(result.keySet())) {
                    failures.add(from.name + " -> " + to.name + ": " + difference(expected, result.keySet()));
                }
                String folders = caseClashes(result.values());
                if (folders != null) {
                    failures.add(from.name + " -> " + to.name + ": folders in two cases " + folders);
                }
            }
        }
        System.out.println("replacement plans: " + pairs + " in " + (System.currentTimeMillis() - started) + " ms");

        // A chain of real replacements, each game once replaced and once
        // replacing: the files, the player's save and setting.
        started = System.currentTimeMillis();
        File work = new File(out, "work");
        for (int index = 0; index < games.size() && games.size() > 1; index++) {
            Game from = games.get(index);
            Game to = games.get((index + 1) % games.size());
            GameFiles.deleteRecursively(work);
            run("cp", "-cR", from.fresh.getPath(), work.getPath());
            File config = GameFiles.configFile(work);
            if (config.isFile()) {
                GameFiles.writeText(config, GameFiles.readText(config) + "\n[preferences]\nbrightness=1.234567\n");
            }
            File save = new File(GameSaves.savesFolder(work), "SLOT20/SAVE.DAT");
            save.getParentFile().mkdirs();
            GameFiles.writeText(save, "THE PLAYER'S SAVE");

            try (GameImport.Source source = open(to)) {
                GameImport.Found found = find(to, source, true);
                GameImport.install(source, found, GameImport.plan(found, work, false), false, work, NO_PROGRESS);
            }
            String name = from.name + " -> " + to.name + " (copied)";
            Map<String, String> expected = GameFiles.installedGameFiles(to.fresh);
            Map<String, String> result = GameFiles.installedGameFiles(work);
            TreeSet<String> expectedKeys = new TreeSet<>(expected.keySet());
            String configName = GameFiles.configName(to.fresh).toLowerCase(Locale.ROOT);
            if (!expectedKeys.contains(configName) && result.containsKey(configName)) {
                expectedKeys.add(configName);
            }
            if (!expectedKeys.equals(new TreeSet<>(result.keySet()))) {
                failures.add(name + ": " + difference(expectedKeys, result.keySet()));
            }
            for (Map.Entry<String, String> file : expected.entrySet()) {
                String got = result.get(file.getKey());
                if (got != null && !file.getKey().equals(configName)
                    && new File(work, got).length() != new File(to.fresh, file.getValue()).length()) {
                    failures.add(name + ": " + got + " differs in size");
                }
            }
            String folders = caseClashes(result.values());
            if (folders != null) {
                failures.add(name + ": folders in two cases " + folders);
            }
            if (!GameImport.isInstalled(work)) {
                failures.add(name + ": not installed");
            }
            File newSave = new File(GameSaves.savesFolder(work), "SLOT20/SAVE.DAT");
            if (!newSave.isFile() || !GameFiles.readText(newSave).equals("THE PLAYER'S SAVE")) {
                failures.add(name + ": the player's save is gone");
            }
            File newConfig = GameFiles.configFile(work);
            if (config.isFile() && newConfig.isFile() && !GameFiles.readText(newConfig).contains("brightness=1.234567")) {
                failures.add(name + ": the player's setting is gone (" + newConfig.getName() + ")");
            }
        }
        GameFiles.deleteRecursively(work);
        System.out.println("real replacements: " + games.size() + " in " + (System.currentTimeMillis() - started) + " ms");

        for (String failure : failures) {
            System.out.println("FAIL " + failure);
        }
        assertEquals(failures.toString(), 0, failures.size());
    }

    // The first install in [game]: the plan's files, each folder in one
    // case, the game found, its config's paths in the game.
    private static void check(String name, File game, TreeSet<String> planned, List<String> failures) throws IOException {
        Map<String, String> files = GameFiles.installedGameFiles(game);
        TreeSet<String> lower = new TreeSet<>();
        for (String path : planned) {
            if (GameFiles.isGameFile(path)) {
                lower.add(path.toLowerCase(Locale.ROOT));
            }
        }
        if (!lower.equals(files.keySet())) {
            failures.add(name + ": " + difference(lower, files.keySet()));
        }
        String folders = caseClashes(files.values());
        if (folders != null) {
            failures.add(name + ": folders in two cases " + folders);
        }
        if (!GameImport.isInstalled(game)) {
            failures.add(name + ": not installed");
        }
        File config = GameFiles.configFile(game);
        if (config.isFile()) {
            for (String line : GameFiles.readText(config).split("\r?\n")) {
                int equals = line.indexOf('=');
                String key = equals == -1 ? "" : line.substring(0, equals).trim().toLowerCase(Locale.ROOT);
                String value = equals == -1 ? "" : line.substring(equals + 1).trim().replace('\\', '/');
                if ((key.equals("master_dat") || key.equals("critter_dat")) && GameFiles.findIgnoreCase(game, value) == null) {
                    failures.add(name + ": " + config.getName() + " names " + key + "=" + value + ", not in the game");
                }
                if (key.matches("master_dat|critter_dat|master_patches|critter_patches|music_path1|music_path2")
                    && (value.contains(":") || ("/" + value + "/").contains("/../"))) {
                    failures.add(name + ": " + config.getName() + " still has " + key + "=" + value);
                }
            }
        }
    }

    // Two spellings of one folder among [paths], null without.
    private static String caseClashes(Iterable<String> paths) {
        Map<String, String> folders = new HashMap<>();
        for (String path : paths) {
            int slash = path.indexOf('/');
            while (slash != -1) {
                String folder = path.substring(0, slash);
                String known = folders.putIfAbsent(folder.toLowerCase(Locale.ROOT), folder);
                if (known != null && !known.equals(folder)) {
                    return known + " / " + folder;
                }
                slash = path.indexOf('/', slash + 1);
            }
        }
        return null;
    }

    private static String difference(java.util.Set<String> expected, java.util.Set<String> got) {
        List<String> missing = new ArrayList<>();
        List<String> extra = new ArrayList<>();
        for (String path : expected) {
            if (!got.contains(path)) {
                missing.add(path);
            }
        }
        for (String path : got) {
            if (!expected.contains(path)) {
                extra.add(path);
            }
        }
        Collections.sort(missing);
        Collections.sort(extra);
        return "missing " + head(missing) + ", extra " + head(extra);
    }

    private static String head(List<String> paths) {
        return paths.size() <= 5 ? paths.toString() : paths.subList(0, 5) + " and " + (paths.size() - 5) + " more";
    }

    private static void run(String... command) throws IOException {
        try {
            Process process = new ProcessBuilder(command).inheritIO().start();
            if (process.waitFor() != 0) {
                throw new IOException(String.join(" ", command) + " failed");
            }
        } catch (InterruptedException e) {
            throw new IOException(e);
        }
    }
}
