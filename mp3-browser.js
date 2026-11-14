#!/usr/bin/gjs
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.Gio = '2.0';

const Gtk       = imports.gi.Gtk;
const Gdk       = imports.gi.Gdk;
const GObject   = imports.gi.GObject;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;
const ByteArray = imports.byteArray;
const System    = imports.system;

// ============================================================
//  DEBUG INFRASTRUCTURE
// ============================================================
let DEBUG = false;
let DEBUG_LOG_HANDLE = null;
const DEBUG_LOG_FILE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'mp3-browser', 'debug.log']);

for (const a of ARGV) {
    if (a === '--debug' || a === '-d') DEBUG = true;
}

function debugInit() {
    if (!DEBUG) return;
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(DEBUG_LOG_FILE), 0o755);
        DEBUG_LOG_HANDLE = Gio.File.new_for_path(DEBUG_LOG_FILE)
            .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) { DEBUG_LOG_HANDLE = null; }
    debugLog('=== SESSION START ===');
    try { debugLog(`GJS version: ${System.version || '?'}`); } catch (e) {}
    try { debugLog(`programPath: ${System.programPath || '?'}`); } catch (e) {}
    try { debugLog(`GTK: ${Gtk.get_major_version()}.${Gtk.get_minor_version()}.${Gtk.get_micro_version()}`); } catch (e) {}
}

function debugLog(msg) {
    if (!DEBUG) return;
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    if (DEBUG_LOG_HANDLE) {
        try { DEBUG_LOG_HANDLE.write_all(line, null); } catch (e) {}
    }
    printerr(`[debug] ${msg}`);
}

let scriptDir = GLib.get_current_dir();
try {
    let progPath = System.programPath || System.programInvocationName;
    if (progPath && progPath.includes('/')) {
        scriptDir = GLib.path_get_dirname(GLib.canonicalize_filename(progPath, GLib.get_current_dir()));
    }
} catch (e) {}
imports.searchPath.unshift(scriptDir);
const Scanner = imports['mp3-scanner'];

let cliRoot = null;
for (const arg of ARGV) {
    if (arg === '--help' || arg === '-h') {
        print("Usage: mp3-browser.js [PATH]");
        System.exit(0);
    } else if (!arg.startsWith('-')) {
        cliRoot = arg;
    }
}
Gtk.init(null);

debugInit();

/* ============================================================
 *  Вспомогательные функции
 * ============================================================ */
function getTreeIter(r) {
    if (r === null || r === undefined || r === false || r === true) return null;
    if (Array.isArray(r)) {
        if (r.length === 2 && typeof r[0] === 'boolean') return r[0] ? r[1] : null;
        if (r.length === 1) return r[0];
        if (r.length === 2) return r[1];
    }
    return r;
}

function getNextIter(model, iter) {
    const r = model.iter_next(iter);
    // Современный GJS: [bool, iter]. Старый GJS/CJS: bool + in-place.
    if (Array.isArray(r) && typeof r[0] === 'boolean') {
        return r[0] ? r[1] : null;
    }
    return r ? iter : null;
}
function getSelected(selection) {
    const r = selection.get_selected();
    if (!r) return [null, null];
    if (Array.isArray(r) && r.length === 3 && typeof r[0] === 'boolean') return r[0] ? [r[1], r[2]] : [null, null];
    return [r[0] || null, r[1] || null];
}
function getHitPath(tv, x, y) {
    const r = tv.get_path_at_pos(Math.floor(x), Math.floor(y));
    if (!r) return null;
    if (Array.isArray(r)) {
        if (typeof r[0] === 'boolean') return r[0] ? r[1] : null;
        return r[0] || null;
    }
    if (typeof r.get_indices === 'function') return r;
    return null;
}
function evtButton(event) {
    if (!event) return 0;
    if (typeof event.get_button === 'function') {
        try {
            const r = event.get_button();
            if (Array.isArray(r)) {
                if (typeof r[0] === 'boolean') return r[0] ? (r[1] || 0) : 0;
                if (typeof r[0] === 'number') return r[0];
            }
            if (typeof r === 'number') return r;
        } catch (e) {}
    }
    try {
        const b = event.button;
        if (typeof b === 'number') return b;
        if (Array.isArray(b) && typeof b[0] === 'boolean') return b[0] ? (b[1] || 0) : 0;
    } catch (e) {}
    return 0;
}
function evtKeyval(event) {
    if (!event) return 0;
    if (typeof event.get_keyval === 'function') {
        const r = event.get_keyval();
        if (Array.isArray(r)) return r[0] || 0;
        return r || 0;
    }
    return event.keyval || 0;
}
function evtXY(event) {
    if (!event) return [0, 0];
    if (typeof event.get_coords === 'function') {
        try {
            const r = event.get_coords();
            if (Array.isArray(r)) {
                if (typeof r[0] === 'boolean' && r.length >= 3) return [r[1] || 0, r[2] || 0];
                if (r.length >= 2) return [r[0] || 0, r[1] || 0];
            }
        } catch (e) {}
    }
    try {
        const x = event.x, y = event.y;
        if (typeof x === 'number' && typeof y === 'number') return [x, y];
    } catch (e) {}
    return [0, 0];
}
function popupMenuAtPointer(menu) {
    menu.show_all();
    if (typeof menu.popup_at_pointer === 'function') menu.popup_at_pointer(null);
    else menu.popup(null, null, null, 0, 0);
}
function _modelToTracks(model, onlySelected, treeView) {
    const tracks = [];
    if (onlySelected && treeView) {
        treeView.get_selection().selected_foreach((m, path, iter) => {
            if (!iter) iter = getTreeIter(model.get_iter(path));
            if (!iter) return;
            const name = model.get_value(iter, 0);
            const file = model.get_value(iter, 1);
            const dir  = model.get_value(iter, 2);
            tracks.push({ name, path: dir.endsWith('/') ? dir + file : dir + '/' + file });
        });
    } else {
        model.foreach((m, path, iter) => {
            if (!iter) return;
            const name = model.get_value(iter, 0);
            const file = model.get_value(iter, 1);
            const dir  = model.get_value(iter, 2);
            tracks.push({ name, path: dir.endsWith('/') ? dir + file : dir + '/' + file });
        });
    }
    return tracks;
}

function getSelectedTracks(treeView, model) {
    return _modelToTracks(model, true, treeView);
}
function getAllTracksFromFileList() {
    return _modelToTracks(fileListStore, false, null);
}
function getPlaylistTracksInDisplayOrder(plName) {
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    const isDisplayed = piter && pmodel.get_value(piter, 0) === plName;

    if (isDisplayed) {
        // Этот плейлист уже отрисован в правой таблице — берём как есть
        const tracks = [];
        playlistContentStore.foreach((m, path, iter) => {
            if (!iter) return;
            const name = playlistContentStore.get_value(iter, 0);
            const file = playlistContentStore.get_value(iter, 1);
            const dir  = playlistContentStore.get_value(iter, 2);
            tracks.push({ name, path: dir.endsWith('/') ? dir + file : dir + '/' + file });
        });
        return tracks;
    }

    // Fallback: плейлист не открыт — сортируем PLAYLIST_DATA по правилам этого плейлиста
    const files = PLAYLIST_DATA.get(plName) || [];
    const ps = PLAYLIST_SORT.get(plName) || { sortId: -1, sortOrder: 0 };
    if (ps.sortId < 0) return files.map(f => ({ name: f.name, path: f.path }));

    const rows = files.map(f => {
        const rel = getRelativePath(activeRootPath, f.path);
        const t = DISK_TAG_CACHE[rel] || {};
        return [
            t.Name || f.name,
            GLib.path_get_basename(f.path),
            GLib.path_get_dirname(f.path) + '/',
            t.Track ? String(t.Track) : '',
            t.Year || '', t.Genre || '', t.Artist || '', t.Album || '',
            f.path
        ];
    });
    const sorted = sortRowsInJs(rows, ps.sortId, ps.sortOrder);
    return sorted.map(r => ({ name: r[0], path: r[8] }));
}

function setupSelectionBlocking(view) {
    let blockSelection = false;
    view.get_selection().set_select_function((sel, model, path, isSel) => !blockSelection);
    view.connect('button-press-event', (w, event) => {
        if (evtButton(event) === 1) {
            const [x, y] = evtXY(event);
            const path = getHitPath(w, x, y);
            if (path && w.get_selection().path_is_selected(path)) blockSelection = true;
        }
        return false;
    });
    view.connect('button-release-event', (w, event) => {
        if (evtButton(event) === 1) blockSelection = false;
        return false;
    });
    view.connect('drag-end', () => { blockSelection = false; });
}

const DRAG_ICON_CSS = new Gtk.CssProvider();
try { DRAG_ICON_CSS.load_from_data(`
    .drag-icon-root { background-color: rgba(255, 255, 255, 0.95); border: 1px solid rgba(0, 0, 0, 0.35); border-radius: 4px; }
    .drag-icon-header { font-weight: bold; } .drag-icon-more { font-style: italic; opacity: 0.75; }
`); } catch (e) {}

function makeDragIcon(names) {
    const MAX_SHOW = 5; const shown = names.slice(0, MAX_SHOW); const more = names.length - shown.length;
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 1 });
    box.set_margin_start(8); box.set_margin_end(8); box.set_margin_top(6); box.set_margin_bottom(6);
    const header = new Gtk.Label({ label: names.length === 1 ? names[0] : `Перетаскивается: ${names.length}`, xalign: 0 });
    header.get_style_context().add_class('drag-icon-header'); box.pack_start(header, false, false, 0);
    if (names.length > 1) {
        box.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }), false, false, 2);
        for (const n of shown) box.pack_start(new Gtk.Label({ label: n, xalign: 0 }), false, false, 0);
        if (more > 0) {
            const lbl = new Gtk.Label({ label: `…и ещё ${more}`, xalign: 0 });
            lbl.get_style_context().add_class('drag-icon-more'); box.pack_start(lbl, false, false, 0);
        }
    }
    box.get_style_context().add_class('drag-icon-root'); box.get_style_context().add_provider(DRAG_ICON_CSS, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    box.show_all(); return box;
}

/* ============================================================
 *  Конфигурация
 * ============================================================ */
const CONFIG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'mp3-browser']);
const CACHE_DIR  = GLib.build_filenamev([GLib.get_user_cache_dir(), 'mp3-browser']);
const CONFIG_FILE = GLib.build_filenamev([CONFIG_DIR, 'config.ini']);
const WINDOW_FILE = GLib.build_filenamev([CONFIG_DIR, 'window.json']);
const PLAYLISTS_FILE = GLib.build_filenamev([CONFIG_DIR, 'playlists.json']);

try { GLib.mkdir_with_parents(CONFIG_DIR, 0o755); } catch (e) {}
try { GLib.mkdir_with_parents(CACHE_DIR, 0o755); } catch (e) {}

if (!GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)) {
    const DEFAULT_CONFIG = `[Paths]\nRoots=\n\n[Player]\nPlay=\nEnqueue=\nMultipleTracksUseM3U=false\n\n[Scan]\nMaxTrackCount=20000\nLogEvery=500\n`;
    try { GLib.file_set_contents(CONFIG_FILE, DEFAULT_CONFIG); } catch (e) {}
}

const keyfile = new GLib.KeyFile();
try { keyfile.load_from_file(CONFIG_FILE, GLib.KeyFileFlags.NONE); } catch (e) {}

let rootsStr = ''; try { rootsStr = keyfile.get_string('Paths', 'Roots'); } catch (e) {}
const ROOTS = rootsStr ? rootsStr.split(';').map(s => s.trim()).filter(Boolean) : [];

