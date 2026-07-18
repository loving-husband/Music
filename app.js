// app.js — Offline Music Player
// Everything here runs entirely on-device. No audio file is ever sent anywhere.

// ---------- 0. Register the service worker (app shell offline support) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

// Ask the browser to treat our storage as "persistent" (best-effort; not
// supported on iOS Safari, but harmless to call — see the README notes).
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then((granted) => {
    console.log('Persistent storage granted:', granted);
  });
}

// ---------- 1. Tiny IndexedDB wrapper ----------
const DB_NAME = 'MusicPlayerDB';
const DB_VERSION = 1;
const STORE_NAME = 'songs';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('title', 'title', { unique: false });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

async function addSongToDB(fileBlob, title) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = {
      title: title,
      blob: fileBlob,          // the actual audio data, stored locally
      addedAt: Date.now()
    };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllSongs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- 2. App state ----------
let songs = [];          // all songs loaded from IndexedDB, in library order
let playOrder = [];       // indices into `songs`, in the order we will play them
let currentPos = -1;      // position within playOrder
let currentObjectUrl = null;
let shuffleOn = false;
let repeatMode = 'off';   // 'off' | 'all' | 'one'

// ---------- 3. DOM references ----------
const fileInput = document.getElementById('fileInput');
const songListEl = document.getElementById('songList');
const emptyMsg = document.getElementById('emptyMsg');
const statusMsg = document.getElementById('statusMsg');

const audioEl = document.getElementById('audioEl');

const nowPlayingBar = document.getElementById('nowPlayingBar');
const npThumb = document.getElementById('npThumb');
const npTitle = document.getElementById('npTitle');
const npPlayPause = document.getElementById('npPlayPause');

const nowPlayingScreen = document.getElementById('nowPlayingScreen');
const npClose = document.getElementById('npClose');
const npArtBig = document.getElementById('npArtBig');
const npTitleBig = document.getElementById('npTitleBig');
const seekBar = document.getElementById('seekBar');
const npCurrentTime = document.getElementById('npCurrentTime');
const npDuration = document.getElementById('npDuration');

const shuffleBtn = document.getElementById('shuffleBtn');
const repeatBtn = document.getElementById('repeatBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const playPauseBig = document.getElementById('playPauseBig');

// ---------- 4. Import flow ----------
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  showStatus(`Importing ${files.length} file(s)...`);

  for (const file of files) {
    const title = file.name.replace(/\.[^/.]+$/, ''); // strip extension
    try {
      await addSongToDB(file, title);
    } catch (err) {
      console.error('Failed to store', file.name, err);
    }
  }

  fileInput.value = ''; // reset so the same file can be re-picked later
  await refreshLibrary();
  showStatus(`Imported ${files.length} file(s). Stored on this device.`);
  setTimeout(() => hideStatus(), 3000);
});

function showStatus(text) {
  statusMsg.textContent = text;
  statusMsg.hidden = false;
}
function hideStatus() {
  statusMsg.hidden = true;
}

// ---------- 5. Library rendering ----------
async function refreshLibrary() {
  songs = await getAllSongs();
  songListEl.innerHTML = '';

  if (songs.length === 0) {
    emptyMsg.hidden = false;
  } else {
    emptyMsg.hidden = true;
  }

  songs.forEach((song, index) => {
    const li = document.createElement('li');
    li.className = 'song-item';
    li.dataset.index = index;

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
    subEl.textContent = 'Tap to play';
    meta.appendChild(titleEl);
    meta.appendChild(subEl);

    li.appendChild(thumb);
    li.appendChild(meta);
    li.addEventListener('click', () => playFromLibrary(index));

    songListEl.appendChild(li);
  });
}

