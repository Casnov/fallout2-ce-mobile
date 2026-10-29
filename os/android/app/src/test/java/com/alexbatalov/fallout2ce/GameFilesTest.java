package com.alexbatalov.fallout2ce;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

// GameImport's finding of the game and GameFiles' putting it into the game's
// folder, on files of a temporary folder.
public class GameFilesTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    // A folder or archive in memory, its data given in [chunk] pieces.
    static final class MemorySource extends GameImport.Source {
        final Map<String, byte[]> files = new LinkedHashMap<>();
        int chunk = 1 << 20;
        // Throws in the middle of reading the file of this name.
        String failOn;

        MemorySource put(String path, String text) {
            files.put(path, text.getBytes(StandardCharsets.ISO_8859_1));
            return this;
        }

        @Override
        List<GameImport.Entry> list() {
            List<GameImport.Entry> entries = new ArrayList<>();
            for (Map.Entry<String, byte[]> file : files.entrySet()) {
                entries.add(new GameImport.Entry(file.getKey(), file.getValue().length, file.getKey(), false, false));
            }
            return entries;
        }

        @Override
        void read(List<GameImport.Entry> wanted, GameImport.EntrySink sink) throws IOException {
            for (GameImport.Entry entry : wanted) {
                byte[] data = files.get(entry.path);
                sink.begin(entry);
                for (int offset = 0; offset < data.length; offset += chunk) {
                    if (entry.path.equals(failOn) && offset > 0) {
                        throw new IOException("broken");
                    }
                    byte[] piece = Arrays.copyOfRange(data, offset, Math.min(data.length, offset + chunk));
                    sink.data(piece, piece.length);
                }
                sink.end(entry);
            }
        }
    }

    static final GameImport.Progress NO_PROGRESS = new GameImport.Progress() {
        @Override
        public void update(long copied, long total, String path) {
        }

        @Override
        public boolean isCancelled() {
            return false;
        }
    };

    private File game;

    private void write(String path, String text) throws IOException {
        File file = new File(game, path);
        file.getParentFile().mkdirs();
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(text.getBytes(StandardCharsets.ISO_8859_1));
        }
    }

    private String read(String path) throws IOException {
        return GameFiles.readText(new File(game, path));
    }

    private boolean exists(String path) {
        return new File(game, path).exists();
    }

    // An installed game: Fallout 2's files, two mods, the player's config,
    // a save, the app's own files.
    private void installGame() throws IOException {
        game = temporary.newFolder("game");
        write("master.dat", "MASTER");
        write("critter.dat", "CRITTER");
        write("sound/music/01.acm", "MUSIC");
        write("mods/rpu.dat", "RPU 1");
        write("mods/old_mod.dat", "OLD");
        write("ddraw.ini", "[Main]\nOld=1\n");
        write("fallout2.cfg", "[system]\nlanguage=russian\n\n[preferences]\ngame_difficulty=2\nbrightness=1.2\n\n[enhancements]\nmain_menu_continue=1\n");
        write("data/SAVEGAME/SLOT01/SAVE.DAT", "SAVE");
        write("ce.dat/font.ttf", "FONT");
        write("actions.log", "LOG");
    }

    private void install(MemorySource source, boolean modsOnly, boolean withSaves) throws IOException {
        GameImport.Found found = GameImport.find(source, modsOnly);
        GameFiles.Plan plan = GameImport.plan(found, game, withSaves);
        GameImport.install(source, found, plan, withSaves, game, NO_PROGRESS);
    }

    @Test
    public void gameFiles() {
        assertTrue(GameFiles.isGameFile("master.dat"));
        assertTrue(GameFiles.isGameFile("mods/rpu.dat"));
        assertTrue(GameFiles.isGameFile("data/proto/items/00000001.pro"));
        assertFalse(GameFiles.isGameFile("data/SAVEGAME/SLOT01/SAVE.DAT"));
        assertFalse(GameFiles.isGameFile("ce.dat/fonts/a.ttf"));
        assertFalse(GameFiles.isGameFile("actions.log"));
        assertFalse(GameFiles.isGameFile("touch.log.old"));
        assertFalse(GameFiles.isGameFile("scr00001.bmp"));
        assertFalse(GameFiles.isGameFile("debug.log"));
        // A game's own log (Resurrection's change log) is its file.
        assertTrue(GameFiles.isGameFile("fores_change.log"));
        assertFalse(GameFiles.isGameFile(".import-staging/master.dat"));
        assertTrue(GameFiles.isOriginalFile("MASTER.DAT"));
        assertTrue(GameFiles.isOriginalFile("sound/music/07desert.acm"));
        assertFalse(GameFiles.isOriginalFile("mods/rpu.dat"));
    }

    @Test
    public void settingsCarryOver() {
        String newConfig = "[system]\r\nlanguage=english\r\nmaster_dat=master.dat\r\n\r\n[preferences]\r\ngame_difficulty=1\r\n\r\n[sound]\r\nmusic_path1=sound\\music\\\r\nmaster_volume=22000\r\n";
        String oldConfig = "[system]\nlanguage=russian\n\n[preferences]\ngame_difficulty=2\nbrightness=1.200000\n\n[sound]\nmusic_path1=old\\music\\\nmaster_volume=10000\n\n[enhancements]\nmain_menu_continue=1\n";
        String merged = GameFiles.mergeSettings(newConfig, oldConfig);
        assertEquals("[system]\r\nlanguage=english\r\nmaster_dat=master.dat\r\n\r\n"
                + "[preferences]\r\ngame_difficulty=2\r\nbrightness=1.200000\r\n\r\n"
                + "[sound]\r\nmusic_path1=sound\\music\\\r\nmaster_volume=10000\r\n"
                + "\r\n[enhancements]\r\nmain_menu_continue=1\r\n",
            merged);
    }

    @Test
    public void theGamesOwnScreenSettingsStay() {
        // Fallout 1.5: Resurrection: fores.cfg has no [screen], its f2_res.ini
        // names fores.dat; CE takes it from there while [screen] is missing.
        String newConfig = "[system]\nmaster_dat=master.dat\n\n[ui]\nauto_quick_save=0\n";
        String oldConfig = "[system]\nf2_res_dat=f2_res.dat\n\n[screen]\nresolution_x=1066\nresolution_y=480\n\n"
            + "[ui]\nauto_quick_save=1\niface_bar_side_art=2\nsplash_screen_size=1\ndisplay_bonus_damage=1\n";
        assertEquals("[system]\nmaster_dat=master.dat\n\n[ui]\nauto_quick_save=1\ndisplay_bonus_damage=1\n",
            GameFiles.mergeSettings(newConfig, oldConfig));
    }

    @Test
    public void computerPathsInTheConfigFixed() throws IOException {
        game = temporary.newFolder("game");
        write("fallout2.cfg", "[sound]\r\nmusic_path1=C:\\Games\\Fallout 2\\data\\sound\\music\\\r\nmusic_path2=..\\data\\sound\\music\\\r\nmusic_volume=22000\r\n\r\n"
            + "[system]\r\nmaster_dat=D:\\master.dat\r\ncritter_dat=..\\critter.dat\r\nmaster_patches=data\r\n");
        GameImport.fixConfig(new File(game, "fallout2.cfg"));
        assertEquals("[sound]\r\nmusic_path1=sound/music/\r\nmusic_path2=data/sound/music/\r\nmusic_volume=22000\r\n\r\n"
            + "[system]\r\nmaster_dat=master.dat\r\ncritter_dat=critter.dat\r\nmaster_patches=data\r\n",
            read("fallout2.cfg"));

        // The game's own relative paths stay as they are.
        String own = "[sound]\nmusic_path1=sound\\music\\\nmusic_path2=data/sound/music/\n";
        write("fallout2.cfg", own);
        GameImport.fixConfig(new File(game, "fallout2.cfg"));
        assertEquals(own, read("fallout2.cfg"));
    }

    @Test
    public void findsTheGameAtAnyDepth() throws IOException {
        MemorySource source = new MemorySource()
            .put("Игры/Fallout 2/master.dat", "M")
            .put("Игры/Fallout 2/critter.dat", "C")
            .put("Игры/Fallout 2/backup/master.dat", "M")
            .put("Игры/Fallout 2/backup/critter.dat", "C")
            .put("Игры/Fallout 2/Fallout II Community Edition.app/Contents/MacOS/x", "X")
            .put("Игры/Fallout 2/fallout2.exe", "X")
            .put("Игры/Fallout 2/data/._x", "X")
            .put("__MACOSX/Игры/._Fallout 2", "X");
        GameImport.Found found = GameImport.find(source, false);
        assertEquals("Игры/Fallout 2/", found.root);
        List<String> paths = new ArrayList<>();
        for (GameImport.Entry entry : found.files) {
            paths.add(entry.path.substring(found.root.length()));
        }
        assertEquals(Arrays.asList("master.dat", "critter.dat", "backup/master.dat", "backup/critter.dat"), paths);
        assertFalse(found.modsOnly);
    }

    @Test
    public void severalGamesAtOneDepth() throws IOException {
        MemorySource source = new MemorySource()
            .put("a/master.dat", "M").put("a/critter.dat", "C")
            .put("b/master.dat", "M").put("b/critter.dat", "C");
        try {
            GameImport.find(source, false);
            fail();
        } catch (GameImport.SeveralGamesException e) {
            assertEquals(Arrays.asList("a/", "b/"), e.roots);
        }
    }

    @Test
    public void modsOnlyIsFoundOnlyForReplacing() throws IOException {
        MemorySource source = new MemorySource()
            .put("build/mods/rpu.dat", "R")
            .put("build/ddraw.ini", "D");
        assertNull(GameImport.find(source, false));
        GameImport.Found found = GameImport.find(source, true);
        assertEquals("build/", found.root);
        assertTrue(found.modsOnly);
    }

    @Test
    public void firstInstall() throws IOException {
        game = new File(temporary.getRoot(), "game");
        MemorySource source = new MemorySource()
            .put("Fallout 2/master.dat", "MASTER")
            .put("Fallout 2/critter.dat", "CRITTER")
            .put("Fallout 2/fallout2.cfg", "[system]\nmaster_dat=C:\\Games\\Fallout 2\\master.dat\n")
            .put("Fallout 2/data/SAVEGAME/SLOT01/SAVE.DAT", "SAVE");
        install(source, false, true);

        assertTrue(GameImport.isInstalled(game));
        assertEquals("MASTER", read("master.dat"));
        assertEquals("SAVE", read("data/SAVEGAME/SLOT01/SAVE.DAT"));
        // A computer's path fixed.
        assertEquals("[system]\nmaster_dat=master.dat\n", read("fallout2.cfg"));
        assertFalse(exists(GameFiles.STAGING));
        assertFalse(exists(GameFiles.JOURNAL));
    }

    @Test
    public void replaceTheMods() throws IOException {
        installGame();
        long masterTime = new File(game, "master.dat").lastModified();
        MemorySource source = new MemorySource()
            .put("build/mods/rpu.dat", "RPU 2")
            .put("build/mods/new_mod.dat", "NEW")
            .put("build/ddraw.ini", "[Main]\nNew=1\n")
            .put("build/fallout2.cfg", "[system]\nlanguage=english\n\n[preferences]\ngame_difficulty=1\n")
            .put("build/data/SAVEGAME/SLOT09/SAVE.DAT", "OTHER SAVE");
        GameImport.Found found = GameImport.find(source, true);
        GameFiles.Plan plan = GameImport.plan(found, game, false);
        assertEquals(Arrays.asList("new_mod"), plan.modsAdded);
        assertEquals(Arrays.asList("old_mod"), plan.modsRemoved);
        GameImport.install(source, found, plan, false, game, NO_PROGRESS);

        // The originals stay (untouched), the mods are the new ones.
        assertEquals("MASTER", read("master.dat"));
        assertEquals(masterTime, new File(game, "master.dat").lastModified());
        assertEquals("MUSIC", read("sound/music/01.acm"));
        assertEquals("RPU 2", read("mods/rpu.dat"));
        assertEquals("NEW", read("mods/new_mod.dat"));
        assertFalse(exists("mods/old_mod.dat"));
        assertEquals("[Main]\nNew=1\n", read("ddraw.ini"));
        // The player's settings, the new game's language.
        assertEquals("[system]\nlanguage=english\n\n[preferences]\ngame_difficulty=2\nbrightness=1.2\n\n[enhancements]\nmain_menu_continue=1\n", read("fallout2.cfg"));
        // Saves and the app's files as they were; the source's saves not taken.
        assertEquals("SAVE", read("data/SAVEGAME/SLOT01/SAVE.DAT"));
        assertFalse(exists("data/SAVEGAME/SLOT09"));
        assertEquals("FONT", read("ce.dat/font.ttf"));
        assertEquals("LOG", read("actions.log"));
        assertFalse(exists(GameFiles.STAGING));
        assertTrue(GameImport.isInstalled(game));
    }

    @Test
    public void replaceTheWholeGame() throws IOException {
        installGame();
        MemorySource source = new MemorySource()
            .put("master.dat", "MASTER")
            .put("critter.dat", "CRITTR2")
            .put("mods/rpu.dat", "RPU 1");
        install(source, false, false);

        assertEquals("CRITTR2", read("critter.dat"));
        // Not in the new game: gone, the music too.
        assertFalse(exists("sound"));
        assertFalse(exists("mods/old_mod.dat"));
        assertFalse(exists("ddraw.ini"));
        // fallout2.cfg is never removed.
        assertTrue(exists("fallout2.cfg"));
        assertEquals("SAVE", read("data/SAVEGAME/SLOT01/SAVE.DAT"));
    }

    @Test
    public void sameSizeDifferentDataIsWritten() throws IOException {
        installGame();
        long rpuTime = new File(game, "mods/rpu.dat").lastModified();
        MemorySource source = new MemorySource()
            .put("mods/rpu.dat", "RPU 9")
            .put("mods/old_mod.dat", "OLD")
            .put("ddraw.ini", "[Main]\nOld=1\n");
        // Differs in the second piece: the first one's bytes written too.
        source.chunk = 3;
        install(source, true, false);
        assertEquals("RPU 9", read("mods/rpu.dat"));
        assertEquals("OLD", read("mods/old_mod.dat"));
        assertTrue(rpuTime <= new File(game, "mods/rpu.dat").lastModified());
    }

    @Test
    public void failureLeavesTheGame() throws IOException {
        installGame();
        MemorySource source = new MemorySource()
            .put("mods/rpu.dat", "RPU 2 LONGER")
            .put("mods/new_mod.dat", "NEW MOD DATA");
        source.chunk = 4;
        source.failOn = "mods/new_mod.dat";
        try {
            install(source, true, false);
            fail();
        } catch (IOException e) {
            assertEquals("broken", e.getMessage());
        }
        assertEquals("RPU 1", read("mods/rpu.dat"));
        assertTrue(exists("mods/old_mod.dat"));
        assertFalse(exists("mods/new_mod.dat"));
        assertFalse(exists(GameFiles.STAGING));
        assertTrue(GameImport.isInstalled(game));
    }

    @Test
    public void journalIsFinishedAfterACrash() throws IOException {
        installGame();
        // Moving in had started: rpu.dat moved, new_mod.dat not, old_mod.dat
        // not removed yet.
        write(GameFiles.STAGING + "/mods/new_mod.dat", "NEW");
        write("mods/rpu.dat", "RPU 2");
        write(GameFiles.JOURNAL, "M\tmods/rpu.dat\tmods/rpu.dat\nM\tmods/new_mod.dat\tmods/new_mod.dat\nD\tmods/old_mod.dat\n");
        assertFalse(GameImport.isInstalled(game));

        GameFiles.finish(game);
        assertEquals("RPU 2", read("mods/rpu.dat"));
        assertEquals("NEW", read("mods/new_mod.dat"));
        assertFalse(exists("mods/old_mod.dat"));
        assertFalse(exists(GameFiles.JOURNAL));
        assertFalse(exists(GameFiles.STAGING));
        assertTrue(GameImport.isInstalled(game));

        // Again: nothing left to do.
        GameFiles.finish(game);
        assertEquals("NEW", read("mods/new_mod.dat"));
    }

    // Fallout 2 with Fallout Et Tu in its subfolder, as on a computer: the
    // mod's config names Fallout 2's files with "..\".
    private static MemorySource fallout2WithEtTu() {
        return new MemorySource()
            .put("Fallout 2/master.dat", "MASTER")
            .put("Fallout 2/critter.dat", "CRITTER")
            .put("Fallout 2/fallout2.cfg", "[system]\nlanguage=russian\nmaster_dat=master.dat\n")
            .put("Fallout 2/data/SAVEGAME/SLOT01/SAVE.DAT", "FALLOUT 2 SAVE")
            .put("Fallout 2/Fallout1in2/Fallout2.cfg", "[system]\r\nlanguage=english\r\nmaster_dat=..\\master.dat\r\ncritter_dat=..\\critter.dat\r\n")
            .put("Fallout 2/Fallout1in2/ddraw.ini", "[Misc]\nStartingMap=V13ent.map\n")
            .put("Fallout 2/Fallout1in2/data/maps/v13ent.map", "MAP")
            .put("Fallout 2/Fallout1in2/Fallout2.exe", "EXE");
    }

    @Test
    public void modInASubfolderIsAChoice() throws IOException {
        try {
            GameImport.find(fallout2WithEtTu(), false);
            fail("no choice");
        } catch (GameImport.ChooseGameException e) {
            assertEquals(Arrays.asList("Fallout 2/", "Fallout 2/Fallout1in2/"), e.roots);
        }
    }

    @Test
    public void modInASubfolderTakesFallout2sFiles() throws IOException {
        game = temporary.newFolder("game");
        MemorySource source = fallout2WithEtTu();
        GameImport.Found found = GameImport.find(source, false, "Fallout 2/Fallout1in2/");
        assertEquals("english", found.language);
        GameFiles.Plan plan = GameImport.plan(found, game, true);
        GameImport.install(source, found, plan, true, game, NO_PROGRESS);

        assertEquals("MASTER", read("master.dat"));
        assertEquals("CRITTER", read("critter.dat"));
        assertEquals("MAP", read("data/maps/v13ent.map"));
        assertTrue(exists("ddraw.ini"));
        assertFalse(exists("Fallout2.exe"));
        // Fallout 2's own saves stay out.
        assertFalse(exists("data/SAVEGAME/SLOT01/SAVE.DAT"));
        String config = read("Fallout2.cfg");
        assertTrue(config, config.contains("master_dat=master.dat"));
        assertTrue(config, config.contains("critter_dat=critter.dat"));
    }

    @Test
    public void fallout2LeavesTheModInItsSubfolder() throws IOException {
        game = temporary.newFolder("game");
        MemorySource source = fallout2WithEtTu();
        GameImport.Found found = GameImport.find(source, false, "Fallout 2/");
        GameFiles.Plan plan = GameImport.plan(found, game, true);
        GameImport.install(source, found, plan, true, game, NO_PROGRESS);

        assertEquals("MASTER", read("master.dat"));
        assertEquals("FALLOUT 2 SAVE", read("data/SAVEGAME/SLOT01/SAVE.DAT"));
        assertFalse(exists("Fallout1in2"));
    }

    @Test
    public void configNamingMissingFilesIsNoMod() throws IOException {
        MemorySource source = new MemorySource()
            .put("master.dat", "MASTER")
            .put("critter.dat", "CRITTER")
            .put("backup/fallout2.cfg", "[system]\nmaster_dat=..\\master.dat\ncritter_dat=..\\nothing.dat\n");
        GameImport.Found found = GameImport.find(source, false);
        assertEquals("", found.root);
    }

    // Fallout 1.5: Resurrection as its installer leaves it: a subfolder of
    // Fallout 2 whose ddraw.ini names its own config, the mod's music put in
    // Fallout 2's sound\music.
    private static MemorySource fallout2WithResurrection() {
        return new MemorySource()
            .put("Fallout 2/master.dat", "MASTER")
            .put("Fallout 2/critter.dat", "CRITTER")
            .put("Fallout 2/fallout2.cfg", "[system]\nlanguage=english\n")
            .put("Fallout 2/sound/music/25albuq.acm", "MOD MUSIC")
            .put("Fallout 2/data/sound/music/02mstrlr.acm", "FALLOUT 2 MUSIC")
            .put("Fallout 2/Resurrection/ddraw.ini", "[Main]\r\nStartingMap=nh_cave.map\r\n[Misc]\r\nConfigFile=fores.cfg\r\n")
            .put("Fallout 2/Resurrection/fores.cfg", "[sound]\r\nmusic_path1=..\\data\\sound\\music\\\r\nmusic_path2=..\\sound\\music\\\r\n"
                + "[system]\r\ncritter_dat=..\\critter.dat\r\nlanguage=english\r\nmaster_dat=..\\master.dat\r\n")
            .put("Fallout 2/Resurrection/fores.dat", "MOD")
            .put("Fallout 2/Resurrection/data/maps/nh_cave.map", "MAP");
    }

    @Test
    public void configNameFromDdrawIni() {
        assertEquals("fallout2.cfg", GameFiles.configName((String) null));
        assertEquals("fallout2.cfg", GameFiles.configName("[Main]\nUseCommandLine=0\n"));
        assertEquals("fores.cfg", GameFiles.configName("[Misc]\r\nConfigFile = fores.cfg ; the mod's\r\n"));
        assertEquals("fallout2.cfg", GameFiles.configName("[Misc]\nConfigFile=\n"));
        // Out of the game's folder, or another section: the default.
        assertEquals("fallout2.cfg", GameFiles.configName("[Misc]\nConfigFile=..\\fallout2.cfg\n"));
        assertEquals("fallout2.cfg", GameFiles.configName("[Main]\nConfigFile=fores.cfg\n"));
    }

    @Test
    public void modWithItsOwnConfigAndMusicOutside() throws IOException {
        try {
            GameImport.find(fallout2WithResurrection(), false);
            fail("no choice");
        } catch (GameImport.ChooseGameException e) {
            assertEquals(Arrays.asList("Fallout 2/", "Fallout 2/Resurrection/"), e.roots);
        }

        game = temporary.newFolder("game");
        MemorySource source = fallout2WithResurrection();
        GameImport.Found found = GameImport.find(source, false, "Fallout 2/Resurrection/");
        assertEquals("fores.cfg", found.config);
        GameFiles.Plan plan = GameImport.plan(found, game, true);
        GameImport.install(source, found, plan, true, game, NO_PROGRESS);

        assertEquals("MASTER", read("master.dat"));
        assertEquals("CRITTER", read("critter.dat"));
        assertEquals("MOD", read("fores.dat"));
        // The config's two music folders at the paths fixConfig gives them.
        assertEquals("FALLOUT 2 MUSIC", read("sound/music/02mstrlr.acm"));
        assertEquals("MOD MUSIC", read("data/sound/music/25albuq.acm"));
        String config = read("fores.cfg");
        assertTrue(config, config.contains("master_dat=master.dat"));
        assertTrue(config, config.contains("music_path1=sound/music/"));
        assertTrue(config, config.contains("music_path2=data/sound/music/"));
        assertFalse(exists("fallout2.cfg"));
        assertEquals(new File(game, "fores.cfg"), GameFiles.configFile(game));
        assertTrue(GameImport.isInstalled(game));
    }

    @Test
    public void modsOwnFilesWinOverItsMusicOutside() throws IOException {
        game = temporary.newFolder("game");
        MemorySource source = fallout2WithResurrection()
            .put("Fallout 2/Resurrection/data/sound/music/25albuq.acm", "MOD'S OWN");
        GameImport.Found found = GameImport.find(source, false, "Fallout 2/Resurrection/");
        GameFiles.Plan plan = GameImport.plan(found, game, true);
        GameImport.install(source, found, plan, true, game, NO_PROGRESS);
        assertEquals("MOD'S OWN", read("data/sound/music/25albuq.acm"));
    }

    @Test
    public void replacingKeepsTheSettingsOfTheGamesOwnConfig() throws IOException {
        game = temporary.newFolder("game");
        GameImport.Found found = GameImport.find(fallout2WithResurrection(), false, "Fallout 2/Resurrection/");
        GameImport.install(fallout2WithResurrection(), found, GameImport.plan(found, game, true), true, game, NO_PROGRESS);
        write("fores.cfg", read("fores.cfg") + "\n[preferences]\ngame_difficulty=2\n");

        // The same game again, as "Replace game": the player's setting stays.
        MemorySource again = fallout2WithResurrection();
        GameImport.Found replacing = GameImport.find(again, true, "Fallout 2/Resurrection/");
        GameFiles.Plan plan = GameImport.plan(replacing, game, false);
        assertFalse(plan.removed.contains("fores.cfg"));
        GameImport.install(again, replacing, plan, false, game, NO_PROGRESS);
        assertTrue(read("fores.cfg"), read("fores.cfg").contains("game_difficulty=2"));
    }

    @Test
    public void masterDatAsAFolder() throws IOException {
        // Fallout: Nevada 1.00: master.dat is a folder.
        game = temporary.newFolder("game");
        MemorySource source = new MemorySource()
            .put("Fallout_Nevada/master.dat/art/intrface/mainmenu.frm", "ART")
            .put("Fallout_Nevada/master.dat/maps/vault.map", "MAP")
            .put("Fallout_Nevada/critter.dat", "CRITTER")
            .put("Fallout_Nevada/fallout2.cfg", "[system]\nlanguage=russian\nmaster_dat=master.dat\n");
        GameImport.Found found = GameImport.find(source, false);
        assertEquals("Fallout_Nevada/", found.root);
        assertEquals("russian", found.language);
        GameImport.install(source, found, GameImport.plan(found, game, true), true, game, NO_PROGRESS);
        assertEquals("ART", read("master.dat/art/intrface/mainmenu.frm"));
        assertTrue(GameImport.isInstalled(game));
        assertTrue(GameFiles.isOriginalFile("master.dat/maps/vault.map"));
    }

    @Test
    public void masterDatFileAndFolderReplaceEachOther() throws IOException {
        // Fallout 2 (master.dat a file) replaced by Fallout: Nevada 1.00
        // (a folder), then the other way.
        installGame();
        MemorySource nevada = new MemorySource()
            .put("Fallout_Nevada/master.dat/art/intrface/mainmenu.frm", "ART")
            .put("Fallout_Nevada/critter.dat", "CRITTER")
            .put("Fallout_Nevada/fallout2.cfg", "[system]\nmaster_dat=master.dat\n");
        GameImport.Found found = GameImport.find(nevada, true);
        GameImport.install(nevada, found, GameImport.plan(found, game, false), false, game, NO_PROGRESS);
        assertEquals("ART", read("master.dat/art/intrface/mainmenu.frm"));
        assertFalse(GameFiles.isCommitPending(game));

        MemorySource fallout2 = new MemorySource()
            .put("master.dat", "MASTER")
            .put("critter.dat", "CRITTER");
        found = GameImport.find(fallout2, true);
        GameImport.install(fallout2, found, GameImport.plan(found, game, false), false, game, NO_PROGRESS);
        assertEquals("MASTER", read("master.dat"));
        assertEquals("SAVE", read("data/SAVEGAME/SLOT01/SAVE.DAT"));
    }

    @Test
    public void foldersTakeTheInstalledCase() throws IOException {
        // CE sees one of "DATA/" and "data/": the files go into the one there.
        installGame();
        write("data/maps/old.map", "OLD MAP");
        MemorySource source = new MemorySource()
            .put("master.dat", "MASTER")
            .put("critter.dat", "CRITTER")
            .put("DATA/MAPS/new.map", "NEW MAP")
            .put("Data/Proto/items/00000001.pro", "PRO")
            .put("DATA/proto/ITEMS/00000002.pro", "PRO 2");
        // The paths, not the folders: this computer's disk may ignore case.
        GameImport.Found found = GameImport.find(source, false);
        GameFiles.Plan plan = GameImport.plan(found, game, false);
        assertTrue(plan.paths.toString(), plan.paths.contains("data/maps/new.map"));
        assertTrue(plan.paths.toString(), plan.paths.contains("data/Proto/items/00000001.pro"));
        assertTrue(plan.paths.toString(), plan.paths.contains("data/Proto/items/00000002.pro"));
        GameImport.install(source, found, plan, false, game, NO_PROGRESS);
        assertEquals("PRO 2", read("data/Proto/items/00000002.pro"));
    }

    @Test
    public void anotherGamesConfigGoesItsSettingsCarried() throws IOException {
        // Resurrection (fores.cfg) replaced by Fallout 2 (fallout2.cfg).
        game = temporary.newFolder("game");
        GameImport.Found found = GameImport.find(fallout2WithResurrection(), false, "Fallout 2/Resurrection/");
        GameImport.install(fallout2WithResurrection(), found, GameImport.plan(found, game, true), true, game, NO_PROGRESS);
        write("fores.cfg", read("fores.cfg") + "\n[preferences]\ngame_difficulty=2\n");
        write("fores_change.log", "CHANGES");

        MemorySource fallout2 = new MemorySource()
            .put("master.dat", "MASTER")
            .put("critter.dat", "CRITTER")
            .put("fallout2.cfg", "[system]\nlanguage=english\n\n[preferences]\ngame_difficulty=1\n");
        found = GameImport.find(fallout2, true);
        GameImport.install(fallout2, found, GameImport.plan(found, game, false), false, game, NO_PROGRESS);
        assertFalse(exists("fores.cfg"));
        assertFalse(exists("fores_change.log"));
        assertTrue(read("fallout2.cfg"), read("fallout2.cfg").contains("game_difficulty=2"));
    }
}