let cliRootIndex = -1;
if (cliRoot) {
    const absPath = GLib.canonicalize_filename(cliRoot, GLib.get_current_dir());
    if (!ROOTS.includes(absPath)) ROOTS.push(absPath);
    cliRootIndex = ROOTS.indexOf(absPath);
}

function getPlayCommand() { try { return keyfile.get_string('Player', 'Play'); } catch (e) { return ''; } }
function getEnqueueCommand() { try { return keyfile.get_string('Player', 'Enqueue'); } catch (e) { return ''; } }
function getMultipleM3U() { try { return keyfile.get_boolean('Player', 'MultipleTracksUseM3U'); } catch (e) { return false; } }
function getMaxTrackCount() { try { return keyfile.get_integer('Scan', 'MaxTrackCount') || 20000; } catch (e) { return 20000; } }
function getScanLogEvery() { try { return keyfile.get_integer('Scan', 'LogEvery') || 500; } catch (e) { return 500; } }

let winConfig = {
    width: 800, height: 600, hpaned: 248, vpaned: 338, collection: 0,
    fileCols: {
        order: ["№", "Имя", "Альбом", "Дата", "Исполнитель", "Жанр", "Файл", "Путь"],
        widths: {"№": 50, "Имя": 346, "Альбом": 166, "Дата": 66, "Исполнитель": 132, "Жанр": 72, "Файл": 249, "Путь": 282},
        sortId: 7, sortOrder: 0
    },
    playlistCols: {
        order: ["Имя", "Файл", "Путь", "Дата", "Жанр", "Исполнитель", "Альбом", "№"],
        widths: {"Имя": 58, "Файл": 69, "Путь": 65, "Дата": 66, "Жанр": 72, "Исполнитель": 132, "Альбом": 85, "№": 911},
        sortId: -1, sortOrder: 0
    }
};
try {
    if (GLib.file_test(WINDOW_FILE, GLib.FileTest.EXISTS)) {
        const [ok, data] = GLib.file_get_contents(WINDOW_FILE);
        if (ok) winConfig = Object.assign(winConfig, JSON.parse(ByteArray.toString(data)));
    }
} catch (e) {}
if (cliRootIndex >= 0) winConfig.collection = cliRootIndex;

const FILE_COLS = ['Имя', 'Файл', 'Путь', '№', 'Дата', 'Жанр', 'Исполнитель', 'Альбом'];
const TC_NAME = 0, TC_PATH = 1;

/* ============================================================
 *  Окно и Меню
 * ============================================================ */
const win = new Gtk.Window({ title: 'MP3-Browser', default_width: winConfig.width, default_height: winConfig.height });
// Системный трей
let statusIcon = null;
try {
    statusIcon = new Gtk.StatusIcon();
    statusIcon.set_from_icon_name('media-playback-start'); // Иконка (если нет в теме, будет использоваться стандартная)
    statusIcon.set_tooltip_text('MP3-Browser');
    statusIcon.set_visible(true);
    statusIcon.connect('activate', () => {
        if (win.get_visible()) {
            win.hide();
        } else {
            win.show();
            win.present();
        }
    });
} catch (e) {
    console.log("Gtk.StatusIcon не поддерживается вашей системой:", e.message);
}
win.connect('configure-event', (w, event) => {
    const [width, height] = w.get_size();
    if (width > 1 && height > 1) { winConfig.width = width; winConfig.height = height; }
    return false;
});
win.connect('destroy', () => {
    winConfig.hpaned = hpaned.get_position();
    winConfig.vpaned = vpaned.get_position();
    winConfig.collection = combo.get_active();
    winConfig.fileCols = getColumnConfig(fileListTree, winConfig.fileCols);
    winConfig.playlistCols = getColumnConfig(playlistContentTree, winConfig.playlistCols);
    saveFileUtf8(WINDOW_FILE, JSON.stringify(winConfig, null, 2));
    savePlaylists();
    if (tagCacheSaveTimer) { GLib.source_remove(tagCacheSaveTimer); tagCacheSaveTimer = 0; }
    saveTagCache();
    Gtk.main_quit();
});

const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
win.add(vbox);

const menubar = new Gtk.MenuBar();
vbox.pack_start(menubar, false, false, 0);
const fileMenu = new Gtk.Menu();
const miReload = new Gtk.MenuItem({ label: 'Reload' });
miReload.connect('activate', () => doReload());
fileMenu.append(miReload);
fileMenu.append(new Gtk.SeparatorMenuItem());
const miSettings = new Gtk.MenuItem({ label: 'Настройки…' });
miSettings.connect('activate', () => openSettingsDialog());
fileMenu.append(miSettings);
fileMenu.append(new Gtk.SeparatorMenuItem());
const miQuit = new Gtk.MenuItem({ label: 'Выход' });
miQuit.connect('activate', () => Gtk.main_quit());
fileMenu.append(miQuit);
const fileItem = new Gtk.MenuItem({ label: 'Файл' });
fileItem.set_submenu(fileMenu); menubar.append(fileItem);

const comboRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
comboRow.set_margin_start(4); comboRow.set_margin_end(4); comboRow.set_margin_top(4); comboRow.set_margin_bottom(4);
const combo = new Gtk.ComboBoxText(); combo.set_hexpand(true);
for (const p of ROOTS) combo.append_text(p);
const reloadBtn = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Перечитать (только новые файлы). SHIFT+клик — перечитать все теги.' });
reloadBtn.add(new Gtk.Image({ icon_name: 'view-refresh', icon_size: Gtk.IconSize.BUTTON }));
reloadBtn.connect('clicked', () => {
    if (isShiftPressed()) doForceReload();
    else doReload();
});
comboRow.pack_start(combo, true, true, 0);
comboRow.pack_start(reloadBtn, false, false, 0);
vbox.pack_start(comboRow, false, false, 0);

const css = new Gtk.CssProvider();
try { css.load_from_data(`paned > separator { min-width: 5px; min-height: 5px; background-color: @theme_bg_color; } #catalog-tree { background-color: #f5f5f5; }`); } catch(e) {}
Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

const hpaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
hpaned.set_hexpand(true); hpaned.set_vexpand(true);
hpaned.set_position(winConfig.hpaned);
vbox.pack_start(hpaned, true, true, 0);

const leftBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const filterRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
filterRow.set_margin_start(4); filterRow.set_margin_end(4); filterRow.set_margin_top(4); filterRow.set_margin_bottom(4);
const filterEntry = new Gtk.Entry({ hexpand: true, placeholder_text: 'Фильтр' });
const filesCheckbox = new Gtk.CheckButton({ label: 'Файлы' });
filterRow.pack_start(filterEntry, true, true, 0); filterRow.pack_start(filesCheckbox, false, false, 0);
leftBox.pack_start(filterRow, false, false, 0);

let nodesByPath = new Map();
let scanGeneration = 0; let loadGeneration = 0; let isScanning = false;

const treeStore = Gtk.TreeStore.new([GObject.TYPE_STRING, GObject.TYPE_STRING]);
const filterState = { text: '', byFiles: false };

function matchesSelf(model, iter) {
    const text = filterState.text; if (!text) return true;
    const path = model.get_value(iter, TC_PATH); const node = nodesByPath.get(path);
    if (!node) return false;
    if (filterState.byFiles) return subtreeHasMatchingFile(node, text);
    return (node.name || '').toLowerCase().includes(text);
}
function subtreeHasMatchingFile(node, text) {
    for (const f of node.fileNames) {
        if (f.name.toLowerCase().includes(text)) return true;
        const t = f.tags || {}; if ((t.Name || '').toLowerCase().includes(text)) return true;
    }
    for (const c of node.children) { if (subtreeHasMatchingFile(c, text)) return true; }
    return false;
}
function hasMatchingDescendant(model, iter) {
    let child = getTreeIter(model.iter_children(iter));
    while (child) {
        if (matchesSelf(model, child)) return true;
        if (hasMatchingDescendant(model, child)) return true;
        child = getNextIter(model, child);
    }
    return false;
}
function visibleFunc(model, iter) {
    if (!filterState.text) return true;
    return matchesSelf(model, iter) || hasMatchingDescendant(model, iter);
}

const treeFilter = treeStore.filter_new(null); treeFilter.set_visible_func(visibleFunc);
const treeView = new Gtk.TreeView({ model: treeFilter });
treeView.set_headers_visible(false); treeView.set_enable_tree_lines(true); treeView.set_name('catalog-tree');
treeView.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE); setupSelectionBlocking(treeView);

const treeCol = new Gtk.TreeViewColumn(); const treeRend = new Gtk.CellRendererText();
treeCol.pack_start(treeRend, true); treeCol.add_attribute(treeRend, 'text', TC_NAME); treeView.append_column(treeCol);
const treeScroll = new Gtk.ScrolledWindow(); treeScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
treeScroll.add(treeView); leftBox.pack_start(treeScroll, true, true, 0); hpaned.pack1(leftBox, false, false);

// DnD: перетаскивание каталогов из дерева в плейлист
const treeDragTargets = [Gtk.TargetEntry.new('text/plain', 0, 0)];
treeView.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, treeDragTargets, Gdk.DragAction.COPY);
treeView.connect('drag-begin', (w, ctx) => {
    const names = [];
    w.get_selection().selected_foreach((model, path, iter) => {
        names.push(model.get_value(iter, TC_NAME));
    });
    try {
        const icon = makeDragIcon(names);
        Gtk.drag_set_icon_widget(ctx, icon, 0, 0);
    } catch (e) {
        try { Gtk.drag_set_icon_name(ctx, 'folder', 0, 0); } catch (e2) {}
    }
});
treeView.connect('drag-data-get', (w, ctx, sel, info, time) => {
    // 1. Собираем порядок отображения из правой таблицы (то, что видит пользователь)
    const orderedEntries = [];          // [{name, path}] в порядке таблицы
    const orderIndex = new Map();       // path -> index
    fileListStore.foreach((model, path, iter) => {
        if (!iter) return;
        const name = fileListStore.get_value(iter, 0);
        const file = fileListStore.get_value(iter, 1);
        const dir  = fileListStore.get_value(iter, 2);
        const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
        orderIndex.set(fullPath, orderedEntries.length);
        orderedEntries.push({ name, path: fullPath });
    });

    // 2. Собираем выделенные папки, сортируем треки каждой по порядку таблицы
    const folders = [];
    const allPaths = new Set();
    w.get_selection().selected_foreach((model, path, iter) => {
        const tcPath = model.get_value(iter, TC_PATH);
        const node = nodesByPath.get(tcPath);
        if (!node) return;
        const files = [];
        collectFilesFromNode(node, files);
        const rawTracks = files.map(f => ({ name: f.name, path: f.path }));
        for (const t of rawTracks) allPaths.add(t.path);

        // Сортируем треки этой папки по порядку из правой таблицы
        const folderTracks = rawTracks.slice().sort((a, b) => {
            const ia = orderIndex.has(a.path) ? orderIndex.get(a.path) : Infinity;
            const ib = orderIndex.has(b.path) ? orderIndex.get(b.path) : Infinity;
            if (ia !== ib) return ia - ib;
            if (a.path < b.path) return -1;
            if (a.path > b.path) return 1;
            return 0;
        });
        folders.push({ name: node.name, path: node.path, tracks: folderTracks });
    });

    // 3. Собираем общий список всех уникальных треков в порядке правой таблицы
    const seen = new Set();
    const tracks = [];
    for (const entry of orderedEntries) {
        if (allPaths.has(entry.path) && !seen.has(entry.path)) {
            seen.add(entry.path);
            tracks.push(entry);
        }
    }
    // Добиваем остатком — треками из папок, которых не было в таблице
    for (const folder of folders) {
        for (const t of folder.tracks) {
            if (!seen.has(t.path)) {
                seen.add(t.path);
                tracks.push(t);
            }
        }
    }

    if (tracks.length > 0) {
        sel.set_text(JSON.stringify({ tracks: tracks, folders: folders }), -1);
    }
});