function placeholderArt() {
  // Simple inline SVG placeholder — no network request needed.
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60">
       <rect width="60" height="60" fill="#2b2b32"/>
       <text x="50%" y="55%" font-size="26" text-anchor="middle" fill="#e8734a" font-family="sans-serif">♪</text>
     </svg>`
  );
}

// ---------- 6. Playback ----------
function buildPlayOrder(startIndex) {
  const indices = songs.map((_, i) => i);
  if (shuffleOn) {
    // Fisher-Yates shuffle, but keep startIndex first
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const pos = indices.indexOf(startIndex);
    [indices[0], indices[pos]] = [indices[pos], indices[0]];
  }
  return indices;
}

function playFromLibrary(index) {
  playOrder = buildPlayOrder(index);
  currentPos = 0;
  loadAndPlay(playOrder[currentPos]);
}

function loadAndPlay(songIndex) {
  const song = songs[songIndex];
  if (!song) return;

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = URL.createObjectURL(song.blob);
  audioEl.src = currentObjectUrl;
  audioEl.play();

  updateNowPlayingUI(song);
  highlightActiveSong(songIndex);
  openNowPlayingBar();
}

function updateNowPlayingUI(song) {
  npTitle.textContent = song.title;
  npTitleBig.textContent = song.title;
  npThumb.src = placeholderArt();
  npArtBig.src = placeholderArt();
}

function highlightActiveSong(index) {
  document.querySelectorAll('.song-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.index) === index);
  });
}

function openNowPlayingBar() {
  nowPlayingBar.hidden = false;
}

// Play/pause toggling (mini bar + big screen)
function togglePlayPause() {
  if (audioEl.paused) {
    audioEl.play();
  } else {
    audioEl.pause();
  }
}
npPlayPause.addEventListener('click', togglePlayPause);
playPauseBig.addEventListener('click', togglePlayPause);

audioEl.addEventListener('play', () => {
  npPlayPause.textContent = '⏸';
  playPauseBig.textContent = '⏸';
});
audioEl.addEventListener('pause', () => {
  npPlayPause.textContent = '▶';
  playPauseBig.textContent = '▶';
});

// Next / previous within the current play order
function playNext() {
  if (playOrder.length === 0) return;
  if (currentPos < playOrder.length - 1) {
    currentPos++;
  } else if (repeatMode === 'all') {
    currentPos = 0;
  } else {
    return; // end of queue, nothing more to play
  }
  loadAndPlay(playOrder[currentPos]);
}

function playPrev() {
  if (playOrder.length === 0) return;
  // If more than 3 seconds into the song, restart it instead of going back
  if (audioEl.currentTime > 3) {
    audioEl.currentTime = 0;
    return;
  }
  if (currentPos > 0) {
    currentPos--;
    loadAndPlay(playOrder[currentPos]);
  }
}

nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);

audioEl.addEventListener('ended', () => {
  if (repeatMode === 'one') {
    audioEl.currentTime = 0;
    audioEl.play();
  } else {
    playNext();
  }
});

// Shuffle toggle
shuffleBtn.addEventListener('click', () => {
  shuffleOn = !shuffleOn;
  shuffleBtn.classList.toggle('active', shuffleOn);
  if (playOrder.length > 0) {
    const currentSongIndex = playOrder[currentPos];
    playOrder = buildPlayOrder(currentSongIndex);
    currentPos = 0;
  }
});

// Repeat toggle: off -> all -> one -> off
repeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  repeatBtn.classList.toggle('active', repeatMode !== 'off');
  repeatBtn.textContent = repeatMode === 'one' ? '🔂' : '🔁';
});

// ---------- 7. Seek bar ----------
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
  if (!isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ---------- 8. Now Playing full screen open/close ----------
nowPlayingBar.addEventListener('click', (e) => {
  if (e.target === npPlayPause) return; // don't open when just tapping play/pause
  nowPlayingScreen.hidden = false;
});
npClose.addEventListener('click', () => {
  nowPlayingScreen.hidden = true;
});

// ---------- 9. Startup ----------
refreshLibrary();
