"""
RUANG SIARAN — Server Python (Flask)
pip install flask  →  python server.py  →  buka https://indonesiamajukaribmu.github.io/Room-Meeting/

Peserta: setiap browser yang membuka halaman ini otomatis terdaftar via
/api/join + /api/heartbeat, dan muncul di panel PARTICIPANTS semua pengunjung.
"""
import os, time, threading
from flask import Flask, request, jsonify, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
REC_DIR = os.path.join(BASE, "recordings"); os.makedirs(REC_DIR, exist_ok=True)
app = Flask(__name__, static_folder=BASE, static_url_path="")

_state = {"status": "offline", "updated_at": 0.0}
_lock = threading.Lock()
_participants = {}          # id -> {name, t}
_chat, _chat_id = [], 0
VALID = ("offline", "online", "live")
TTL = 15.0                  # detik dianggap hilang

def _prune():
    now = time.time()
    for k in [k for k, v in _participants.items() if now - v["t"] > TTL]:
        del _participants[k]

@app.get("/")
def home(): return send_from_directory(BASE, "index.html")

@app.get("/api/health")
def health(): return jsonify(ok=True, service="ruang-siaran")

@app.get("/api/status")
def get_status():
    with _lock: return jsonify(ok=True, **_state)

@app.post("/api/status")
def set_status():
    st = (request.get_json(silent=True) or {}).get("status")
    if st not in VALID: return jsonify(ok=False, error="status tidak valid"), 400
    with _lock:
        _state["status"] = st; _state["updated_at"] = time.time()
        return jsonify(ok=True, **_state)

@app.post("/api/join")
def join():
    d = request.get_json(silent=True, force=True) or {}
    pid = str(d.get("id") or request.remote_addr)[:64]
    name = str(d.get("name", "Tamu"))[:30]
    with _lock:
        _participants[pid] = {"name": name, "t": time.time()}
        return jsonify(ok=True)

@app.post("/api/leave")
def leave():
    d = request.get_json(silent=True, force=True) or {}
    pid = str(d.get("id") or request.remote_addr)[:64]
    with _lock: _participants.pop(pid, None)
    return jsonify(ok=True)

@app.post("/api/heartbeat")
def heartbeat():
    d = request.get_json(silent=True, force=True) or {}
    pid = str(d.get("id") or request.remote_addr)[:64]
    name = str(d.get("name", "Tamu"))[:30]
    with _lock:
        _prune()
        _participants[pid] = {"name": name, "t": time.time()}
        return jsonify(ok=True, viewers=len(_participants),
                       participants=[{"id": k, "name": v["name"]} for k, v in _participants.items()])

@app.get("/api/participants")
def participants():
    with _lock:
        _prune()
        return jsonify(ok=True, participants=[{"id": k, "name": v["name"]} for k, v in _participants.items()])

@app.get("/api/chat")
def chat_get():
    global _chat
    after = int(request.args.get("after", 0))
    with _lock:
        items = [c for c in _chat if c["id"] > after][-100:]
    return jsonify(ok=True, items=items)

@app.post("/api/chat")
def chat_post():
    global _chat, _chat_id
    d = request.get_json(silent=True) or {}
    name, text = str(d.get("name", "?"))[:30], str(d.get("text", ""))[:300]
    if not text.strip(): return jsonify(ok=False), 400
    with _lock:
        _chat_id += 1
        _chat.append({"id": _chat_id, "name": name, "text": text, "t": time.time()})
        _chat = _chat[-200:]
    return jsonify(ok=True)

@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if not f: return jsonify(ok=False, error="file kosong"), 400
    name = os.path.basename(time.strftime('%Y%m%d-%H%M%S-') + f.filename).replace("..", "_")
    f.save(os.path.join(REC_DIR, name))
    return jsonify(ok=True, name=name, size=os.path.getsize(os.path.join(REC_DIR, name)))

@app.get("/recordings/<path:name>")
def rec_file(name): return send_from_directory(REC_DIR, name)

if __name__ == "__main__":
    print("RUANG SIARAN server aktif -> http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, threaded=True)