const vpaned = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL }); vpaned.set_position(winConfig.vpaned); hpaned.pack2(vpaned, true, false);

/* ---- Верхняя таблица файлов ---- */
const fileListStore = Gtk.ListStore.new([...FILE_COLS.map(() => GObject.TYPE_STRING), GObject.TYPE_STRING]);
const fileListTree = new Gtk.TreeView({ model: fileListStore });
FILE_COLS.forEach((title, idx) => {
    const col = new Gtk.TreeViewColumn({ title });
    col.set_clickable(true);
    col.set_resizable(true);
    col.set_min_width(50);
    col.set_reorderable(true);
    col.connect('clicked', () => handleFileColumnClick(idx));
    const rend = new Gtk.CellRendererText();
    col.pack_start(rend, true);
    col.add_attribute(rend, 'text', idx);
    fileListTree.append_column(col);
});
fileListTree.set_grid_lines(Gtk.TreeViewGridLines.HORIZONTAL); fileListTree.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);
setupSelectionBlocking(fileListTree);

const fileListScroll = new Gtk.ScrolledWindow(); fileListScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC); fileListScroll.add(fileListTree);
const fileToolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
fileToolbar.set_margin_start(2); fileToolbar.set_margin_end(2); fileToolbar.set_margin_top(2); fileToolbar.set_margin_bottom(2);
const btnFilePlay = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Проиграть выделенные' }); btnFilePlay.add(new Gtk.Image({ icon_name: 'media-playback-start', icon_size: Gtk.IconSize.BUTTON }));
const btnFileEnq = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Добавить в очередь' }); btnFileEnq.add(new Gtk.Image({ icon_name: 'media-playlist-append', icon_size: Gtk.IconSize.BUTTON }));
const btnFileAdd = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Добавить в плейлист' }); btnFileAdd.add(new Gtk.Image({ icon_name: 'list-add', icon_size: Gtk.IconSize.BUTTON }));
for (const b of [btnFilePlay, btnFileEnq, btnFileAdd]) fileToolbar.pack_start(b, false, false, 0);

const fileTableBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
fileTableBox.pack_start(fileListScroll, true, true, 0); fileTableBox.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }), false, false, 0);
fileTableBox.pack_start(fileToolbar, false, false, 0); vpaned.pack1(fileTableBox, true, true);

const dragTargets = [Gtk.TargetEntry.new('text/plain', 0, 0)];
fileListTree.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, dragTargets, Gdk.DragAction.COPY);
fileListTree.connect('drag-begin', (w, ctx) => {
    const tracks = getSelectedTracks(w, fileListStore); const names = tracks.map(t => t.name);
    try { const icon = makeDragIcon(names); Gtk.drag_set_icon_widget(ctx, icon, 0, 0); }
    catch (e) { try { Gtk.drag_set_icon_name(ctx, 'text-x-generic', 0, 0); } catch (e2) {} }
});
fileListTree.connect('drag-data-get', (w, ctx, sel, info, time) => {
    const tracks = getSelectedTracks(w, fileListStore); if (tracks.length > 0) sel.set_text(JSON.stringify(tracks), -1);
});

/* ---- Нижняя панель: плейлисты ---- */
const bottomPaned = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL }); bottomPaned.set_position(200); vpaned.pack2(bottomPaned, false, false);
const playlistsBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
const playlistStore = Gtk.TreeStore.new([GObject.TYPE_STRING]);
const playlistTree = new Gtk.TreeView({ model: playlistStore }); playlistTree.set_headers_visible(false);
const plCol = new Gtk.TreeViewColumn(); const plRend = new Gtk.CellRendererText();
plCol.pack_start(plRend, true); plCol.add_attribute(plRend, 'text', 0); playlistTree.append_column(plCol);
// DnD: перетаскивание папок из дерева в список плейлистов => создаём новые плейлисты
playlistTree.drag_dest_set(Gtk.DestDefaults.ALL,
    [Gtk.TargetEntry.new('text/plain', 0, 0)], Gdk.DragAction.COPY);

playlistTree.connect('drag-data-received', (w, ctx, x, y, sel, info, time) => {
    const text = sel.get_text();
    if (!text) { Gtk.drag_finish(ctx, false, false, time); return; }

    let folders = [];
    try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.folders && Array.isArray(parsed.folders)) folders = parsed.folders;
        else if (parsed && parsed.path) folders = [{ name: GLib.path_get_basename(parsed.path), tracks: [parsed] }];
    } catch (e) {}
    if (folders.length === 0) { Gtk.drag_finish(ctx, false, false, time); return; }

    let lastIter = null;
    for (const folder of folders) {
        const baseName = folder.name || 'Плейлист';
        let uniqueName = baseName, n = 1;
        while (PLAYLIST_DATA.has(uniqueName)) uniqueName = `${baseName} (${n++})`;
        PLAYLIST_DATA.set(uniqueName, (folder.tracks || []).map(t => ({ name: t.name, path: t.path })));
        // Наследуем сортировку файловой таблицы — плейлист будет отображаться в том же порядке
        PLAYLIST_SORT.set(uniqueName, {
            sortId: winConfig.fileCols ? winConfig.fileCols.sortId : -1,
            sortOrder: winConfig.fileCols ? winConfig.fileCols.sortOrder : 0
        });
        const iter = getTreeIter(playlistStore.append(null));
        if (iter) {
            playlistStore.set(iter, [0], [uniqueName]);
            lastIter = iter;
        }
    }
    savePlaylists();
    if (lastIter) {
        try { playlistTree.get_selection().select_iter(lastIter); } catch (e) {}
    }
    Gtk.drag_finish(ctx, true, false, time);
});
const playlistScroll = new Gtk.ScrolledWindow(); playlistScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC); playlistScroll.add(playlistTree);
playlistsBox.pack_start(playlistScroll, true, true, 0);

const plBtnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
plBtnBox.set_margin_start(2); plBtnBox.set_margin_end(2); plBtnBox.set_margin_top(2); plBtnBox.set_margin_bottom(2);
const btnAdd = new Gtk.Button({ label: '+', tooltip_text: 'Добавить' }); const btnDel = new Gtk.Button({ label: '−', tooltip_text: 'Удалить' });
const btnUp = new Gtk.Button({ label: '▲', tooltip_text: 'Вверх' }); const btnDown = new Gtk.Button({ label: '▼', tooltip_text: 'Вниз' });
for (const b of [btnAdd, btnDel, btnUp, btnDown]) plBtnBox.pack_start(b, true, true, 0);
playlistsBox.pack_start(plBtnBox, false, false, 0); bottomPaned.pack1(playlistsBox, false, false);

const playlistContentStore = Gtk.ListStore.new([...FILE_COLS.map(() => GObject.TYPE_STRING), GObject.TYPE_STRING]);
//playlistContentStore.set_sort_func(3, trackNumberCompare);
//playlistContentStore.set_sort_func(7, albumCompoundSort);
const playlistContentTree = new Gtk.TreeView({ model: playlistContentStore });
FILE_COLS.forEach((title, idx) => {
    const col = new Gtk.TreeViewColumn({ title });
    col.set_clickable(true);
    col.set_resizable(true);
    col.set_min_width(50);
    col.set_reorderable(true);
    col.connect('clicked', () => handlePlaylistColumnClick(idx));
    const rend = new Gtk.CellRendererText();
    col.pack_start(rend, true);
    col.add_attribute(rend, 'text', idx);
    playlistContentTree.append_column(col);
});
playlistContentTree.set_grid_lines(Gtk.TreeViewGridLines.HORIZONTAL); playlistContentTree.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);
setupSelectionBlocking(playlistContentTree); playlistContentTree.set_reorderable(true); playlistContentTree.drag_dest_add_text_targets();

const playlistToolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
playlistToolbar.set_margin_start(2); playlistToolbar.set_margin_end(2); playlistToolbar.set_margin_top(2); playlistToolbar.set_margin_bottom(2);
const btnPlPlay = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Проиграть выделенные' }); btnPlPlay.add(new Gtk.Image({ icon_name: 'media-playback-start', icon_size: Gtk.IconSize.BUTTON }));
const btnPlEnq = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Добавить в очередь' }); btnPlEnq.add(new Gtk.Image({ icon_name: 'media-playlist-append', icon_size: Gtk.IconSize.BUTTON }));
const btnPlAdd = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Добавить в плейлист' }); btnPlAdd.add(new Gtk.Image({ icon_name: 'list-add', icon_size: Gtk.IconSize.BUTTON }));
const btnPlDel = new Gtk.Button({ relief: Gtk.ReliefStyle.NONE, tooltip_text: 'Удалить из плейлиста' }); btnPlDel.add(new Gtk.Image({ icon_name: 'list-remove', icon_size: Gtk.IconSize.BUTTON }));
for (const b of [btnPlPlay, btnPlEnq, btnPlAdd, btnPlDel]) playlistToolbar.pack_start(b, false, false, 0);

const playlistContentScroll = new Gtk.ScrolledWindow(); playlistContentScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC); playlistContentScroll.add(playlistContentTree);
const playlistTableBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
playlistTableBox.pack_start(playlistContentScroll, true, true, 0); playlistTableBox.pack_start(new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL }), false, false, 0);
playlistTableBox.pack_start(playlistToolbar, false, false, 0); bottomPaned.pack2(playlistTableBox, true, false);

/* ============================================================
 *  Применение сохранённых настроек колонок
 * ============================================================ */
function getColumnConfig(treeView, existing) {
    const cols = treeView.get_columns();
    const order = cols.map(c => c.get_title());
    const widths = {};
    cols.forEach(c => widths[c.get_title()] = c.get_width());
    return {
        order,
        widths,
        sortId: existing ? existing.sortId : -1,
        sortOrder: existing ? existing.sortOrder : 0
    };
}

function applyColumnConfig(treeView, model, config) {
    if (!config) return;
    const cols = treeView.get_columns(); const colMap = {};
    cols.forEach(c => colMap[c.get_title()] = c);
    const order = config.order || [];
    order.forEach(title => { const c = colMap[title]; if (c) { treeView.remove_column(c); treeView.append_column(c); } });
    const widths = config.widths || {};
    for (const title in widths) { if (colMap[title]) colMap[title].set_fixed_width(widths[title]); }
    // Сортировка управляется вручную через _batchInsert. Gtk-сортировку не включаем,
    // чтобы не срабатывал sort_func на невалидных итераторах.
}
applyColumnConfig(fileListTree, fileListStore, winConfig.fileCols);
applyColumnConfig(playlistContentTree, playlistContentStore, winConfig.playlistCols);

function handleFileColumnClick(modelIdx) {
    if (!winConfig.fileCols) winConfig.fileCols = { sortId: -1, sortOrder: 0 };
    if (winConfig.fileCols.sortId === modelIdx) {
        winConfig.fileCols.sortOrder = (winConfig.fileCols.sortOrder === Gtk.SortType.DESCENDING)
            ? Gtk.SortType.ASCENDING : Gtk.SortType.DESCENDING;
    } else {
        winConfig.fileCols.sortId = modelIdx;
        winConfig.fileCols.sortOrder = Gtk.SortType.ASCENDING;
    }
    updateFileSortIndicators();
    refreshFileListFromSelection();
}

