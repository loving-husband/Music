// ============================================================================
// Offline Music Player — app.js
// Everything runs on-device. No audio file, title, or list is ever sent
// anywhere. IndexedDB stores songs (with the audio Blob) and playlists.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
// 0. Service worker + persistent storage
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
      showStatus('Offline mode may not work: service worker failed to register.', true);
    });
  });
}

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// ---------------------------------------------------------------------------
// 1. IndexedDB layer
// ---------------------------------------------------------------------------
const DB_NAME = 'MusicPlayerDB';
const DB_VERSION = 1;
const SONGS_STORE = 'songs';
const PLAYLISTS_STORE = 'playlists';

let dbInstance = null;

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!('indexedDB' in window)) {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        const store = db.createObjectStore(SONGS_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('title', 'title', { unique: false });
        store.createIndex('addedAt', 'addedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };
    request.onerror = (event) => reject(event.target.error);
  });
}

function txStore(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function addSong(record) {
  return txStore(SONGS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function getAllSongs() {
  return txStore(SONGS_STORE, 'readonly').then((store) => new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function putSong(record) {
  return txStore(SONGS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function deleteSongFromDB(id) {
  return txStore(SONGS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

function addPlaylist(record) {
  return txStore(PLAYLISTS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function getAllPlaylists() {
  return txStore(PLAYLISTS_STORE, 'readonly').then((store) => new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function putPlaylist(record) {
  return txStore(PLAYLISTS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.put(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function deletePlaylistFromDB(id) {
  return txStore(PLAYLISTS_STORE, 'readwrite').then((store) => new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

// ---------------------------------------------------------------------------
// 2. App state
// ---------------------------------------------------------------------------
let songs = [];            // all songs from IndexedDB
let playlists = [];        // all playlists from IndexedDB
let currentTab = 'all';    // 'all' | 'favorites' | 'playlists'
let currentPlaylistId = null;
let searchQuery = '';
let sortMode = 'title';    // 'title' | 'recent'

let playOrder = [];        // array of song ids, in play order
let currentPos = -1;       // index into playOrder
let currentSongId = null;
let currentObjectUrl = null;
let shuffleOn = false;
let repeatMode = 'off';    // 'off' | 'all' | 'one'

// ---------------------------------------------------------------------------
// 3. DOM references
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const fileInput = $('fileInput');
const fileInput2 = $('fileInput2');
const statusMsg = $('statusMsg');

const searchInput = $('searchInput');
const sortSelect = $('sortSelect');
const tabBtns = document.querySelectorAll('.tab-btn');

const songsView = $('songsView');
const songList = $('songList');
const emptyMsg = $('emptyMsg');
const emptyFavMsg = $('emptyFavMsg');

const playlistsView = $('playlistsView');
const playlistList = $('playlistList');
const emptyPlaylistMsg = $('emptyPlaylistMsg');
const newPlaylistBtn = $('newPlaylistBtn');

const playlistDetailView = $('playlistDetailView');
const playlistBackBtn = $('playlistBackBtn');
const deletePlaylistBtn = $('deletePlaylistBtn');
const playlistDetailTitle = $('playlistDetailTitle');
const addSongsToPlaylistBtn = $('addSongsToPlaylistBtn');
const playlistSongList = $('playlistSongList');
const emptyPlaylistDetailMsg = $('emptyPlaylistDetailMsg');

const addToPlaylistOverlay = $('addToPlaylistOverlay');
const addToPlaylistDoneBtn = $('addToPlaylistDoneBtn');
const addToPlaylistList = $('addToPlaylistList');

const audioEl = $('audioEl');

const miniPlayer = $('miniPlayer');
const miniThumb = $('miniThumb');
const miniTitle = $('miniTitle');
const miniPlayPause = $('miniPlayPause');
const miniPrev = $('miniPrev');
const miniNext = $('miniNext');
const miniInfo = document.querySelector('.mini-info');

const nowPlayingScreen = $('nowPlayingScreen');
const backToLibraryBtn = $('backToLibraryBtn');
const npArtBig = $('npArtBig');
const npTitleBig = $('npTitleBig');
const npArtistBig = $('npArtistBig');
const seekBar = $('seekBar');
const npCurrentTime = $('npCurrentTime');
const npDuration = $('npDuration');
const shuffleBtn = $('shuffleBtn');
const repeatBtn = $('repeatBtn');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const playPauseBig = $('playPauseBig');

// ---------------------------------------------------------------------------
// 4. Status / error messaging
// ---------------------------------------------------------------------------
let statusTimer = null;
function showStatus(text, isError) {
  statusMsg.textContent = text;
  statusMsg.hidden = false;
  statusMsg.classList.toggle('error', !!isError);
  clearTimeout(statusTimer);
  if (!isError) {
    statusTimer = setTimeout(() => { statusMsg.hidden = true; }, 3500);
  }
}

// ---------------------------------------------------------------------------
// 5. Placeholder artwork (inline SVG, no network request)
// ---------------------------------------------------------------------------
function placeholderArt() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">
       <rect width="60" height="60" fill="#2a2a31"/>
       <text x="50%" y="57%" font-size="26" text-anchor="middle" fill="#e8734a" font-family="sans-serif">&#9834;</text>
     </svg>`
  );
}

// ---------------------------------------------------------------------------
// 6. Import flow (used by both "+ Add Music" inputs)
// ---------------------------------------------------------------------------
async function handleFiles(fileListLike) {
  const files = Array.from(fileListLike);
  if (files.length === 0) return;

  showStatus(`Importing ${files.length} song${files.length > 1 ? 's' : ''}...`);

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    try {
      const title = file.name.replace(/\.[^/.]+$/, '');
      await addSong({
        title: title,
        filename: file.name,
        mimeType: file.type || 'audio/mpeg',
        blob: file,
        favorite: false,
        addedAt: Date.now()
      });
      successCount++;
    } catch (err) {
      console.error('Failed to import', file.name, err);
      failCount++;
    }
  }

  await reloadSongs();

  if (failCount === 0) {
    showStatus(`${successCount} song${successCount > 1 ? 's' : ''} imported successfully.`);
  } else {
    showStatus(`${successCount} imported, ${failCount} failed. Some files may be an unsupported format.`, failCount === successCount ? true : false);
  }
}

fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); fileInput.value = ''; });
fileInput2.addEventListener('change', (e) => { handleFiles(e.target.files); fileInput2.value = ''; });

// ---------------------------------------------------------------------------
// 7. Loading + rendering the library
// ---------------------------------------------------------------------------
async function reloadSongs() {
  try {
    songs = await getAllSongs();
  } catch (err) {
    console.error(err);
    showStatus('Could not load your music library from storage.', true);
    songs = [];
  }
  renderSongsView();
}

async function reloadPlaylists() {
  try {
    playlists = await getAllPlaylists();
  } catch (err) {
    console.error(err);
    playlists = [];
  }
  renderPlaylistsView();
}

function getFilteredSortedSongs(sourceList) {
  let list = sourceList.slice();

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter((s) => s.title.toLowerCase().includes(q));
  }

  if (sortMode === 'title') {
    list.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    list.sort((a, b) => b.addedAt - a.addedAt);
  }

  return list;
}

function renderSongsView() {
  const sourceList = currentTab === 'favorites' ? songs.filter((s) => s.favorite) : songs;
  const list = getFilteredSortedSongs(sourceList);

  songList.innerHTML = '';
  list.forEach((song) => songList.appendChild(buildSongRow(song)));

  const noSongsAtAll = songs.length === 0;
  const noFavorites = currentTab === 'favorites' && songs.filter((s) => s.favorite).length === 0;

  emptyMsg.hidden = !(currentTab === 'all' && noSongsAtAll);
  emptyFavMsg.hidden = !(currentTab === 'favorites' && noFavorites && !noSongsAtAll);
  songList.hidden = (currentTab === 'all' && noSongsAtAll) || (currentTab === 'favorites' && noFavorites);
}

function buildSongRow(song, options) {
  options = options || {};
  const li = document.createElement('li');
  li.className = 'song-item';
  if (song.id === currentSongId) li.classList.add('active');

  const tapArea = document.createElement('div');
  tapArea.className = 'song-tap-area';

  const thumb = document.createElement('img');
  thumb.className = 'song-thumb';
  thumb.alt = '';
  thumb.src = placeholderArt();

  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const titleEl = document.createElement('p');
  titleEl.className = 'song-title';
  titleEl.textContent = song.title;
  const subEl = document.createElement('p');
  subEl.className = 'song-sub';
  subEl.textContent = song.artist || 'Unknown Artist';
  meta.appendChild(titleEl);
  meta.appendChild(subEl);

  tapArea.appendChild(thumb);
  tapArea.appendChild(meta);
  tapArea.addEventListener('click', () => playSongById(song.id, options.playOrderSource || null));

  li.appendChild(tapArea);

  const actions = document.createElement('div');
  actions.className = 'song-actions';

  const favBtn = document.createElement('button');
  favBtn.className = 'icon-action-btn' + (song.favorite ? ' favorited' : '');
  favBtn.textContent = song.favorite ? '♥' : '♡';
  favBtn.setAttribute('aria-label', 'Toggle favorite');
  favBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(song); });

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-action-btn';
  delBtn.textContent = '🗑';
  delBtn.setAttribute('aria-label', 'Delete song');
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); confirmDeleteSong(song); });

  actions.appendChild(favBtn);
  actions.appendChild(delBtn);
  li.appendChild(actions);

  return li;
}

async function toggleFavorite(song) {
  song.favorite = !song.favorite;
  try {
    await putSong(song);
  } catch (err) {
    console.error(err);
    showStatus('Could not update favorite. Please try again.', true);
    song.favorite = !song.favorite; // revert
  }
  renderSongsView();
}

function confirmDeleteSong(song) {
  const ok = window.confirm(`Delete "${song.title}" from your library? This only removes it from the app, not from your device's Files app.`);
  if (!ok) return;
  deleteSong(song);
}

async function deleteSong(song) {
  try {
    await deleteSongFromDB(song.id);
    // Also remove it from any playlists that reference it
    const affected = playlists.filter((p) => p.songIds && p.songIds.includes(song.id));
    for (const p of affected) {
      p.songIds = p.songIds.filter((id) => id !== song.id);
      await putPlaylist(p);
    }
    if (song.id === currentSongId) {
      stopPlaybackUI();
    }
    await reloadSongs();
    await reloadPlaylists();
    showStatus(`"${song.title}" deleted.`);
  } catch (err) {
    console.error(err);
    showStatus('Could not delete this song. Please try again.', true);
  }
}

// ---------------------------------------------------------------------------
// 8. Search / sort / tabs
// ---------------------------------------------------------------------------
searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderSongsView();
});

sortSelect.addEventListener('change', (e) => {
  sortMode = e.target.value;
  renderSongsView();
});

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;

    songsView.hidden = currentTab === 'playlists';
    playlistsView.hidden = currentTab !== 'playlists';
    playlistDetailView.hidden = true;

    if (currentTab === 'playlists') {
      renderPlaylistsView();
    } else {
      renderSongsView();
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Playback engine
// ---------------------------------------------------------------------------
function buildPlayOrder(sourceSongs, startId) {
  let ids = sourceSongs.map((s) => s.id);
  if (shuffleOn) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const pos = ids.indexOf(startId);
    if (pos > 0) [ids[0], ids[pos]] = [ids[pos], ids[0]];
  } else {
    const pos = ids.indexOf(startId);
    if (pos > 0) {
      // keep natural order but rotate so the queue continues logically
    }
  }
  return ids;
}

function playSongById(id, sourceListOverride) {
  const sourceList = sourceListOverride || getFilteredSortedSongs(
    currentTab === 'favorites' ? songs.filter((s) => s.favorite) : songs
  );
  playOrder = buildPlayOrder(sourceList, id);
  currentPos = playOrder.indexOf(id);
  loadAndPlay(id);
}

function loadAndPlay(id) {
  const song = songs.find((s) => s.id === id);
  if (!song) {
    showStatus('That song could not be found. It may have been deleted.', true);
    return;
  }

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  try {
    currentObjectUrl = URL.createObjectURL(song.blob);
  } catch (err) {
    console.error(err);
    showStatus(`Could not load "${song.title}".`, true);
    return;
  }

  audioEl.src = currentObjectUrl;
  currentSongId = id;

  const playPromise = audioEl.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      console.error('Playback failed:', err);
      showStatus(`Could not play "${song.title}". The format may not be supported on this device.`, true);
    });
  }

  updateNowPlayingUI(song);
  updateMediaSession(song);
  renderSongsView();
  if (currentTab === 'playlists' && !playlistDetailView.hidden) renderPlaylistDetail();
  miniPlayer.hidden = false;
}

function stopPlaybackUI() {
  audioEl.pause();
  audioEl.removeAttribute('src');
  currentSongId = null;
  currentObjectUrl && URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = null;
  miniPlayer.hidden = true;
  nowPlayingScreen.hidden = true;
}

function updateNowPlayingUI(song) {
  miniTitle.textContent = song.title;
  miniThumb.src = placeholderArt();
  npTitleBig.textContent = song.title;
  npArtistBig.textContent = song.artist || 'Unknown Artist';
  npArtBig.src = placeholderArt();
}

function togglePlayPause() {
  if (!audioEl.src) return;
  if (audioEl.paused) {
    const p = audioEl.play();
    if (p !== undefined) p.catch((err) => console.error(err));
  } else {
    audioEl.pause();
  }
}
miniPlayPause.addEventListener('click', togglePlayPause);
playPauseBig.addEventListener('click', togglePlayPause);

audioEl.addEventListener('play', () => {
  miniPlayPause.textContent = '⏸';
  playPauseBig.textContent = '⏸';
});
audioEl.addEventListener('pause', () => {
  miniPlayPause.textContent = '▶';
  playPauseBig.textContent = '▶';
});
audioEl.addEventListener('error', () => {
  if (currentSongId !== null) {
    showStatus('There was a problem playing this file.', true);
  }
});

function playNext() {
  if (playOrder.length === 0) return;
  if (currentPos < playOrder.length - 1) {
    currentPos++;
  } else if (repeatMode === 'all') {
    currentPos = 0;
  } else {
    return;
  }
  loadAndPlay(playOrder[currentPos]);
}

function playPrev() {
  if (playOrder.length === 0) return;
  if (audioEl.currentTime > 3) {
    audioEl.currentTime = 0;
    return;
  }
  if (currentPos > 0) {
    currentPos--;
    loadAndPlay(playOrder[currentPos]);
  } else {
    audioEl.currentTime = 0;
  }
}

miniNext.addEventListener('click', playNext);
miniPrev.addEventListener('click', playPrev);
nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

audioEl.addEventListener('ended', () => {
  if (repeatMode === 'one') {
    audioEl.currentTime = 0;
    const p = audioEl.play();
    if (p !== undefined) p.catch(() => {});
  } else {
    playNext();
  }
});

shuffleBtn.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  shuffleBtn.classList.toggle('active', shuffleOn);
  if (currentSongId !== null) {
    const sourceList = getFilteredSortedSongs(currentTab === 'favorites' ? songs.filter((s) => s.favorite) : songs);
    playOrder = buildPlayOrder(sourceList, currentSongId);
    currentPos = playOrder.indexOf(currentSongId);
  }
});

repeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  repeatBtn.classList.toggle('active', repeatMode !== 'off');
  repeatBtn.textContent = repeatMode === 'one' ? '🔂' : '🔁';
});

// ---------------------------------------------------------------------------
// 10. Seek bar
// ---------------------------------------------------------------------------
audioEl.addEventListener('loadedmetadata', () => {
  seekBar.max = Math.floor(audioEl.duration) || 0;
  npDuration.textContent = formatTime(audioEl.duration);
});
audioEl.addEventListener('timeupdate', () => {
  if (!seekBar.matches(':active')) {
    seekBar.value = Math.floor(audioEl.currentTime);
  }
  npCurrentTime.textContent = formatTime(audioEl.currentTime);
});
seekBar.addEventListener('input', () => {
  audioEl.currentTime = Number(seekBar.value);
});
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// 11. Now Playing screen open/close — hidden attribute ONLY, never CSS display
// ---------------------------------------------------------------------------
miniInfo.addEventListener('click', () => {
  if (currentSongId === null) return;
  nowPlayingScreen.hidden = false;
});
backToLibraryBtn.addEventListener('click', () => {
  nowPlayingScreen.hidden = true;
});

// ---------------------------------------------------------------------------
// 12. Media Session API (feature-detected; improves lock-screen controls
//     where the OS/browser supports it — not guaranteed on iPadOS)
// ---------------------------------------------------------------------------
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist || 'Unknown Artist',
      album: ''
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
  } catch (err) {
    // Some actions/browsers may throw if unsupported — safe to ignore.
    console.warn('Media Session partial support:', err);
  }
}

// ---------------------------------------------------------------------------
// 13. Playlists
// ---------------------------------------------------------------------------
function renderPlaylistsView() {
  playlistList.innerHTML = '';
  playlists.forEach((pl) => {
    const li = document.createElement('li');
    li.className = 'song-item';

    const tapArea = document.createElement('div');
    tapArea.className = 'song-tap-area';
    const meta = document.createElement('div');
    meta.className = 'song-meta';
    const titleEl = document.createElement('p');
    titleEl.className = 'song-title';
    titleEl.textContent = pl.name;
    const subEl = document.createElement('p');
    subEl.className = 'song-sub';
    const count = (pl.songIds || []).length;
    subEl.textContent = `${count} song${count === 1 ? '' : 's'}`;
    meta.appendChild(titleEl);
    meta.appendChild(subEl);
    tapArea.appendChild(meta);
    tapArea.addEventListener('click', () => openPlaylistDetail(pl.id));

    li.appendChild(tapArea);
    playlistList.appendChild(li);
  });

  emptyPlaylistMsg.hidden = playlists.length > 0;
  playlistList.hidden = playlists.length === 0;
}

newPlaylistBtn.addEventListener('click', async () => {
  const name = window.prompt('Playlist name:');
  if (!name || !name.trim()) return;
  try {
    await addPlaylist({ name: name.trim(), songIds: [], createdAt: Date.now() });
    await reloadPlaylists();
    showStatus(`Playlist "${name.trim()}" created.`);
  } catch (err) {
    console.error(err);
    showStatus('Could not create playlist. Please try again.', true);
  }
});

function openPlaylistDetail(playlistId) {
  currentPlaylistId = playlistId;
  playlistsView.hidden = true;
  playlistDetailView.hidden = false;
  renderPlaylistDetail();
}

playlistBackBtn.addEventListener('click', () => {
  currentPlaylistId = null;
  playlistDetailView.hidden = true;
  playlistsView.hidden = false;
});

function renderPlaylistDetail() {
  const pl = playlists.find((p) => p.id === currentPlaylistId);
  if (!pl) {
    playlistDetailView.hidden = true;
    playlistsView.hidden = false;
    return;
  }
  playlistDetailTitle.textContent = pl.name;

  const songIds = pl.songIds || [];
  const plSongs = songIds.map((id) => songs.find((s) => s.id === id)).filter(Boolean);

  playlistSongList.innerHTML = '';
  plSongs.forEach((song) => {
    const li = buildSongRow(song, { playOrderSource: plSongs });
    // Add a "remove from playlist" button in place of delete
    const actions = li.querySelector('.song-actions');
    if (actions) {
      const delBtn = actions.querySelector('.icon-action-btn:last-child');
      if (delBtn) {
        delBtn.textContent = '✕';
        delBtn.setAttribute('aria-label', 'Remove from playlist');
        delBtn.onclick = (e) => { e.stopPropagation(); removeSongFromPlaylist(song.id); };
      }
    }
    playlistSongList.appendChild(li);
  });

  emptyPlaylistDetailMsg.hidden = plSongs.length > 0;
  playlistSongList.hidden = plSongs.length === 0;
}

async function removeSongFromPlaylist(songId) {
  const pl = playlists.find((p) => p.id === currentPlaylistId);
  if (!pl) return;
  pl.songIds = (pl.songIds || []).filter((id) => id !== songId);
  try {
    await putPlaylist(pl);
    await reloadPlaylists();
    renderPlaylistDetail();
  } catch (err) {
    console.error(err);
    showStatus('Could not update playlist.', true);
  }
}

deletePlaylistBtn.addEventListener('click', async () => {
  const pl = playlists.find((p) => p.id === currentPlaylistId);
  if (!pl) return;
  const ok = window.confirm(`Delete playlist "${pl.name}"? Your songs will not be deleted.`);
  if (!ok) return;
  try {
    await deletePlaylistFromDB(pl.id);
    currentPlaylistId = null;
    playlistDetailView.hidden = true;
    playlistsView.hidden = false;
    await reloadPlaylists();
    showStatus('Playlist deleted.');
  } catch (err) {
    console.error(err);
    showStatus('Could not delete playlist.', true);
  }
});

// ---- Add-songs-to-playlist overlay ----
addSongsToPlaylistBtn.addEventListener('click', () => {
  const pl = playlists.find((p) => p.id === currentPlaylistId);
  if (!pl) return;
  renderAddToPlaylistOverlay(pl);
  addToPlaylistOverlay.hidden = false;
});

function renderAddToPlaylistOverlay(pl) {
  addToPlaylistList.innerHTML = '';
  const currentIds = new Set(pl.songIds || []);

  songs.slice().sort((a, b) => a.title.localeCompare(b.title)).forEach((song) => {
    const li = document.createElement('li');
    li.className = 'song-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = currentIds.has(song.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) currentIds.add(song.id);
      else currentIds.delete(song.id);
    });

    const meta = document.createElement('div');
    meta.className = 'song-meta';
    const titleEl = document.createElement('p');
    titleEl.className = 'song-title';
    titleEl.textContent = song.title;
    meta.appendChild(titleEl);

    li.appendChild(checkbox);
    li.appendChild(meta);
    addToPlaylistList.appendChild(li);
  });

  addToPlaylistDoneBtn.onclick = async () => {
    pl.songIds = Array.from(currentIds);
    try {
      await putPlaylist(pl);
      await reloadPlaylists();
      renderPlaylistDetail();
    } catch (err) {
      console.error(err);
      showStatus('Could not save playlist changes.', true);
    }
    addToPlaylistOverlay.hidden = true;
  };
}

// ---------------------------------------------------------------------------
// 14. Startup
// ---------------------------------------------------------------------------
(async function init() {
  // Explicitly guarantee correct initial screen state (belt-and-braces,
  // even though the HTML already has this baked in).
  nowPlayingScreen.hidden = true;
  addToPlaylistOverlay.hidden = true;
  miniPlayer.hidden = true;
  playlistDetailView.hidden = true;
  playlistsView.hidden = true;

  try {
    await reloadSongs();
    await reloadPlaylists();
  } catch (err) {
    console.error(err);
    showStatus('Could not open your local music storage. Try reloading the app.', true);
  }
})();
