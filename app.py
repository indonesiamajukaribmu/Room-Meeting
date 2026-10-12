#!/usr/bin/env python3
"""
Real-Time Streaming Hub - Python + HTML Application
====================================================
Server backend Flask + Flask-SocketIO yang melayani:
  - Halaman utama (loading screen + streaming UI)
  - WebSocket events untuk status host real-time
  - REST endpoint untuk kontrol host (online/offline/live)

Cara menjalankan:
    pip install -r requirements.txt
    python app.py

Lalu buka browser ke: http://localhost:5000
"""

import os
import time
import threading
import logging
import glob as globmod
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory, abort
from flask_socketio import SocketIO, emit
from werkzeug.utils import secure_filename

# ----------------------------------------------------------------------------
# Konfigurasi aplikasi
# ----------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")
RECORDINGS_DIR = os.path.join(BASE_DIR, "recordings")
os.makedirs(RECORDINGS_DIR, exist_ok=True)

app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
)
app.config["SECRET_KEY"] = "streaming-hub-secret-2026"
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("streaming-hub")

# ----------------------------------------------------------------------------
# State host global (real, shared across clients via SocketIO)
# ----------------------------------------------------------------------------
# Status: "offline" | "online" | "live"
HOST_STATE = {
    "status": "offline",          # red / orange / green
    "stage_index": 0,             # 0..9 (multi-titik progression awal -> akhir)
    "total_stages": 10,           # jumlah titik tahap
    "viewers": 0,
    "started_at": None,
    "last_change": datetime.now().isoformat(),
    "host_name": "Host Utama",
    "stream_title": "Siaran Langsung Komunitas",
}

# Lock untuk akses state konkuren
state_lock = threading.Lock()


# ----------------------------------------------------------------------------
# Routes HTTP
# ----------------------------------------------------------------------------
@app.route("/")
def index():
    """Halaman utama: loading screen -> streaming UI."""
    return render_template("index.html")


@app.route("/api/state")
def get_state():
    """Endpoint REST untuk mendapatkan state host saat ini."""
    with state_lock:
        return jsonify(HOST_STATE)


@app.route("/api/control", methods=["POST"])
def control():
    """Kontrol status host dari UI button (real backend state change)."""
    data = request.get_json(force=True)
    new_status = data.get("status")  # offline | online | live
    if new_status not in ("offline", "online", "live"):
        return jsonify({"error": "status tidak valid"}), 400

    with state_lock:
        HOST_STATE["status"] = new_status
        HOST_STATE["last_change"] = datetime.now().isoformat()
        if new_status == "live" and HOST_STATE["started_at"] is None:
            HOST_STATE["started_at"] = datetime.now().isoformat()
        elif new_status == "offline":
            HOST_STATE["started_at"] = None
            HOST_STATE["stage_index"] = 0
        elif new_status == "online":
            HOST_STATE["stage_index"] = 4  # pertengahan
        elif new_status == "live":
            HOST_STATE["stage_index"] = 9  # tahap akhir

    # Broadcast ke semua client (real-time)
    socketio.emit("host_state_update", HOST_STATE)
    log.info("Host status berubah -> %s (stage %s)", new_status, HOST_STATE["stage_index"])
    return jsonify(HOST_STATE)


# ----------------------------------------------------------------------------
# RECORDING ENDPOINTS - Simpan & Unduh Video
# ----------------------------------------------------------------------------
ALLOWED_VIDEO_EXT = {".webm", ".mp4", ".mkv", ".mov", ".avi"}


@app.route("/api/upload", methods=["POST"])
def upload_recording():
    """Terima file rekaman video dari browser (POST multipart/form-data).

    Field:
      - file:        file video (webm/mp4)
      - title:       judul rekaman (opsional)
      - duration:    durasi dalam detik (opsional)
    """
    if "file" not in request.files:
        return jsonify({"error": "file tidak ditemukan"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "filename kosong"}), 400

    # Sanitize filename + tambahkan timestamp
    safe_name = secure_filename(f.filename) or "recording.webm"
    _, ext = os.path.splitext(safe_name)
    if ext.lower() not in ALLOWED_VIDEO_EXT:
        return jsonify({"error": f"ekstensi {ext} tidak diizinkan"}), 400

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    final_name = f"rec_{timestamp}{ext.lower()}"
    final_path = os.path.join(RECORDINGS_DIR, final_name)

    # Simpan file ke disk (real, bukan simulasi)
    f.save(final_path)

    size_bytes = os.path.getsize(final_path)
    title = request.form.get("title", "Rekaman Siaran")
    duration = float(request.form.get("duration", 0))

    meta = {
        "id": final_name,
        "filename": final_name,
        "title": title,
        "size": size_bytes,
        "duration": duration,
        "created_at": datetime.now().isoformat(),
        "url": f"/api/download/{final_name}",
    }
    log.info("Rekaman tersimpan: %s (%.2f MB)", final_name, size_bytes / 1e6)

    # Broadcast ke semua client bahwa ada rekaman baru
    socketio.emit("recording_saved", meta)
    return jsonify(meta)