function handlePlaylistColumnClick(modelIdx) {
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (!piter) return;
    const plName = pmodel.get_value(piter, 0);
    const cur = PLAYLIST_SORT.get(plName) || { sortId: -1, sortOrder: 0 };
    let newOrder = Gtk.SortType.ASCENDING;
    if (cur.sortId === modelIdx && cur.sortOrder === Gtk.SortType.ASCENDING)
        newOrder = Gtk.SortType.DESCENDING;
    PLAYLIST_SORT.set(plName, { sortId: modelIdx, sortOrder: newOrder });
    showPlaylistContent(plName);
    savePlaylists();
}

// ============================================================
//  Сортировка кликом по заголовку — JS-side
// ============================================================
function updateFileSortIndicators() {
    const sortId = winConfig.fileCols ? winConfig.fileCols.sortId : -1;
    const sortOrder = winConfig.fileCols ? winConfig.fileCols.sortOrder : 0;
    const sortTitle = (sortId >= 0 && sortId < FILE_COLS.length) ? FILE_COLS[sortId] : null;
    for (const c of fileListTree.get_columns()) {
        if (sortTitle !== null && c.get_title() === sortTitle) {
            c.set_sort_indicator(true);
            c.set_sort_order(sortOrder);
        } else {
            c.set_sort_indicator(false);
        }
    }
}

function updatePlaylistSortIndicators(plName) {
    if (!plName) {
        const [, piter] = getSelected(playlistTree.get_selection());
        if (piter) plName = playlistStore.get_value(piter, 0);
    }
    let ps = plName ? PLAYLIST_SORT.get(plName) : null;
    if (!ps) ps = { sortId: -1, sortOrder: 0 };
    const sortTitle = (ps.sortId >= 0 && ps.sortId < FILE_COLS.length) ? FILE_COLS[ps.sortId] : null;
    for (const c of playlistContentTree.get_columns()) {
        if (sortTitle !== null && c.get_title() === sortTitle) {
            c.set_sort_indicator(true);
            c.set_sort_order(ps.sortOrder);
        } else {
            c.set_sort_indicator(false);
        }
    }
}

updateFileSortIndicators();
updatePlaylistSortIndicators(null);

updatePlaylistSortIndicators();

const statusbar = new Gtk.Statusbar(); const progress = new Gtk.ProgressBar({ width_request: 200, show_text: false });
progress.set_no_show_all(true); statusbar.pack_end(progress, false, false, 4); vbox.pack_start(statusbar, false, false, 0);
statusbar.push(1, 'Готово');

/* ============================================================
 *  Данные плейлистов + JSON
 * ============================================================ */
let activeRootPath = '';
let isRootWritable = false;
let fileCachePath = '';
let tagCachePath = '';
let DISK_TAG_CACHE = {};
let tagCacheSaveTimer = 0;

function saveFileUtf8(path, content) {
    try {
        let text = content;
        if (typeof text !== 'string') {
            text = ByteArray.toString(text); // на случай, если пришёл Uint8Array
        }
        // Принудительно кодируем в UTF-8 через TextEncoder
        if (typeof TextEncoder !== 'undefined') {
            const bytes = new TextEncoder().encode(text);
            GLib.file_set_contents(path, bytes);
        } else {
            // Запасной вариант для очень старых версий CJS
            GLib.file_set_contents(path, text);
        }
    } catch (e) {
        console.error(`Ошибка сохранения ${path}:`, e);
    }
}

function checkWriteAccess(dir) {
    try {
        const file = Gio.File.new_for_path(dir);
        const info = file.query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null);
        if (!info.get_attribute_boolean('access::can-write')) return false;
        try {
            const fsInfo = file.query_filesystem_info('filesystem::free', null);
            if (fsInfo.has_attribute('filesystem::free')) {
                const free = fsInfo.get_attribute_uint64('filesystem::free');
                if (free < 10 * 1024 * 1024) return false; // Меньше 10 МБ не пишем
            }
        } catch (e) {} // Игнорируем ошибки FS info
        return true;
    } catch (e) { return false; }
}

function getDefaultAction() {
    try { return keyfile.get_string('Player', 'DefaultAction') || 'play'; }
    catch (e) { return 'play'; }
}

function getRelativePath(root, abs) {
    if (abs.startsWith(root)) {
        let rel = abs.substring(root.length);
        if (rel.startsWith('/')) rel = rel.substring(1);
        return rel;
    }
    return abs;
}
function getAbsolutePath(root, rel) {
    if (rel.startsWith('/')) return rel;
    return GLib.build_filenamev([root, rel]);
}
function treeToRelative(node, root) {
    if (Array.isArray(node)) return node.map(f => getRelativePath(root, f));
    if (node && typeof node === 'object') {
        const out = {};
        for (const k in node) out[k] = treeToRelative(node[k], root);
        return out;
    }
    return node;
}
function treeToAbsolute(node, root) {
    if (Array.isArray(node)) return node.map(f => getAbsolutePath(root, f));
    if (node && typeof node === 'object') {
        const out = {};
        for (const k in node) out[k] = treeToAbsolute(node[k], root);
        return out;
    }
    return node;
}

function scheduleTagCacheSave() {
    if (tagCacheSaveTimer) return;
    tagCacheSaveTimer = GLib.timeout_add_seconds(5, () => {
        tagCacheSaveTimer = 0;
        saveTagCache();
        return GLib.SOURCE_REMOVE;
    });
}

function saveTagCache() {
    if (!tagCachePath) return;
    let out = {};
    if (tagCachePath.includes(CACHE_DIR)) {
        // Глобальный кэш — сохраняем с абсолютными путями
        for (const rel in DISK_TAG_CACHE) {
            const abs = getAbsolutePath(activeRootPath, rel);
            out[abs] = DISK_TAG_CACHE[rel];
        }
    } else {
        // Локальный кэш — относительные пути как есть
        out = DISK_TAG_CACHE;
    }
    saveFileUtf8(tagCachePath, JSON.stringify(out, null, 2));
}

const PLAYLIST_DATA = new Map();
const PLAYLIST_SORT = new Map();   // name → { sortId, sortOrder }
let syncingPlaylist = false; let syncTimer = 0;
let playlistLoadGeneration = 0;

function loadPlaylists() {
    PLAYLIST_DATA.clear();
    PLAYLIST_SORT.clear();
    try {
        const [ok, data] = GLib.file_get_contents(PLAYLISTS_FILE);
        if (ok) {
            const obj = JSON.parse(ByteArray.toString(data));
            for (const [name, tracks] of Object.entries(obj)) {
                if (name === '_sort') continue;
                PLAYLIST_DATA.set(name, tracks);
            }
            if (obj._sort) {
                for (const [name, s] of Object.entries(obj._sort)) PLAYLIST_SORT.set(name, s);
            }
        }
    } catch (e) {}
    playlistStore.clear();
    for (const [name] of PLAYLIST_DATA) {
        const iter = getTreeIter(playlistStore.append(null));
        if (iter) playlistStore.set(iter, [0], [name]);
    }
}
function savePlaylists() {
    const obj = {}; let iter = getTreeIter(playlistStore.get_iter_first());
    while (iter) {
        const name = playlistStore.get_value(iter, 0);
        obj[name] = (PLAYLIST_DATA.get(name) || []).map(f => ({ name: f.name, path: f.path }));
        iter = getNextIter(playlistStore, iter);
    }
    if (PLAYLIST_SORT.size > 0) {
        obj._sort = {};
        for (const [name, s] of PLAYLIST_SORT) obj._sort[name] = s;
    }
    saveFileUtf8(PLAYLISTS_FILE, JSON.stringify(obj, null, 2));
}
function syncPlaylistData() {
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (!piter) return;
    const plName = pmodel.get_value(piter, 0);
    const files = [];
    let iter = getTreeIter(playlistContentStore.get_iter_first());
    while (iter) {
        try {
            const name = playlistContentStore.get_value(iter, 0);
            const file = playlistContentStore.get_value(iter, 1);
            const dir = playlistContentStore.get_value(iter, 2);
            const fullPath = dir.endsWith('/') ? dir + file : dir + '/' + file;
            files.push({ name, path: fullPath });
            iter = getTreeIter(playlistContentStore.iter_next(iter));
        } catch (e) {
            break;
        }
    }
    PLAYLIST_DATA.set(plName, files);
    savePlaylists();
}
function scheduleSync() {
    if (syncingPlaylist) return;
    if (syncTimer) { GLib.source_remove(syncTimer); syncTimer = 0; }
    syncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { syncTimer = 0; syncPlaylistData(); return GLib.SOURCE_REMOVE; });
}

function showPlaylistContent(name) {
    playlistLoadGeneration++;
    const gen = playlistLoadGeneration;
    const files = PLAYLIST_DATA.get(name) || [];
    renderPlaylistContent(name, files);
    startPlaylistTagLoading(gen, name, files);
}

function smartCompare(a, b) {
    const re = /^(\d+)/;
    const m1 = a.match(re);
    const m2 = b.match(re);
    if (m1 && m2) {
        const n1 = parseInt(m1[1], 10);
        const n2 = parseInt(m2[1], 10);
        if (n1 !== n2) return n1 - n2;
    } else if (m1) return -1;
    else if (m2) return 1;
    return a.localeCompare(b);
}

function sortRowsInJs(rows, sortId, sortOrder) {
    if (sortId === undefined || sortId < 0) return rows;
    const copy = rows.slice();
    copy.sort((a, b) => {
        let r = 0;
        if (sortId === 1) {
            r = smartCompare(a[1] || '', b[1] || '');
        } else if (sortId === 3) {
            const n1 = parseInt(a[3], 10), n2 = parseInt(b[3], 10);
            if (!isNaN(n1) && !isNaN(n2) && n1 !== n2) r = n1 - n2;
            else if (a[3] === '' && b[3] !== '') r = 1;
            else if (a[3] !== '' && b[3] === '') r = -1;
            else if (a[3] < b[3]) r = -1;
            else if (a[3] > b[3]) r = 1;
        } else if (sortId === 7) {
            if (a[7] < b[7]) r = -1;
            else if (a[7] > b[7]) r = 1;
            else {
                const n1 = parseInt(a[3], 10), n2 = parseInt(b[3], 10);
                if (!isNaN(n1) && !isNaN(n2) && n1 !== n2) r = n1 - n2;
                else if (a[0] < b[0]) r = -1;
                else if (a[0] > b[0]) r = 1;
            }
        } else {
            const v1 = a[sortId] || ''; const v2 = b[sortId] || '';
            if (v1 < v2) r = -1;
            else if (v1 > v2) r = 1;
        }
        return sortOrder === Gtk.SortType.DESCENDING ? -r : r;
    });
    return copy;
}

function _batchInsert(store, sortedRows) {
    store.clear();
    for (const values of sortedRows) {
        try {
            const iter = getTreeIter(store.append());
            if (!iter) continue;
            for (let i = 0; i < values.length; i++) {
                try { store.set_value(iter, i, values[i]); } catch (e) {}
            }
        } catch (e) {}
    }
}

function renderFileList(files) {
    const rows = files.map(f => {
        const t = f.tags || {};
        return [
            t.Name || f.name.replace(/\.mp3$/i, ''),   // 0: Имя
            GLib.path_get_basename(f.path),            // 1: Файл
            GLib.path_get_dirname(f.path) + '/',       // 2: Путь
            t.Track ? String(t.Track) : '',            // 3: №
            t.Year || '',                              // 4: Дата
            t.Genre || '',                             // 5: Жанр
            t.Artist || '',                            // 6: Исполнитель
            t.Album || '',                             // 7: Альбом
            f.path                                     // 8: скрытый полный путь
        ];
    });

    const fc = winConfig.fileCols || { sortId: -1, sortOrder: 0 };
    const sortedRows = sortRowsInJs(rows, fc.sortId, fc.sortOrder);
    _batchInsert(fileListStore, sortedRows);
    updateFileSortIndicators();
}

