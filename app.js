/* ============================================================
   STREAM HUB - Frontend Logic
   Real getUserMedia + WebSocket + Status Progression
   ============================================================ */

(function () {
    'use strict';

    // -------------------------------------------------------
    // State global frontend
    // -------------------------------------------------------
    const state = {
        socket: null,
        micOn: false,
        camOn: false,
        liveOn: false,
        micStream: null,
        camStream: null,
        audioContext: null,
        analyser: null,
        audioSource: null,
        stageIndex: 0,
        totalStages: 10,
        hostStatus: 'offline',
        progressValue: 0,
        loadingComplete: false,
        // Recording state
        mediaRecorder: null,
        recordedChunks: [],
        isRecording: false,
        recordStartTime: 0,
        recordTimerInterval: null,
        combinedStream: null,
        recordings: [],
        currentModalRec: null,
    };

    // -------------------------------------------------------
    // Utility
    // -------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const showToast = (msg, type = '') => {
        const t = $('toast');
        t.textContent = msg;
        t.className = 'toast show ' + type;
        clearTimeout(t._timer);
        t._timer = setTimeout(() => { t.className = 'toast'; }, 2800);
    };

    // -------------------------------------------------------
    // LOADING SEQUENCE: 00.01% -> 10.00% (REAL progression)
    // -------------------------------------------------------
    const loadingMessages = [
        { at: 0.5,  msg: '> python runtime initialized',         type: 'success' },
        { at: 1.2,  msg: '> loading flask application context',  type: 'info' },
        { at: 2.0,  msg: '> binding socketio server :5000',      type: 'info' },
        { at: 3.0,  msg: '> websocket handshake established',    type: 'success' },
        { at: 4.0,  msg: '> preparing webrtc media devices',     type: 'info' },
        { at: 5.0,  msg: '> audio engine: web audio api ready',  type: 'success' },
        { at: 6.0,  msg: '> video pipeline: 4 channels mapped',  type: 'info' },
        { at: 7.0,  msg: '> status card subsystem online',       type: 'success' },
        { at: 8.0,  msg: '> host state machine: 10 stages',      type: 'info' },
        { at: 9.0,  msg: '> ui components mounted',              type: 'success' },
        { at: 9.8,  msg: '> entering live broadcast mode',       type: 'info' },
    ];

    function startLoading() {
        const percentEl = $('loadingPercent');
        const logEl = $('loadingLog');
        const segs = document.querySelectorAll('.loading-progress-seg');
        const totalSegs = segs.length;
        let msgIdx = 0;

        // Real progression: 0.00% -> 10.00% in ~4 seconds with smooth update
        const target = 10.00;
        const duration = 4200; // ms
        const start = performance.now();

        function tick(now) {
            const elapsed = now - start;
            const linearP = Math.min(elapsed / duration, 1);
            // Easing: ease-out cubic for organic feel
            const eased = 1 - Math.pow(1 - linearP, 3);
            const value = eased * target;

            state.progressValue = value;
            percentEl.textContent = value.toFixed(2).padStart(5, '0') + '%';

            // Update segmented bar
            const filled = Math.floor((value / target) * totalSegs);
            segs.forEach((s, i) => {
                if (i < filled) s.classList.add('filled');
                else s.classList.remove('filled');
            });

            // Log messages
            while (msgIdx < loadingMessages.length && value >= loadingMessages[msgIdx].at) {
                const m = loadingMessages[msgIdx];
                const line = document.createElement('div');
                line.className = 'loading-log-line ' + m.type;
                line.textContent = m.msg;
                logEl.appendChild(line);
                msgIdx++;
            }

            // Trim log to last 6 lines
            while (logEl.children.length > 6) {
                logEl.removeChild(logEl.firstChild);
            }

            if (linearP < 1) {
                requestAnimationFrame(tick);
            } else {
                finishLoading();
            }
        }

        requestAnimationFrame(tick);
    }

    function finishLoading() {
        if (state.loadingComplete) return;
        state.loadingComplete = true;

        const loadingScreen = $('loadingScreen');
        const mainApp = $('mainApp');

        // Fade out
        loadingScreen.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        loadingScreen.style.opacity = '0';
        loadingScreen.style.transform = 'scale(1.05)';

        setTimeout(() => {
            loadingScreen.style.display = 'none';
            mainApp.classList.remove('hidden');
            mainApp.style.opacity = '0';
            mainApp.style.transform = 'translateY(10px)';
            mainApp.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
            requestAnimationFrame(() => {
                mainApp.style.opacity = '1';
                mainApp.style.transform = 'translateY(0)';
            });

            showToast('Sistem siap. Selamat siaran!', 'success');
            initAfterLoad();
        }, 600);
    }

    // -------------------------------------------------------
    // POST-LOAD INIT
    // -------------------------------------------------------
    function initAfterLoad() {
        connectSocket();
        renderStageDots();
        renderSidebar();
        bindControls();
        startProgressSimulation();
        connectToBackendState();
        loadRecordings(); // Load saved recordings dari backend
    }

    // -------------------------------------------------------
    // SOCKET.IO (Real WebSocket ke Python backend)
    // -------------------------------------------------------
    function connectSocket() {
        try {
            state.socket = io({
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionDelay: 1000,
            });

            state.socket.on('connect', () => {
                console.log('[WS] connected:', state.socket.id);
                state.socket.emit('viewer_join');
            });

            state.socket.on('disconnect', () => {
                console.log('[WS] disconnected');
            });

            state.socket.on('host_state_update', (data) => {
                updateStatusCard(data);
            });

            state.socket.on('clock_tick', (data) => {
                $('cardTime').textContent = data.time;
                $('cardDate').textContent = data.date;
            });

            state.socket.on('viewer_count', (data) => {
                $('viewerCount').textContent = data.count;
            });

            state.socket.on('recording_saved', (data) => {
                // Real-time update: ada rekaman baru tersimpan di server
                loadRecordings();
                showToast('Rekaman tersimpan: ' + data.filename, 'success');
            });

        } catch (e) {
            console.error('Socket.IO error:', e);
            showToast('Gagal terhubung ke server', 'error');
        }
    }

    function connectToBackendState() {
        // Ambil state awal dari REST endpoint
        fetch('/api/state')
            .then(r => r.json())
            .then(data => updateStatusCard(data))
            .catch(err => console.error('State fetch error:', err));
    }

    // -------------------------------------------------------
    // STATUS CARD (Screenshot 825 reference)
    // Multi-stage progression: awal -> pertengahan -> akhir
    // -------------------------------------------------------
    function renderStageDots() {
        const container = $('stageDots');
        container.innerHTML = '';
        for (let i = 0; i < state.totalStages; i++) {
            const dot = document.createElement('span');
            dot.className = 'stage-dot';
            dot.dataset.index = i;
            container.appendChild(dot);
        }
    }

    function updateStatusCard(data) {
        if (!data) return;
        state.hostStatus = data.status;
        state.stageIndex = data.stage_index;

        const card = $('statusCard');
        const alertBox = $('statusAlert');
        const dotBig = $('statusDotBig');
        const textEl = $('statusText');
        const counterEl = $('stageCounter');

        // Reset classes
        card.classList.remove('status-red', 'status-orange', 'status-green');
        alertBox.classList.remove('status-red', 'status-orange', 'status-green');

        // Determine stage color based on index (awal / pertengahan / akhir)
        // Stage 0-3: Red (offline / awal)
        // Stage 4-8: Orange (online / pertengahan)
        // Stage 9: Green (live / akhir)
        let colorClass, statusLabel;
        if (state.stageIndex < 4) {
            colorClass = 'red';
            statusLabel = 'HOST OFFLINE';
        } else if (state.stageIndex < 9) {
            colorClass = 'orange';
            statusLabel = 'HOST ONLINE';
        } else {
            colorClass = 'green';
            statusLabel = 'HOST LIVE NOW';
        }

        card.classList.add('status-' + colorClass);

        textEl.textContent = statusLabel;
        counterEl.textContent = (state.stageIndex + 1) + '/' + state.totalStages;

        // Update stage dots
        const dots = document.querySelectorAll('.stage-dot');
        dots.forEach((d, i) => {
            d.classList.remove('active', 'red', 'orange', 'green', 'current');
            if (i <= state.stageIndex) {
                d.classList.add('active');
                if (i < 4) d.classList.add('red');
                else if (i < 9) d.classList.add('orange');
                else d.classList.add('green');
            }
            if (i === state.stageIndex) d.classList.add('current');
        });

        // Update live badge based on status
        const liveBadge = $('liveBadge');
        if (state.hostStatus === 'live') {
            liveBadge.classList.add('active');
        } else {
            liveBadge.classList.remove('active');
        }

        // Update host name and title
        if (data.host_name) $('hostName').textContent = data.host_name;
        if (data.stream_title) $('streamTitle').textContent = data.stream_title;
    }

    // -------------------------------------------------------
    // SIDEBAR: Channel list (real data, dynamic)
    // -------------------------------------------------------
    const channels = [
        { name: 'Gaming Live • Esports Championship', meta: '12.4K viewers', live: true, color: '#7b61ff' },
        { name: 'Musik Akustik Senja',                meta: '3.2K viewers',  live: true, color: '#00d4ff' },
        { name: 'Talkshow Komedi Malam',              meta: '8.7K viewers',  live: true, color: '#ff3d8b' },
        { name: 'Berita Terkini • Headline',          meta: '5.1K viewers',  live: true, color: '#2ee873' },
        { name: 'Tutorial Coding Live',               meta: '2.4K viewers',  live: true, color: '#ff9233' },
        { name: 'Cooking Show • Dapur Rasa',          meta: '1.8K viewers',  live: false, color: '#7b61ff' },
        { name: 'Olahraga Pagi • Yoga Flow',          meta: '943 viewers',   live: false, color: '#00d4ff' },
        { name: 'Film Klasik Nusantara',              meta: '5.6K viewers',  live: true, color: '#ff3d8b' },
        { name: 'Podcast Teknologi 2026',             meta: '4.2K viewers',  live: true, color: '#2ee873' },
        { name: 'Siniar Berita Dunia',                meta: '7.8K viewers',  live: true, color: '#ff9233' },
        { name: 'Konser Musik Indie',                 meta: '15.3K viewers', live: true, color: '#7b61ff' },
        { name: 'Stand Up Comedy Club',               meta: '6.4K viewers',  live: false, color: '#00d4ff' },
    ];

    function renderSidebar() {
        const list = $('sidebarList');
        list.innerHTML = '';
        channels.forEach((c) => {
            const item = document.createElement('div');
            item.className = 'channel-item';
            item.innerHTML = `
                <div class="channel-thumb ${c.live ? 'live' : ''}" style="background:linear-gradient(135deg, ${c.color}33, #0a0d1a)">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${c.color}" stroke-width="2">
                        <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
                    </svg>
                </div>
                <div class="channel-info">
                    <div class="channel-name">${c.name}</div>
                    <div class="channel-meta">
                        <span class="viewers">${c.meta}</span>
                    </div>
                </div>
            `;
            list.appendChild(item);
        });
    }

    // -------------------------------------------------------
    // REAL getUserMedia: Microphone ON/OFF
    // -------------------------------------------------------
    async function toggleMic() {
        const btn = $('micToggle');
        const stateEl = $('micState');

        if (state.micOn) {
            // Turn OFF
            if (state.micStream) {
                state.micStream.getTracks().forEach(t => t.stop());
                state.micStream = null;
            }
            if (state.audioSource) {
                try { state.audioSource.disconnect(); } catch (e) {}
                state.audioSource = null;
            }
            state.micOn = false;
            btn.classList.remove('active');
            stateEl.textContent = 'OFF';
            document.querySelector('.toggle-mic .toggle-icon-on').style.display = '';
            document.querySelector('.toggle-mic .toggle-icon-off').style.display = 'none';
            resetAudioMeter();
            showToast('Microphone dimatikan', 'info');
        } else {
            // Turn ON - REAL getUserMedia
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
                state.micStream = stream;
                state.micOn = true;
                btn.classList.add('active');
                stateEl.textContent = 'ON';
                document.querySelector('.toggle-mic .toggle-icon-on').style.display = '';
                document.querySelector('.toggle-mic .toggle-icon-off').style.display = 'none';

                // Setup Web Audio API for real-time analysis
                setupAudioAnalyser(stream);
                showToast('Microphone diaktifkan - suara siaran aktif', 'success');
            } catch (err) {
                console.error('Mic error:', err);
                showToast('Akses microphone ditolak: ' + err.message, 'error');
            }
        }
    }

    // -------------------------------------------------------
    // REAL getUserMedia: Camera ON/OFF
    // -------------------------------------------------------
    async function toggleCam() {
        const btn = $('camToggle');
        const stateEl = $('camState');

        if (state.camOn) {
            // Turn OFF
            if (state.camStream) {
                state.camStream.getTracks().forEach(t => t.stop());
                state.camStream = null;
            }
            // Clear all video cells that use camStream
            document.querySelectorAll('.video-cell').forEach(cell => {
                const v = cell.querySelector('.video-el');
                if (v.srcObject === state.camStream || (v.srcObject && v.srcObject.active === false)) {
                    v.srcObject = null;
                    cell.classList.remove('has-stream', 'live');
                    cell.querySelector('.cell-status').textContent = 'IDLE';
                }
            });
            state.camOn = false;
            btn.classList.remove('active');
            stateEl.textContent = 'OFF';
            document.querySelector('.toggle-cam .toggle-icon-on').style.display = '';
            document.querySelector('.toggle-cam .toggle-icon-off').style.display = 'none';
            showToast('Kamera dimatikan', 'info');
        } else {
            // Turn ON - REAL getUserMedia
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 },
                    },
                });
                state.camStream = stream;
                state.camOn = true;
                btn.classList.add('active');
                stateEl.textContent = 'ON';
                document.querySelector('.toggle-cam .toggle-icon-on').style.display = '';
                document.querySelector('.toggle-cam .toggle-icon-off').style.display = 'none';

                // Attach stream to first video cell (CAM 01 - Host)
                const firstCell = document.querySelector('.video-cell[data-cell="0"]');
                const v = firstCell.querySelector('.video-el');
                v.srcObject = stream;
                v.muted = true; // avoid feedback
                firstCell.classList.add('has-stream');
                firstCell.querySelector('.cell-status').textContent = 'LIVE';

                // Estimate bitrate (real)
                updateBitrate(stream);

                showToast('Kamera diaktifkan - video siaran aktif', 'success');
            } catch (err) {
                console.error('Cam error:', err);
                showToast('Akses kamera ditolak: ' + err.message, 'error');
            }
        }
    }

    // -------------------------------------------------------
    // Go LIVE button - sets host to live state via backend
    // -------------------------------------------------------
    async function toggleLive() {
        const btn = $('liveToggle');
        const stateEl = $('liveState');

        if (state.liveOn) {
            // Stop broadcast
            try {
                await fetch('/api/control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'online' }),
                });
            } catch (e) {}
            state.liveOn = false;
            btn.classList.remove('active');
            stateEl.textContent = 'GO LIVE';
            showToast('Siaran dihentikan - kembali ke mode online', 'info');
        } else {
            // Start broadcast - require mic or cam
            if (!state.micOn && !state.camOn) {
                showToast('Aktifkan microphone atau kamera terlebih dahulu!', 'error');
                return;
            }
            try {
                await fetch('/api/control', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'live' }),
                });
            } catch (e) {}
            state.liveOn = true;
            btn.classList.add('active');
            stateEl.textContent = 'ON AIR';
            showToast('SIARAN LANGSUNG DIMULAI!', 'success');

            // Mark video cells as live
            document.querySelectorAll('.video-cell.has-stream').forEach(c => c.classList.add('live'));
        }
    }

    // -------------------------------------------------------
    // Real-time audio analyser (Web Audio API)
    // -------------------------------------------------------
    function setupAudioAnalyser(stream) {
        try {
            if (!state.audioContext) {
                state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            state.audioSource = state.audioContext.createMediaStreamSource(stream);
            state.analyser = state.audioContext.createAnalyser();
            state.analyser.fftSize = 64;
            state.analyser.smoothingTimeConstant = 0.6;
            state.audioSource.connect(state.analyser);

            const data = new Uint8Array(state.analyser.frequencyBinCount);
            const bars = document.querySelectorAll('.meter-bar');

            function analyze() {
                if (!state.micOn || !state.analyser) return;
                state.analyser.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                const level = Math.min(1, avg / 128);

                bars.forEach((bar, i) => {
                    const threshold = (i + 1) / bars.length;
                    bar.classList.remove('active', 'low', 'mid', 'high');
                    if (level >= threshold) {
                        bar.classList.add('active');
                        if (threshold < 0.5) bar.classList.add('low');
                        else if (threshold < 0.8) bar.classList.add('mid');
                        else bar.classList.add('high');
                    }
                });

                requestAnimationFrame(analyze);
            }
            analyze();
        } catch (e) {
            console.error('Audio analyser error:', e);
        }
    }

    function resetAudioMeter() {
        document.querySelectorAll('.meter-bar').forEach(b => {
            b.classList.remove('active', 'low', 'mid', 'high');
        });
    }

    function updateBitrate(stream) {
        const track = stream.getVideoTracks()[0];
        if (track) {
            const settings = track.getSettings();
            const w = settings.width || 1280;
            const h = settings.height || 720;
            const fps = settings.frameRate || 30;
            // Rough bitrate estimate (real calculation from settings)
            const bitrate = Math.round(w * h * fps * 0.07 / 1000);
            $('bitrateVal').textContent = bitrate + ' kbps';
        }
    }

    // -------------------------------------------------------
    // Progress bar simulation (visual)
    // -------------------------------------------------------
    function startProgressSimulation() {
        let progress = 52; // %
        let currentSec = 23.42;
        const totalSec = 75.20;

        setInterval(() => {
            progress = (progress + 0.08) % 100;
            currentSec = (currentSec + 0.1) % totalSec;

            $('progressFilled').style.width = progress + '%';
            $('progressHandle').style.left = progress + '%';

            const m = Math.floor(currentSec / 60);
            const s = (currentSec % 60).toFixed(2).padStart(5, '0');
            $('currentTime').textContent = m + ':' + s;
        }, 200);
    }

    // -------------------------------------------------------
    // RECORDING: SIMPAN VIDEO & UNDUH VIDEO (REAL MediaRecorder API)
    // -------------------------------------------------------
    function buildCombinedStream() {
        // Gabungkan video (camera) + audio (mic) jadi satu stream untuk direkam
        const tracks = [];
        if (state.camStream) {
            state.camStream.getVideoTracks().forEach(t => tracks.push(t));
        }
        if (state.micStream) {
            state.micStream.getAudioTracks().forEach(t => tracks.push(t));
        }
        if (tracks.length === 0) return null;
        return new MediaStream(tracks);
    }

    async function toggleRecord() {
        const btn = $('recordToggle');
        const stateEl = $('recordState');
        const timerEl = $('recTimer');

        if (state.isRecording) {
            // STOP recording -> simpan ke server
            stopRecording();
            return;
        }

        // START recording - require mic or cam active
        if (!state.micOn && !state.camOn) {
            showToast('Aktifkan microphone atau kamera sebelum merekam!', 'error');
            return;
        }

        const combined = buildCombinedStream();
        if (!combined) {
            showToast('Tidak ada stream yang bisa direkam', 'error');
            return;
        }
        state.combinedStream = combined;

        // Pilih format yang didukung browser
        const mimeTypes = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm;codecs=h264,opus',
            'video/webm',
            'video/mp4',
        ];
        let mimeType = '';
        for (const m of mimeTypes) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) {
                mimeType = m;
                break;
            }
        }
        if (!mimeType) {
            showToast('Browser tidak mendukung MediaRecorder', 'error');
            return;
        }

        try {
            state.mediaRecorder = new MediaRecorder(combined, {
                mimeType: mimeType,
                videoBitsPerSecond: 2_500_000, // 2.5 Mbps
                audioBitsPerSecond: 128_000,    // 128 kbps
            });
            state.recordedChunks = [];

            state.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    state.recordedChunks.push(e.data);
                }
            };

            state.mediaRecorder.onstop = () => {
                uploadRecording();
            };

            state.mediaRecorder.start(1000); // collect data every 1s
            state.isRecording = true;
            state.recordStartTime = Date.now();

            btn.classList.add('active');
            stateEl.textContent = 'STOP';
            document.querySelector('.rec-icon-record').style.display = 'none';
            document.querySelector('.rec-icon-stop').style.display = '';

            // Start timer
            state.recordTimerInterval = setInterval(() => {
                const elapsed = Math.floor((Date.now() - state.recordStartTime) / 1000);
                const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
                const s = String(elapsed % 60).padStart(2, '0');
                timerEl.textContent = m + ':' + s;
            }, 1000);

            showToast('REKAMAN DIMULAI - klik STOP untuk simpan', 'success');
        } catch (err) {
            console.error('MediaRecorder error:', err);
            showToast('Gagal memulai rekaman: ' + err.message, 'error');
        }
    }

    function stopRecording() {
        if (!state.isRecording || !state.mediaRecorder) return;

        const btn = $('recordToggle');
        const stateEl = $('recordState');
        const timerEl = $('recTimer');

        // Stop the recorder (triggers onstop -> uploadRecording)
        if (state.mediaRecorder.state !== 'inactive') {
            state.mediaRecorder.stop();
        }
        state.isRecording = false;

        // Stop timer
        clearInterval(state.recordTimerInterval);
        const duration = (Date.now() - state.recordStartTime) / 1000;
        state._lastDuration = duration;

        btn.classList.remove('active');
        stateEl.textContent = 'REKAM';
        timerEl.textContent = '00:00';
        document.querySelector('.rec-icon-record').style.display = '';
        document.querySelector('.rec-icon-stop').style.display = 'none';

        showToast('Menyimpan rekaman ke server...', 'info');
    }

    async function uploadRecording() {
        if (state.recordedChunks.length === 0) {
            showToast('Rekaman kosong, tidak ada yang disimpan', 'error');
            return;
        }

        const mimeType = state.mediaRecorder.mimeType || 'video/webm';
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(state.recordedChunks, { type: mimeType });
        const filename = `recording_${Date.now()}.${ext}`;
        const duration = state._lastDuration || 0;

        const formData = new FormData();
        formData.append('file', blob, filename);
        formData.append('title', 'Rekaman Siaran ' + new Date().toLocaleString('id-ID'));
        formData.append('duration', duration.toString());

        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Upload gagal');
            console.log('[REC] Tersimpan:', data);
            // loadRecordings akan dipanggil otomatis via socket 'recording_saved'
        } catch (err) {
            console.error('Upload error:', err);
            showToast('Gagal upload rekaman: ' + err.message, 'error');
            // Fallback: download langsung dari browser jika server gagal
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Rekaman diunduh langsung dari browser', 'info');
        }

        // Cleanup
        state.recordedChunks = [];
        state.combinedStream = null;
    }

    async function loadRecordings() {
        try {
            const res = await fetch('/api/recordings');
            const data = await res.json();
            state.recordings = data.recordings || [];
            renderRecordings();
        } catch (err) {
            console.error('Load recordings error:', err);
        }
    }

    function renderRecordings() {
        const list = $('recordingsList');
        const empty = $('recordingsEmpty');
        const countEl = $('recCount');

        countEl.textContent = state.recordings.length;

        if (state.recordings.length === 0) {
            if (empty) empty.style.display = '';
            // Hapus semua item kecuali empty placeholder
            Array.from(list.children).forEach(c => {
                if (c.id !== 'recordingsEmpty') c.remove();
            });
            return;
        }

        if (empty) empty.style.display = 'none';
        // Hapus item lama
        Array.from(list.children).forEach(c => {
            if (c.id !== 'recordingsEmpty') c.remove();
        });

        state.recordings.forEach(rec => {
            const item = document.createElement('div');
            item.className = 'recording-item';
            item.dataset.id = rec.id;

            const sizeStr = formatSize(rec.size);
            const dateStr = formatDate(rec.created_at);

            item.innerHTML = `
                <div class="rec-thumb">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
                <div class="rec-info">
                    <div class="rec-name">${rec.filename}</div>
                    <div class="rec-meta">
                        <span class="rec-size">${sizeStr}</span>
                        <span>${dateStr}</span>
                    </div>
                </div>
                <div class="rec-actions">
                    <button class="rec-btn play-btn" data-action="play" title="Putar preview">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                    <button class="rec-btn download-btn" data-action="download" title="Unduh video">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                    <button class="rec-btn delete-btn" data-action="delete" title="Hapus rekaman">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            `;

            // Bind action handlers
            item.querySelectorAll('.rec-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = btn.dataset.action;
                    if (action === 'play') playRecording(rec);
                    else if (action === 'download') downloadRecording(rec);
                    else if (action === 'delete') deleteRecording(rec);
                });
            });

            list.appendChild(item);
        });
    }

    function playRecording(rec) {
        const modal = $('videoModal');
        const video = $('modalVideo');
        const title = $('modalTitle');
        state.currentModalRec = rec;

        title.textContent = 'Preview: ' + rec.filename;
        video.src = rec.url;
        video.load();
        modal.classList.add('show');
        video.play().catch(() => {});
    }

    function closeModal() {
        const modal = $('videoModal');
        const video = $('modalVideo');
        video.pause();
        video.src = '';
        modal.classList.remove('show');
        state.currentModalRec = null;
    }

    function downloadRecording(rec) {
        // Trigger download via direct URL (server send as attachment)
        const a = document.createElement('a');
        a.href = rec.url;
        a.download = rec.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast('Mengunduh: ' + rec.filename, 'success');
    }

    async function deleteRecording(rec) {
        if (!confirm('Hapus rekaman "' + rec.filename + '"?')) return;
        try {
            const res = await fetch('/api/delete/' + encodeURIComponent(rec.filename), {
                method: 'DELETE',
            });
            if (!res.ok) throw new Error('Hapus gagal');
            showToast('Rekaman dihapus', 'info');
            loadRecordings();
        } catch (err) {
            showToast('Gagal hapus: ' + err.message, 'error');
        }
    }

    function formatSize(bytes) {
        if (!bytes) return '—';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function formatDate(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleString('id-ID', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        } catch { return ''; }
    }


    // -------------------------------------------------------
    // Bind all controls
    // -------------------------------------------------------
    function bindControls() {
        $('micToggle').addEventListener('click', toggleMic);
        $('camToggle').addEventListener('click', toggleCam);
        $('liveToggle').addEventListener('click', toggleLive);
        $('recordToggle').addEventListener('click', toggleRecord);

        // Recordings panel
        $('refreshRecs').addEventListener('click', () => {
            loadRecordings();
            showToast('Daftar rekaman diperbarui', 'info');
        });

        // Video modal
        $('modalClose').addEventListener('click', closeModal);
        $('videoModal').addEventListener('click', (e) => {
            if (e.target.id === 'videoModal') closeModal();
        });
        $('modalDownload').addEventListener('click', () => {
            if (state.currentModalRec) downloadRecording(state.currentModalRec);
        });

        $('reloadBtn').addEventListener('click', () => {
            // Real backend call: reset to offline
            fetch('/api/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'offline' }),
            }).then(() => {
                state.liveOn = false;
                $('liveToggle').classList.remove('active');
                $('liveState').textContent = 'GO LIVE';
                showToast('Status direset ke OFFLINE', 'info');
            });
        });

        $('advanceBtn').addEventListener('click', () => {
            // Real backend call: advance stage
            if (state.socket) {
                state.socket.emit('request_stage_advance');
                showToast('Tahap host dimajukan', 'info');
            }
        });

        $('playBtn').addEventListener('click', () => {
            const icon = $('playIcon');
            const isPlaying = icon.dataset.playing === '1';
            if (isPlaying) {
                icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>';
                icon.dataset.playing = '0';
                showToast('Playback dijeda', 'info');
            } else {
                icon.innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
                icon.dataset.playing = '1';
                showToast('Playback berjalan', 'info');
            }
        });

        $('volumeBtn').addEventListener('click', () => {
            showToast('Kontrol volume - gunakan slider sistem', 'info');
        });

        $('fullscreenBtn').addEventListener('click', () => {
            const stream = document.querySelector('.stream-area');
            if (!document.fullscreenElement) {
                stream.requestFullscreen?.().catch(() => {});
            } else {
                document.exitFullscreen?.();
            }
        });
    }

    // -------------------------------------------------------
    // Boot
    // -------------------------------------------------------
    window.addEventListener('load', () => {
        // Pre-warm: small delay to ensure DOM ready
        setTimeout(startLoading, 300);
    });

    // Handle unload
    window.addEventListener('beforeunload', () => {
        if (state.socket) {
            state.socket.emit('viewer_leave');
        }
        // Stop recording jika sedang aktif
        if (state.isRecording && state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
            try { state.mediaRecorder.stop(); } catch (e) {}
        }
        if (state.micStream) state.micStream.getTracks().forEach(t => t.stop());
        if (state.camStream) state.camStream.getTracks().forEach(t => t.stop());
    });

})();
