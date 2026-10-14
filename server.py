"""
RUANG SIARAN — Server Python (Flask)
pip install flask  →  python server.py  →  buka http://localhost:5000
"""
import os, time, threading
from flask import Flask, request, jsonify, send_from_directory

BASE = os.path.dirname(os.path.abspath(__file__))
REC_DIR = os.path.join(BASE, "recordings"); os.makedirs(REC_DIR, exist_ok=True)
app = Flask(__name__, static_folder=BASE, static_url_path="")

_state = {"status": "offline", "updated_at": 0.0}
_lock = threading.Lock()
_clients, _chat, _chat_id = {}, [], 0
VALID = ("offline", "online", "live")

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

@app.post("/api/heartbeat")
def heartbeat():
    global _clients
    cid = (request.get_json(silent=True) or {}).get("id") or request.remote_addr
    with _lock:
        _clients = {k: v for k, v in _clients.items() if time.time() - v < 10}
        _clients[cid] = time.time()
        return jsonify(ok=True, viewers=len(_clients))

@app.get("/api/chat")
def chat_get():
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

@app.get("/api/recordings")
def recordings():
    with _lock: pass
    items = [{"name": n, "size": os.path.getsize(os.path.join(REC_DIR, n)), "url": f"/recordings/{n}"}
             for n in sorted(os.listdir(REC_DIR), reverse=True) if os.path.isfile(os.path.join(REC_DIR, n))]
    return jsonify(ok=True, items=items)

@app.get("/recordings/<path:name>")
def rec_file(name): return send_from_directory(REC_DIR, name)

if __name__ == "__main__":
    print("RUANG SIARAN server aktif -> http://0.0.0.0:5000")
    app.run(host="0.0.0.0", port=5000, threaded=True)