function renderPlaylistContent(name, files) {
    syncingPlaylist = true;
    try {
        const rows = files.map(f => {
            const rel = getRelativePath(activeRootPath, f.path);
            const t = DISK_TAG_CACHE[rel] || {};
            return [
                t.Name || f.name,                          // 0: Имя
                GLib.path_get_basename(f.path),            // 1: Файл
                GLib.path_get_dirname(f.path) + '/',       // 2: Путь
                t.Track ? String(t.Track) : '',            // 3: №
                t.Year || '',                              // 4: Дата
                t.Genre || '',                             // 5: Жанр
                t.Artist || '',                            // 6: Исполнитель
                t.Album || '',                             // 7: Альбом
                f.path                                     // 8: скрытый полный путь
            ];
        });

        const ps = PLAYLIST_SORT.get(name) || { sortId: -1, sortOrder: 0 };
        const sortedRows = sortRowsInJs(rows, ps.sortId, ps.sortOrder);
        _batchInsert(playlistContentStore, sortedRows);
    } finally {
        syncingPlaylist = false;
    }
    updatePlaylistSortIndicators(name);
}

function updatePlaylistRow(f) {
    let iter = getTreeIter(playlistContentStore.get_iter_first());
    while (iter) {
        try {
            if (playlistContentStore.get_value(iter, 8) === f.path) {
                const t = f.tags || {};
                const displayNum = t.Track ? String(t.Track) : '';
                syncingPlaylist = true;
                try {
                    playlistContentStore.set(iter, [0, 3, 4, 5, 6, 7],
                        [t.Name || f.name, displayNum,
                         t.Year || '', t.Genre || '', t.Artist || '', t.Album || '']);
                } finally { syncingPlaylist = false; }
            }
            iter = getTreeIter(playlistContentStore.iter_next(iter));
        } catch (e) {
            break;
        }
    }
}

function startPlaylistTagLoading(gen, plName, files) {
    if (files.length === 0) return;
    
    const toRead = files.filter(f => {
        const rel = getRelativePath(activeRootPath, f.path);
        return DISK_TAG_CACHE[rel] === undefined;
    });
    
    if (toRead.length === 0) return;

    let completed = 0;
    const total = toRead.length;
    
    for (const f of toRead) {
        const file = Gio.File.new_for_path(f.path);
        file.load_contents_async(null, (src, res) => {
            if (gen !== playlistLoadGeneration) return;
            const rel = getRelativePath(activeRootPath, f.path);
            try {
                const [ok, contents] = src.load_contents_finish(res);
                if (ok) {
                    const bytes = new Uint8Array(contents);
                    f.tags = Scanner.parseTagsFromBytes(bytes);
                    if (f.tags === null) f.tags = {};
                } else {
                    f.tags = {};
                }
            } catch(e) {
                f.tags = {};
            }
            DISK_TAG_CACHE[rel] = f.tags;
            
            updatePlaylistRow(f); // Мгновенное обновление строки

            completed++;
            if (completed === total) {
                if (gen === playlistLoadGeneration) {
                    renderPlaylistContent(plName, files);
                    scheduleSync();
                }
            }
        });
    }
}

playlistContentStore.connect('row-inserted', scheduleSync); playlistContentStore.connect('row-deleted', scheduleSync);
playlistContentStore.connect('row-changed', scheduleSync); playlistContentStore.connect('rows-reordered', scheduleSync);

function addToPlaylist(plName, trackObj) {
    const files = PLAYLIST_DATA.get(plName) || [];
    files.push({ name: trackObj.name || GLib.path_get_basename(trackObj.path), path: trackObj.path });
    PLAYLIST_DATA.set(plName, files);
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (piter && pmodel.get_value(piter, 0) === plName) showPlaylistContent(plName);
    savePlaylists();
}
function buildAddToPlaylistSubmenu(trackObjs) {
    const sub = new Gtk.Menu();
    if (PLAYLIST_DATA.size === 0) {
        const empty = new Gtk.MenuItem({ label: '(нет плейлистов)' }); empty.set_sensitive(false); sub.append(empty);
    } else {
        for (const [plName] of PLAYLIST_DATA) {
            const item = new Gtk.MenuItem({ label: plName });
            item.connect('activate', () => { for (const t of trackObjs) addToPlaylist(plName, t); });
            sub.append(item);
        }
    }
    sub.show_all(); return sub;
}
function showAddToPlaylistMenu(button, getTracksFn) {
    const tracks = getTracksFn(); if (!tracks || tracks.length === 0) return;
    const menu = new Gtk.Menu();
    if (PLAYLIST_DATA.size === 0) {
        const empty = new Gtk.MenuItem({ label: '(нет плейлистов)' }); empty.set_sensitive(false); menu.append(empty);
    } else {
        for (const [plName] of PLAYLIST_DATA) {
            const item = new Gtk.MenuItem({ label: plName });
            item.connect('activate', () => { for (const t of tracks) addToPlaylist(plName, t); });
            menu.append(item);
        }
    }
    menu.show_all(); menu.popup_at_widget(button, Gdk.Gravity.SOUTH_WEST, Gdk.Gravity.NORTH_WEST, null);
}
function exportPlaylistToM3U(plName) {
    const dialog = new Gtk.FileChooserDialog({ title: 'Экспорт плейлиста', transient_for: win, action: Gtk.FileChooserAction.SAVE });
    dialog.add_button('Отмена', Gtk.ResponseType.CANCEL); dialog.add_button('Сохранить', Gtk.ResponseType.OK);
    dialog.set_current_name(plName + '.m3u8');
    dialog.connect('response', (d, resp) => {
        if (resp === Gtk.ResponseType.OK) {
            const filePath = d.get_filename();
            const tracks = getPlaylistTracksInDisplayOrder(plName);
            let content = '#EXTM3U\n';
            for (const t of tracks) content += t.path + '\n';
            try { GLib.file_set_contents(filePath, content); } catch (e) {}
        }
        d.destroy();
    });
    dialog.show_all();
}

/* ============================================================
 *  Управление плеером
 * ============================================================ */
function playFile(filePath) {
    const cmdTemplate = getPlayCommand(); if (!cmdTemplate) { console.log(`[player] нет команды Play: ${filePath}`); return; }
    const cmd = cmdTemplate.replace(/%f/g, `"${filePath}"`); try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}
function enqueueFile(filePath) {
    const cmdTemplate = getEnqueueCommand(); if (!cmdTemplate) { console.log(`[player] нет команды Enqueue: ${filePath}`); return; }
    const cmd = cmdTemplate.replace(/%f/g, `"${filePath}"`); try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}
function playFilesAsM3U(tracks, isEnqueue) {
    if (tracks.length === 0) return;
    const tmpPath = GLib.build_filenamev([GLib.get_tmp_dir(), `mp3-browser-${Date.now()}.m3u8`]);
    let content = '#EXTM3U\n'; for (const t of tracks) content += t.path + '\n';
    GLib.file_set_contents(tmpPath, content);
    if (isEnqueue) enqueueFile(tmpPath); else playFile(tmpPath);
}
function playTracks(tracks, isEnqueue) {
    if (tracks.length === 0) return;
    if (tracks.length === 1) { if (isEnqueue) enqueueFile(tracks[0].path); else playFile(tracks[0].path); return; }
    if (getMultipleM3U()) playFilesAsM3U(tracks, isEnqueue);
    else {
        const cmdTemplate = isEnqueue ? getEnqueueCommand() : getPlayCommand(); if (!cmdTemplate) return;
        const paths = tracks.map(t => `"${t.path}"`).join(' '); const cmd = cmdTemplate.replace(/%f/g, paths);
        try { GLib.spawn_command_line_async(cmd); } catch (e) {}
    }
}

/* ============================================================
 *  Асинхронное сканирование (с умным кэшем)
 * ============================================================ */
const SCAN_LOG_FILE = GLib.build_filenamev([CACHE_DIR, 'scan.log']);
let scanLogHandle = null;
function scanLogOpen() { try { scanLogHandle = Gio.File.new_for_path(SCAN_LOG_FILE).append_to(Gio.FileCreateFlags.NONE, null); } catch (e) { scanLogHandle = null; } }
function scanLogClose() { if (scanLogHandle) { try { scanLogHandle.close(null); } catch (e) {} scanLogHandle = null; } }
function scanLog(msg) { console.log(`[scan] ${msg}`); if (scanLogHandle) { try { scanLogHandle.write_all(`${new Date().toISOString()} ${msg}\n`, null); } catch (e) {} } }