@app.route("/api/recordings")
def list_recordings():
    """Daftar semua rekaman video tersimpan di server."""
    recordings = []
    for path in sorted(globmod.glob(os.path.join(RECORDINGS_DIR, "rec_*.*")), reverse=True):
        fname = os.path.basename(path)
        size = os.path.getsize(path)
        mtime = os.path.getmtime(path)
        recordings.append({
            "id": fname,
            "filename": fname,
            "title": "Rekaman " + fname,
            "size": size,
            "duration": 0,
            "created_at": datetime.fromtimestamp(mtime).isoformat(),
            "url": f"/api/download/{fname}",
        })
    return jsonify({"recordings": recordings, "count": len(recordings)})


@app.route("/api/download/<path:filename>")
def download_recording(filename):
    """Unduh file rekaman video dari server."""
    safe = secure_filename(filename)
    path = os.path.join(RECORDINGS_DIR, safe)
    if not os.path.isfile(path) or not safe.startswith("rec_"):
        abort(404)
    log.info("Mengunduh rekaman: %s", safe)
    return send_from_directory(
        RECORDINGS_DIR, safe, as_attachment=True, download_name=safe
    )


@app.route("/api/delete/<path:filename>", methods=["DELETE"])
def delete_recording(filename):
    """Hapus rekaman video dari server."""
    safe = secure_filename(filename)
    if not safe.startswith("rec_"):
        return jsonify({"error": "filename tidak valid"}), 400
    path = os.path.join(RECORDINGS_DIR, safe)
    if not os.path.isfile(path):
        return jsonify({"error": "file tidak ditemukan"}), 404
    os.remove(path)
    log.info("Rekaman dihapus: %s", safe)
    return jsonify({"deleted": safe})


# ----------------------------------------------------------------------------
# WebSocket events
# ----------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    """Client baru terhubung -> kirim state terkini."""
    with state_lock:
        emit("host_state_update", HOST_STATE)
    log.info("Client terhubung: %s", request.sid)


@socketio.on("disconnect")
def on_disconnect():
    log.info("Client terputus: %s", request.sid)


@socketio.on("request_stage_advance")
def advance_stage(data=None):
    """Client meminta maju ke titik tahap berikutnya (real progression)."""
    with state_lock:
        if HOST_STATE["stage_index"] < HOST_STATE["total_stages"] - 1:
            HOST_STATE["stage_index"] += 1
            HOST_STATE["last_change"] = datetime.now().isoformat()
            # Auto-update status berdasarkan stage
            if HOST_STATE["stage_index"] < 4:
                HOST_STATE["status"] = "offline"
            elif HOST_STATE["stage_index"] < 9:
                HOST_STATE["status"] = "online"
            else:
                HOST_STATE["status"] = "live"
        socketio.emit("host_state_update", HOST_STATE)


@socketio.on("viewer_join")
def viewer_join():
    """Viewer baru masuk -> increment counter real-time."""
    with state_lock:
        HOST_STATE["viewers"] += 1
        emit("viewer_count", {"count": HOST_STATE["viewers"]}, broadcast=True)


@socketio.on("viewer_leave")
def viewer_leave():
    with state_lock:
        HOST_STATE["viewers"] = max(0, HOST_STATE["viewers"] - 1)
        emit("viewer_count", {"count": HOST_STATE["viewers"]}, broadcast=True)


# ----------------------------------------------------------------------------
# Background tick: detak jam real-time untuk status card (seperti screenshot 825)
# ----------------------------------------------------------------------------
def clock_ticker():
    """Kirim update waktu setiap detik ke semua client (untuk card kanan atas)."""
    while True:
        socketio.sleep(1)
        now = datetime.now()
        socketio.emit(
            "clock_tick",
            {
                "time": now.strftime("%H:%M:%S"),
                "date": now.strftime("%A, %d %b %Y"),
                "iso": now.isoformat(),
            },
        )


# ----------------------------------------------------------------------------
# Main entry
# ----------------------------------------------------------------------------
if __name__ == "__main__":
    log.info("=" * 60)
    log.info("  REAL-TIME STREAMING HUB")
    log.info("  Python + HTML + WebRTC combination")
    log.info("=" * 60)
    log.info("Buka browser ke: http://localhost:5000")

    # Start background clock thread
    ticker_thread = threading.Thread(target=clock_ticker, daemon=True)
    ticker_thread.start()

    # Jalankan server SocketIO (real, bukan simulasi)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