async function startScan(rootPath) {
    scanGeneration++;
    const gen = scanGeneration; isScanning = true;
    nodesByPath = new Map(); treeStore.clear(); fileListStore.clear(); loadGeneration++;

    activeRootPath = rootPath;
    if (activeRootPath.endsWith('/')) activeRootPath = activeRootPath.slice(0, -1);

    // Проверка прав и свободного места
    isRootWritable = checkWriteAccess(activeRootPath);
    const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, activeRootPath, -1);
    
    const localCachePath = GLib.build_filenamev([activeRootPath, 'mp3-file-cache.json']);
    const localTagPath   = GLib.build_filenamev([activeRootPath, 'mp3-tag-cache.json']);
    const globalCachePath = GLib.build_filenamev([CACHE_DIR, `${md5}-mp3-file-cache.json`]);
    const globalTagPath   = GLib.build_filenamev([CACHE_DIR, `${md5}-mp3-tag-cache.json`]);

    // Приоритет загрузки: сначала локальный файл, потом глобальный, иначе выбор по правам записи
    if (GLib.file_test(localCachePath, GLib.FileTest.EXISTS)) {
        fileCachePath = localCachePath;
    } else if (GLib.file_test(globalCachePath, GLib.FileTest.EXISTS)) {
        fileCachePath = globalCachePath;
    } else {
        fileCachePath = isRootWritable ? localCachePath : globalCachePath;
    }

    if (GLib.file_test(localTagPath, GLib.FileTest.EXISTS)) {
        tagCachePath = localTagPath;
    } else if (GLib.file_test(globalTagPath, GLib.FileTest.EXISTS)) {
        tagCachePath = globalTagPath;
    } else {
        tagCachePath = isRootWritable ? localTagPath : globalTagPath;
    }

    // Загрузка кэша тегов
    DISK_TAG_CACHE = {};
    if (GLib.file_test(tagCachePath, GLib.FileTest.EXISTS)) {
        try {
            const [ok, data] = GLib.file_get_contents(tagCachePath);
            if (ok) {
                const raw = JSON.parse(ByteArray.toString(data));
                if (tagCachePath === globalTagPath) {
                    // Если это глобальный кэш, там абсолютные пути. Переводим в относительные.
                    for (const abs in raw) {
                        const rel = getRelativePath(activeRootPath, abs);
                        DISK_TAG_CACHE[rel] = raw[abs];
                    }
                } else {
                    DISK_TAG_CACHE = raw;
                }
            }
        } catch(e) {}
    }

    const rootNode = { name: GLib.path_get_basename(activeRootPath), path: activeRootPath, fileNames: [], children: [] };
    nodesByPath.set(activeRootPath, rootNode);

    let treeData = null;
    let loadedFromCache = false;

    // Попытка загрузить дерево из кэша
    if (GLib.file_test(fileCachePath, GLib.FileTest.EXISTS)) {
        try {
            const [ok, data] = GLib.file_get_contents(fileCachePath);
            if (ok) {
                treeData = JSON.parse(ByteArray.toString(data));
                
                // Если JSON содержит обёртку от `scan` ({ "Music": [...] }), разворачиваем её
                if (treeData && typeof treeData === 'object' && !Array.isArray(treeData)) {
                    const keys = Object.keys(treeData);
                    if (keys.length === 1 && (keys[0] === GLib.path_get_basename(activeRootPath) || keys[0] === '.')) {
                        treeData = treeData[keys[0]];
                    }
                }
                
                treeData = treeToAbsolute(treeData, activeRootPath);
                loadedFromCache = true;
            }
        } catch(e) { loadedFromCache = false; }
    }

    progress.set_no_show_all(false); progress.show(); progress.pulse();
    statusbar.push(1, loadedFromCache ? `Загружено из кэша: ${activeRootPath}` : `Сканирование каталогов: ${activeRootPath}`);

    try {
        if (!treeData) {
            const startTime = Date.now(); const logEvery = getScanLogEvery();
            scanLogOpen(); scanLog(`START scan ${activeRootPath}`);
            treeData = await Scanner.scanDirectory(activeRootPath, (count) => {
                if (count % logEvery === 0) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    progress.pulse(); statusbar.push(1, `Сканирование: ${count} файлов, ${elapsed}s`);
                    scanLog(`PROGRESS: ${count} files, ${elapsed}s`);
                }
            });
            scanLog(`DONE: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            scanLogClose();

            if (treeData) {
                if (fileCachePath === localCachePath) {
                    // Локальный кэш — относительные пути
                    const relTree = treeToRelative(treeData, activeRootPath);
                    try { GLib.file_set_contents(fileCachePath, JSON.stringify(relTree, null, 2)); } catch(e) {}
                } else {
                    // Глобальный кэш — абсолютные пути
                    try { GLib.file_set_contents(fileCachePath, JSON.stringify(treeData, null, 2)); } catch(e) {}
                }
            }
        }

        function buildNodeFromData(data, name, path) {
            const node = { name, path, fileNames: [], children: [] };
            nodesByPath.set(path, node);
            if (Array.isArray(data)) {
                for (const fPath of data) {
                    let tags = null;
                    const rel = getRelativePath(activeRootPath, fPath);
                    if (DISK_TAG_CACHE[rel] !== undefined) tags = DISK_TAG_CACHE[rel];
                    node.fileNames.push({ name: GLib.path_get_basename(fPath), path: fPath, size: 0, tags });
                }
            } else if (data && typeof data === 'object') {
                if (data['.']) {
                    for (const fPath of data['.']) {
                        let tags = null;
                        const rel = getRelativePath(activeRootPath, fPath);
                        if (DISK_TAG_CACHE[rel] && Object.keys(DISK_TAG_CACHE[rel]).length > 0) tags = DISK_TAG_CACHE[rel];
                        node.fileNames.push({ name: GLib.path_get_basename(fPath), path: fPath, size: 0, tags });
                    }
                }
                for (const k in data) {
                    if (k === '.') continue;
                    const subPath = GLib.build_filenamev([path, k]);
                    node.children.push(buildNodeFromData(data[k], k, subPath));
                }
            }
            return node;
        }

        if (treeData) {
            const newRoot = buildNodeFromData(treeData, rootNode.name, activeRootPath);
            nodesByPath.set(activeRootPath, newRoot);
            rootNode.fileNames = newRoot.fileNames; rootNode.children = newRoot.children;
        }
        
        buildTreeUI(rootNode, null); 
        treeStore.set_sort_column_id(TC_NAME, Gtk.SortType.ASCENDING); // Сортировка по алфавиту
        treeView.expand_row(Gtk.TreePath.new_from_indices([0]), false); 
        treeView.get_selection().unselect_all();
        statusbar.push(1, `Готово: ${activeRootPath}`);
    } catch (e) {
        statusbar.push(1, `Ошибка: ${e.message}`); console.error(e);
    } finally {
        isScanning = false; progress.hide(); progress.set_no_show_all(true);
    }
}

function buildTreeUI(node, parentIter) {
    const iter = treeStore.append(parentIter);
    treeStore.set(iter, [TC_NAME, TC_PATH], [node.name, node.path]);
    for (const child of node.children) buildTreeUI(child, iter);
    return iter;
}
function countSubtreeFiles(node) {
    let t = node.fileNames.length; for (const c of node.children) t += countSubtreeFiles(c); return t;
}
function collectFilesFromNode(node, out) {
    for (const f of node.fileNames) out.push(f);
    for (const c of node.children) collectFilesFromNode(c, out);
    return out;
}

function updateFileRow(f) {
    let iter = getTreeIter(fileListStore.get_iter_first());
    while (iter) {
        try {
            if (fileListStore.get_value(iter, 8) === f.path) {
                const t = f.tags || {};
                const displayNum = t.Track ? String(t.Track) : '';
                fileListStore.set(iter, [0, 3, 4, 5, 6, 7],
                    [t.Name || f.name.replace(/\.mp3$/i, ''), displayNum,
                     t.Year || '', t.Genre || '', t.Artist || '', t.Album || '']);
                break;
            }
            iter = getTreeIter(fileListStore.iter_next(iter));
        } catch (e) {
            break;
        }
    }
}

function populateFileListFromNodes(nodes) {
    loadGeneration++;
    const gen = loadGeneration;
    fileListStore.clear();

    const allFiles = [];
    const seenPaths = new Set();
    const limit = getMaxTrackCount();
    let limitHit = false;

    for (const node of nodes) {
        const subtreeCount = countSubtreeFiles(node);
        const showSubtree = subtreeCount <= limit;
        if (!showSubtree) limitHit = true;
        const files = [];
        if (showSubtree) collectFilesFromNode(node, files); else files.push(...node.fileNames);
        for (const f of files) { if (!seenPaths.has(f.path)) { seenPaths.add(f.path); allFiles.push(f); } }
    }

    for (const f of allFiles) {
        if (f.tags === null || f.tags === undefined) {
            const rel = getRelativePath(activeRootPath, f.path);
            if (DISK_TAG_CACHE[rel] !== undefined) f.tags = DISK_TAG_CACHE[rel];
        }
    }

    if (limitHit) statusbar.push(1, `Некоторые каталоги превышают лимит в ${limit} файлов — показаны только они сами`);
    renderFileList(allFiles);

    const toRead = allFiles.filter(f => f.tags === null || f.tags === undefined);
    if (toRead.length === 0) {
        if (!limitHit) statusbar.push(1, `${allFiles.length} файлов выбрано`);
        return;
    }

    const total = toRead.length;
    let completed = 0;
    progress.set_no_show_all(false); progress.show(); progress.set_fraction(0);
    statusbar.push(1, `Чтение ID3: 0/${total}`);

    for (const f of toRead) {
        const file = Gio.File.new_for_path(f.path);
        file.load_contents_async(null, (src, res) => {
            if (gen !== loadGeneration) return;
            const rel = getRelativePath(activeRootPath, f.path);
            
            try {
                const [ok, contents] = src.load_contents_finish(res);
                if (ok) {
                    const bytes = new Uint8Array(contents);
                    f.tags = Scanner.parseTagsFromBytes(bytes);
                    if (f.tags === null) f.tags = {};
                } else {
                    f.tags = {};
                }
            } catch (e) {
                f.tags = {};
            }
            
            DISK_TAG_CACHE[rel] = f.tags;
            updateFileRow(f); // Мгновенное обновление строки

            completed++;
            progress.set_fraction(completed / total);
            statusbar.push(1, `Чтение ID3: ${completed}/${total}`);

            if (completed === total) {
                progress.hide(); progress.set_no_show_all(true);
                scheduleTagCacheSave();
                renderFileList(allFiles); // Полная перерисовка с готовыми тегами
                statusbar.push(1, `${allFiles.length} файлов показано`);
            }
        });
    }
}

function refreshFileListFromSelection() {
    const nodes = [];
    treeView.get_selection().selected_foreach((model, path, iter) => {
        const tcPath = model.get_value(iter, TC_PATH); const node = nodesByPath.get(tcPath);
        if (node) nodes.push(node);
    });
    populateFileListFromNodes(nodes);
}

function collectAllFiles(node) {
    const out = [];
    for (const f of collectFilesFromNode(node, [])) {
        const t = f.tags || {};
        out.push({ name: t.Name || f.name.replace(/\.mp3$/i, ''), path: f.path });
    }
    return out;
}
function isShiftPressed() {
    try {
        const event = Gtk.get_current_event();
        if (!event) return false;
        let state = 0;
        if (typeof event.get_state === 'function') state = event.get_state();
        else if (typeof event.get_modifier_state === 'function') state = event.get_modifier_state();
        else if (typeof event.state === 'number') state = event.state;
        return (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
    } catch (e) { return false; }
}

function doReload() {
    // apply: удаляем только кэш дерева, теги сохраняются
    const idx = combo.get_active(); if (idx < 0) return;
    if (isRootWritable) {
        try { GLib.unlink(fileCachePath); } catch (e) {}
    } else {
        const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, ROOTS[idx], -1);
        try { GLib.unlink(GLib.build_filenamev([CACHE_DIR, `${md5}-mp3-file-cache.json`])); } catch (e) {}
    }
    startScan(ROOTS[idx]);
}

function doForceReload() {
    const idx = combo.get_active(); if (idx < 0) return;
    // Считаем количество файлов
    let totalFiles = 0;
    for (const [, node] of nodesByPath) totalFiles += node.fileNames.length;
    if (totalFiles === 0 && GLib.file_test(fileCachePath, GLib.FileTest.EXISTS)) {
        try {
            const [ok, data] = GLib.file_get_contents(fileCachePath);
            if (ok) {
                const tree = JSON.parse(ByteArray.toString(data));
                (function count(n) {
                    if (Array.isArray(n)) totalFiles += n.length;
                    else if (n && typeof n === 'object') for (const k in n) count(n[k]);
                })(tree);
            }
        } catch (e) {}
    }
    if (totalFiles > 1000) {
        const dialog = new Gtk.MessageDialog({
            transient_for: win, modal: true,
            message_type: Gtk.MessageType.WARNING,
            buttons: Gtk.ButtonsType.YES_NO,
            text: `Перечитать ID3 всех файлов (${totalFiles})?`
        });
        dialog.format_secondary_text('Это может занять продолжительное время. Продолжить?');
        dialog.connect('response', (d, resp) => {
            d.destroy();
            if (resp === Gtk.ResponseType.YES) _doForceReloadImpl(idx);
        });
        dialog.show_all();
        return;
    }
    _doForceReloadImpl(idx);
}

function _doForceReloadImpl(idx) {
    if (isRootWritable) {
        try { GLib.unlink(fileCachePath); } catch (e) {}
        try { GLib.unlink(tagCachePath); } catch (e) {}
    } else {
        const md5 = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, ROOTS[idx], -1);
        try { GLib.unlink(GLib.build_filenamev([CACHE_DIR, `${md5}-mp3-file-cache.json`])); } catch (e) {}
        try { GLib.unlink(GLib.build_filenamev([CACHE_DIR, `${md5}-mp3-tag-cache.json`])); } catch (e) {}
    }
    DISK_TAG_CACHE = {};
    startScan(ROOTS[idx]).then(() => readAllTagsAsync()).catch(e => console.error(e));
}

function readAllTagsAsync() {
    const allFiles = [];
    for (const [, node] of nodesByPath) {
        for (const f of node.fileNames) {
            const rel = getRelativePath(activeRootPath, f.path);
            if (DISK_TAG_CACHE[rel] === undefined) allFiles.push(f);
        }
    }
    if (allFiles.length === 0) { statusbar.push(1, 'Все теги уже прочитаны'); return; }

    const total = allFiles.length;
    let completed = 0, nextToStart = 0, inFlight = 0;
    const MAX_CONCURRENT = 20;
    progress.set_no_show_all(false); progress.show(); progress.set_fraction(0);
    statusbar.push(1, `Чтение ID3: 0/${total}`);

    function startMore() {
        while (inFlight < MAX_CONCURRENT && nextToStart < total) {
            const f = allFiles[nextToStart++];
            inFlight++;
            Gio.File.new_for_path(f.path).load_contents_async(null, (src, res) => {
                inFlight--;
                const rel = getRelativePath(activeRootPath, f.path);
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    if (ok) {
                        f.tags = Scanner.parseTagsFromBytes(new Uint8Array(contents)) || {};
                    } else f.tags = {};
                } catch (e) { f.tags = {}; }
                DISK_TAG_CACHE[rel] = f.tags;
                completed++;
                if (completed % 100 === 0 || completed === total) {
                    progress.set_fraction(completed / total);
                    statusbar.push(1, `Чтение ID3: ${completed}/${total}`);
                }
                if (completed === total) {
                    progress.hide(); progress.set_no_show_all(true);
                    scheduleTagCacheSave();
                    statusbar.push(1, `Прочитано ${total} тегов`);
                    refreshFileListFromSelection();
                } else {
                    startMore();
                }
            });
        }
    }
    startMore();
}

/* ============================================================
 *  Обработчики интерфейса
 * ============================================================ */
treeView.get_selection().connect('changed', () => { refreshFileListFromSelection(); });

fileListTree.connect('row-activated', (w, path) => {
    const tracks = getSelectedTracks(w, fileListStore);
    if (tracks.length > 0) playTracks(tracks, getDefaultAction() === 'enqueue');
});
fileListTree.connect('key-press-event', (w, event) => {
    if (evtKeyval(event) === Gdk.KEY_Return || evtKeyval(event) === Gdk.KEY_KP_Enter) {
        const tracks = getSelectedTracks(w, fileListStore);
        if (tracks.length > 0) { playTracks(tracks, getDefaultAction() === 'enqueue'); return true; }
    }
    return false;
});

playlistContentTree.connect('row-activated', (w, path) => {
    const tracks = getSelectedTracks(w, playlistContentStore);
    if (tracks.length > 0) playTracks(tracks, getDefaultAction() === 'enqueue');
});
playlistContentTree.connect('key-press-event', (w, event) => {
    if (evtKeyval(event) === Gdk.KEY_Return || evtKeyval(event) === Gdk.KEY_KP_Enter) {
        const tracks = getSelectedTracks(w, playlistContentStore);
        if (tracks.length > 0) { playTracks(tracks, getDefaultAction() === 'enqueue'); return true; }
    }
    return false;
});

playlistTree.get_selection().connect('changed', () => {
    const [model, iter] = getSelected(playlistTree.get_selection());
    if (!iter) { syncingPlaylist = true; try { playlistContentStore.clear(); } finally { syncingPlaylist = false; } return; }
    showPlaylistContent(model.get_value(iter, 0));
});

btnFilePlay.connect('clicked', () => { const t = getSelectedTracks(fileListTree, fileListStore); if (t.length > 0) playTracks(t, false); });
btnFileEnq.connect('clicked', () => { const t = getSelectedTracks(fileListTree, fileListStore); if (t.length > 0) playTracks(t, true); });
btnFileAdd.connect('clicked', (btn) => { showAddToPlaylistMenu(btn, () => getSelectedTracks(fileListTree, fileListStore)); });

btnPlPlay.connect('clicked', () => { const t = getSelectedTracks(playlistContentTree, playlistContentStore); if (t.length > 0) playTracks(t, false); });
btnPlEnq.connect('clicked', () => { const t = getSelectedTracks(playlistContentTree, playlistContentStore); if (t.length > 0) playTracks(t, true); });
btnPlAdd.connect('clicked', (btn) => { showAddToPlaylistMenu(btn, () => getSelectedTracks(playlistContentTree, playlistContentStore)); });
btnPlDel.connect('clicked', () => {
    const tracks = getSelectedTracks(playlistContentTree, playlistContentStore);
    if (tracks.length === 0) return;
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (piter) {
        const plName = pmodel.get_value(piter, 0);
        let files = PLAYLIST_DATA.get(plName) || [];
        for (const t of tracks) { const pos = files.findIndex(f => f.path === t.path); if (pos >= 0) files.splice(pos, 1); }
        PLAYLIST_DATA.set(plName, files);
        showPlaylistContent(plName);
        savePlaylists();
    }
});

treeView.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event); const path = getHitPath(w, ex, ey);
    if (!path) return false;
    const sel = w.get_selection();
    if (!sel.path_is_selected(path)) { sel.unselect_all(); sel.select_path(path); }
    // Берем все файлы прямо из таблицы (в том порядке, в котором они отображаются)
    const files = getAllTracksFromFileList();
    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: `Проиграть всё (${files.length})` }); miPlay.set_sensitive(files.length > 0); miPlay.connect('activate', () => playTracks(files, false)); menu.append(miPlay);
    const miEnq = new Gtk.MenuItem({ label: `Добавить всё в очередь (${files.length})` }); miEnq.set_sensitive(files.length > 0); miEnq.connect('activate', () => playTracks(files, true)); menu.append(miEnq);
    menu.append(new Gtk.SeparatorMenuItem());
    const miAdd = new Gtk.MenuItem({ label: 'Добавить всё в плейлист' }); miAdd.set_sensitive(files.length > 0); miAdd.set_submenu(buildAddToPlaylistSubmenu(files)); menu.append(miAdd);
    menu.append(new Gtk.SeparatorMenuItem());
    const miRl = new Gtk.MenuItem({ label: 'Обновить' }); miRl.connect('activate', () => doReload()); menu.append(miRl);
    popupMenuAtPointer(menu); return true;
});

fileListTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event); const path = getHitPath(w, ex, ey);
    if (!path) return false;
    const sel = w.get_selection();
    if (!sel.path_is_selected(path)) { sel.unselect_all(); sel.select_path(path); }
    const tracks = getSelectedTracks(w, fileListStore);
    if (tracks.length === 0) return false;
    const menu = new Gtk.Menu();
    const miFileSort = new Gtk.MenuItem({ label: 'Сортировать по' });
    const fileSortSub = new Gtk.Menu();
    FILE_COLS.forEach((title, idx) => {
        const it = new Gtk.MenuItem({ label: title });
        it.connect('activate', () => {
            if (!winConfig.fileCols) winConfig.fileCols = { sortId: -1, sortOrder: 0 };
            winConfig.fileCols.sortId = idx;
            winConfig.fileCols.sortOrder = Gtk.SortType.ASCENDING;
            updateFileSortIndicators();
            refreshFileListFromSelection();
        });
        fileSortSub.append(it);
    });
    fileSortSub.append(new Gtk.SeparatorMenuItem());
    const miFileSortNone = new Gtk.MenuItem({ label: '(без сортировки)' });
    miFileSortNone.connect('activate', () => {
        if (!winConfig.fileCols) winConfig.fileCols = { sortId: -1, sortOrder: 0 };
        winConfig.fileCols.sortId = -1;
        updateFileSortIndicators();
        refreshFileListFromSelection();
    });
    fileSortSub.append(miFileSortNone);
    miFileSort.set_submenu(fileSortSub);
    menu.append(miFileSort);
    menu.append(new Gtk.SeparatorMenuItem());
    const miPlay = new Gtk.MenuItem({ label: tracks.length > 1 ? `Проиграть выделенные (${tracks.length})` : 'Проиграть' }); miPlay.connect('activate', () => playTracks(tracks, false)); menu.append(miPlay);
    const miEnq = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить в очередь выделенные (${tracks.length})` : 'Добавить в очередь' }); miEnq.connect('activate', () => playTracks(tracks, true)); menu.append(miEnq);
    menu.append(new Gtk.SeparatorMenuItem());
    const miAdd = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить выделенные в плейлист (${tracks.length})` : 'Добавить в плейлист' }); miAdd.set_submenu(buildAddToPlaylistSubmenu(tracks)); menu.append(miAdd);
    popupMenuAtPointer(menu); return true;
});

playlistContentTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event); const path = getHitPath(w, ex, ey);
    if (!path) return false;
    const sel = w.get_selection();
    if (!sel.path_is_selected(path)) { sel.unselect_all(); sel.select_path(path); }
    const tracks = getSelectedTracks(w, playlistContentStore);
    if (tracks.length === 0) return false;
    const menu = new Gtk.Menu();
    const miSort = new Gtk.MenuItem({ label: 'Сортировать по' });
    const sortSub = new Gtk.Menu();
    FILE_COLS.forEach((title, idx) => {
        const it = new Gtk.MenuItem({ label: title });
        it.connect('activate', () => {
            const [pmodel, piter] = getSelected(playlistTree.get_selection());
            if (!piter) return;
            const plName = pmodel.get_value(piter, 0);
            PLAYLIST_SORT.set(plName, { sortId: idx, sortOrder: Gtk.SortType.ASCENDING });
            showPlaylistContent(plName);
            savePlaylists();
        });
        sortSub.append(it);
    });
    sortSub.append(new Gtk.SeparatorMenuItem());
    const miSortNone = new Gtk.MenuItem({ label: '(без сортировки)' });
    miSortNone.connect('activate', () => {
        const [pmodel, piter] = getSelected(playlistTree.get_selection());
        if (!piter) return;
        const plName = pmodel.get_value(piter, 0);
        PLAYLIST_SORT.delete(plName);
        showPlaylistContent(plName);
        savePlaylists();
    });
    sortSub.append(miSortNone);
    miSort.set_submenu(sortSub);
    menu.append(miSort);
    menu.append(new Gtk.SeparatorMenuItem());
    const miPlay = new Gtk.MenuItem({ label: tracks.length > 1 ? `Проиграть выделенные (${tracks.length})` : 'Проиграть' }); miPlay.connect('activate', () => playTracks(tracks, false)); menu.append(miPlay);
    const miEnq = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить в очередь выделенные (${tracks.length})` : 'Добавить в очередь' }); miEnq.connect('activate', () => playTracks(tracks, true)); menu.append(miEnq);
    menu.append(new Gtk.SeparatorMenuItem());
    const miAdd = new Gtk.MenuItem({ label: tracks.length > 1 ? `Добавить выделенные в плейлист (${tracks.length})` : 'Добавить в плейлист' }); miAdd.set_submenu(buildAddToPlaylistSubmenu(tracks)); menu.append(miAdd);
    menu.append(new Gtk.SeparatorMenuItem());
    const miDel = new Gtk.MenuItem({ label: tracks.length > 1 ? `Удалить выделенные (${tracks.length})` : 'Удалить из плейлиста' });
    miDel.connect('activate', () => {
        const [pmodel, piter] = getSelected(playlistTree.get_selection());
        if (piter) {
            const plName = pmodel.get_value(piter, 0);
            let files = PLAYLIST_DATA.get(plName) || [];
            for (const t of tracks) { const pos = files.findIndex(f => f.path === t.path); if (pos >= 0) files.splice(pos, 1); }
            PLAYLIST_DATA.set(plName, files);
            showPlaylistContent(plName);
            savePlaylists();
        }
    });
    menu.append(miDel);
    popupMenuAtPointer(menu); return true;
});

playlistTree.connect('button-press-event', (w, event) => {
    if (evtButton(event) !== 3) return false;
    const [ex, ey] = evtXY(event); const path = getHitPath(w, ex, ey);
    if (!path) return false;
    w.get_selection().select_path(path);
    const [model, iter] = getSelected(w.get_selection());
    if (!iter) return false;
    const plName = model.get_value(iter, 0);
    const files = getPlaylistTracksInDisplayOrder(plName);
    const idx = model.get_path(iter).get_indices()[0];
    const count = model.iter_n_children(null);
    const menu = new Gtk.Menu();
    const miPlay = new Gtk.MenuItem({ label: `Проиграть (${files.length})` }); miPlay.set_sensitive(files.length > 0); miPlay.connect('activate', () => playTracks(files, false)); menu.append(miPlay);
    const miEnq = new Gtk.MenuItem({ label: `Добавить в очередь (${files.length})` }); miEnq.set_sensitive(files.length > 0); miEnq.connect('activate', () => playTracks(files, true)); menu.append(miEnq);
    const miExp = new Gtk.MenuItem({ label: 'Экспорт в M3U8...' }); miExp.set_sensitive(files.length > 0); miExp.connect('activate', () => exportPlaylistToM3U(plName)); menu.append(miExp);
    menu.append(new Gtk.SeparatorMenuItem());
    const miRen = new Gtk.MenuItem({ label: 'Переименовать' }); miRen.connect('activate', () => doRenamePlaylist(model, iter)); menu.append(miRen);
    const miDel = new Gtk.MenuItem({ label: 'Удалить' }); miDel.connect('activate', () => doDeletePlaylist()); menu.append(miDel);
    menu.append(new Gtk.SeparatorMenuItem());
    const miUp = new Gtk.MenuItem({ label: 'Поднять выше' }); miUp.set_sensitive(idx > 0); miUp.connect('activate', () => movePlaylist(-1)); menu.append(miUp);
    const miDown = new Gtk.MenuItem({ label: 'Опустить ниже' }); miDown.set_sensitive(idx < count - 1); miDown.connect('activate', () => movePlaylist(1)); menu.append(miDown);
    popupMenuAtPointer(menu); return true;
});

playlistContentTree.connect('drag-data-received', (w, ctx, x, y, sel, info, time) => {
    if (Gtk.drag_get_source_widget(ctx) === w) return;
    const text = sel.get_text();
    if (!text) { Gtk.drag_finish(ctx, false, false, time); return; }
    const [pmodel, piter] = getSelected(playlistTree.get_selection());
    if (!piter) { Gtk.drag_finish(ctx, false, false, time); return; }
    const plName = pmodel.get_value(piter, 0);

    let tracks = [];
    try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.tracks && Array.isArray(parsed.tracks)) tracks = parsed.tracks;
        else if (Array.isArray(parsed)) tracks = parsed;
        else if (parsed && parsed.path) tracks = [parsed];
    } catch (e) {
        tracks = [{ name: GLib.path_get_basename(text), path: text }];
    }
    for (const t of tracks) if (t && t.path) addToPlaylist(plName, t);
    Gtk.drag_finish(ctx, true, false, time);
});

function doRenamePlaylist(model, iter) {
    const oldName = model.get_value(iter, 0);
    const dialog = new Gtk.Dialog({ title: 'Переименовать плейлист', transient_for: win, modal: true });
    dialog.add_button('Отмена', Gtk.ResponseType.CANCEL); dialog.add_button('ОК', Gtk.ResponseType.OK); dialog.set_default_response(Gtk.ResponseType.OK);
    const entry = new Gtk.Entry({ text: oldName }); entry.set_activates_default(true); dialog.get_content_area().add(entry); dialog.show_all();
    dialog.connect('response', (d, resp) => {
        if (resp === Gtk.ResponseType.OK) {
            const newName = entry.get_text().trim();
            if (newName && newName !== oldName && !PLAYLIST_DATA.has(newName)) {
                const files = PLAYLIST_DATA.get(oldName) || []; PLAYLIST_DATA.delete(oldName); PLAYLIST_DATA.set(newName, files);
                model.set_value(iter, 0, newName); savePlaylists();
            }
            if (PLAYLIST_SORT.has(oldName)) {
                PLAYLIST_SORT.set(newName, PLAYLIST_SORT.get(oldName));
                PLAYLIST_SORT.delete(oldName);
            }
        }
        d.destroy();
    });
}
function doDeletePlaylist() {
    const [model, iter] = getSelected(playlistTree.get_selection());
    if (!iter) return;
    const name = model.get_value(iter, 0); PLAYLIST_DATA.delete(name); playlistStore.remove(iter); savePlaylists(); PLAYLIST_SORT.delete(name);
}
function doAddPlaylist() {
    const base = 'Новый плейлист'; let unique = base, i = 1;
    while (PLAYLIST_DATA.has(unique)) unique = `${base} ${++i}`;
    PLAYLIST_DATA.set(unique, []);
    PLAYLIST_SORT.set(unique, { sortId: -1, sortOrder: 0 });
    const iter = getTreeIter(playlistStore.append(null));
    if (iter) {
        playlistStore.set(iter, [0], [unique]);
        playlistTree.get_selection().select_iter(iter);
    }
    savePlaylists();
}
function movePlaylist(delta) {
    const [model, iter] = getSelected(playlistTree.get_selection()); if (!iter) return;
    const idx = model.get_path(iter).get_indices()[0]; const newIdx = idx + delta; const count = model.iter_n_children(null);
    if (newIdx < 0 || newIdx >= count) return;
    const other = getTreeIter(model.iter_nth_child(null, newIdx)); if (!other) return;
    const nameA = model.get_value(iter, 0); const nameB = model.get_value(other, 0);
    model.set_value(iter, 0, nameB); model.set_value(other, 0, nameA);
    const newIter = getTreeIter(model.iter_nth_child(null, newIdx)); if (newIter) playlistTree.get_selection().select_iter(newIter);
    savePlaylists();
}

playlistTree.connect('row-activated', (w, path) => { const [model, iter] = getSelected(w.get_selection()); if (iter) doRenamePlaylist(model, iter); });
btnAdd.connect('clicked', () => doAddPlaylist()); btnDel.connect('clicked', () => doDeletePlaylist());
btnUp.connect('clicked', () => movePlaylist(-1)); btnDown.connect('clicked', () => movePlaylist(1));

let filterDebounce = null;
function scheduleFilter() {
    if (filterDebounce) { GLib.source_remove(filterDebounce); filterDebounce = null; }
    filterDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => { filterDebounce = null; applyFilter(); return GLib.SOURCE_REMOVE; });
}
function applyFilter() {
    filterState.text = filterEntry.get_text().toLowerCase().trim(); filterState.byFiles = filesCheckbox.get_active();
    treeFilter.refilter();
    if (filterState.text) treeView.expand_all();
    else { treeView.collapse_all(); treeView.expand_row(Gtk.TreePath.new_from_indices([0]), false); }
}
filterEntry.connect('changed', scheduleFilter); filesCheckbox.connect('toggled', scheduleFilter);

combo.connect('changed', () => { const idx = combo.get_active(); if (idx >= 0) startScan(ROOTS[idx]); });

loadPlaylists();
if (ROOTS.length > 0) {
    let targetIndex = winConfig.collection;
    if (cliRoot) {
        const absPath = GLib.canonicalize_filename(cliRoot, GLib.get_current_dir());
        const idx = ROOTS.indexOf(absPath); if (idx >= 0) targetIndex = idx;
    }
    if (targetIndex >= 0 && targetIndex < ROOTS.length) combo.set_active(targetIndex); else combo.set_active(0);
}

function openSettingsDialog() {
    const dialog = new Gtk.Dialog({ title: 'Настройки', transient_for: win, modal: true, default_width: 600, default_height: 500 });
    dialog.add_button('Отмена', Gtk.ResponseType.CANCEL); dialog.add_button('Сохранить', Gtk.ResponseType.OK);
    const grid = new Gtk.Grid({ column_spacing: 10, row_spacing: 6, margin: 10 }); dialog.get_content_area().add(grid);
    const entries = {}; let row = 0;

    function addRow(label, key, value, tooltip) {
        const lbl = new Gtk.Label({ label, xalign: 0, halign: Gtk.Align.START });
        const entry = new Gtk.Entry({ text: value || '', hexpand: true }); if (tooltip) entry.set_tooltip_text(tooltip);
        grid.attach(lbl, 0, row, 1, 1); grid.attach(entry, 1, row, 1, 1); entries[key] = entry; row++;
    }

    addRow('Корневые каталоги (через ;):', 'Roots', ROOTS.join(';'), 'Например: /home/user/Music;/mnt/usb/Music');
    addRow('Команда проигрывания (Play):', 'Play', getPlayCommand(), 'Используйте %f как подстановку пути к файлу');
    addRow('Команда добавления в очередь (Enqueue):', 'Enqueue', getEnqueueCommand(), 'Используйте %f как подстановку пути к файлу');

    const chkM3U = new Gtk.CheckButton({ label: 'Использовать M3U для множественного выбора', active: getMultipleM3U() });
    grid.attach(chkM3U, 0, row, 2, 1); row++;
        const lblAction = new Gtk.Label({ label: 'Действие Enter / двойной клик:', xalign: 0, halign: Gtk.Align.START });
    const comboAction = new Gtk.ComboBoxText();
    comboAction.append_text('Проиграть');
    comboAction.append_text('Добавить в очередь');
    comboAction.set_active(getDefaultAction() === 'enqueue' ? 1 : 0);
    grid.attach(lblAction, 0, row, 1, 1);
    grid.attach(comboAction, 1, row, 1, 1);
    row++;
    addRow('Максимум файлов в подкаталоге:', 'MaxTrackCount', String(getMaxTrackCount()), 'Если файлов больше, показывается только сам каталог');
    addRow('Логировать каждые N каталогов:', 'LogEvery', String(getScanLogEvery()), 'Для scan.log');

    dialog.show_all();
    dialog.connect('response', (d, resp) => {
        if (resp === Gtk.ResponseType.OK) {
            const kf = new GLib.KeyFile(); try { kf.load_from_file(CONFIG_FILE, GLib.KeyFileFlags.NONE); } catch (e) {}
            kf.set_string('Paths', 'Roots', entries['Roots'].get_text().trim());
            kf.set_string('Player', 'Play', entries['Play'].get_text().trim());
            kf.set_string('Player', 'Enqueue', entries['Enqueue'].get_text().trim());
            kf.set_string('Player', 'DefaultAction', comboAction.get_active() === 1 ? 'enqueue' : 'play');
            kf.set_boolean('Player', 'MultipleTracksUseM3U', chkM3U.get_active());
            kf.set_integer('Scan', 'MaxTrackCount', parseInt(entries['MaxTrackCount'].get_text(), 10) || 20000);
            kf.set_integer('Scan', 'LogEvery', parseInt(entries['LogEvery'].get_text(), 10) || 500);
            saveFileUtf8(CONFIG_FILE, kf.to_data());

            try { keyfile.load_from_file(CONFIG_FILE, GLib.KeyFileFlags.NONE); } catch (e) {}
            ROOTS.length = 0;
            const newRoots = kf.get_string('Paths', 'Roots') || '';
            newRoots.split(';').map(s => s.trim()).filter(Boolean).forEach(r => ROOTS.push(r));

            const active = combo.get_active(); combo.remove_all();
            for (const p of ROOTS) combo.append_text(p);
            if (active >= 0 && active < ROOTS.length) combo.set_active(active); else if (ROOTS.length > 0) combo.set_active(0);
            statusbar.push(1, 'Настройки сохранены.');
        }
        d.destroy();
    });
}

win.show_all();
Gtk.main();
