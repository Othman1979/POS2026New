"""Loopback model of a network thermal printer's input side. No paper, no real device.

- Small TCP receive window (SO_RCVBUF), as on embedded printer stacks.
- Fixed device buffer drained at a print rate (bytes/s): TCP back-pressure is real.
- Session policy:
    single  serve one connection at a time, FIFO; later ones are accepted by the TCP
            stack but not read until the earlier one ends (Epson-style single session)
    merge   read every open connection into one parser buffer (multi-session printers)
    refuse  reset a connection that arrives while another is open
- Optional stall: stop consuming for --stall-ms once --stall-at bytes were consumed
  (paper change, cover open, head overheat).
On 'quit' (stdin) writes device.bin (parser input, in order), segments.json and
connections.json to --out.
"""
import argparse, collections, json, os, socket, struct, sys, threading, time

p = argparse.ArgumentParser()
p.add_argument('--mode', choices=['single', 'merge', 'refuse'], default='single')
p.add_argument('--rcvbuf', type=int, default=4096)
p.add_argument('--rate', type=int, default=60000)
p.add_argument('--device-buffer', type=int, default=16384)
p.add_argument('--stall-at', type=int, default=-1)
p.add_argument('--stall-ms', type=int, default=0)
p.add_argument('--out', required=True)
a = p.parse_args()

lock = threading.Condition()
buffered = collections.deque()          # (conn_id, bytearray) awaiting the parser
buffered_bytes = 0
consumed = []                            # (conn_id, bytes) in parser order
consumed_bytes = 0
conns = []                               # connection log
queue = collections.deque()              # single mode FIFO of conn ids
stopping = False
last_activity = time.monotonic()
t0 = time.monotonic()

def now_ms():
    return round((time.monotonic() - t0) * 1000)

def reader(cid, sock):
    global buffered_bytes, last_activity
    info = conns[cid]
    try:
        if a.mode == 'single':
            with lock:
                while not stopping and queue[0] != cid:
                    lock.wait(0.05)
        info['first_read_ms'] = None
        while not stopping:
            with lock:
                while not stopping and buffered_bytes >= a.device_buffer:
                    lock.wait(0.02)
                room = a.device_buffer - buffered_bytes
            if stopping:
                break
            data = sock.recv(max(1, min(room, 4096)))
            if not data:
                info['end'] = 'eof'
                break
            if b'\x10\x04' in data:
                sock.sendall(b'\x12')  # DLE EOT reply (online, no error) from the session being read
            with lock:
                if info['first_read_ms'] is None:
                    info['first_read_ms'] = now_ms()
                buffered.append((cid, bytearray(data)))
                buffered_bytes += len(data)
                info['bytes'] += len(data)
                last_activity = time.monotonic()
                lock.notify_all()
    except (ConnectionResetError, ConnectionAbortedError, OSError) as error:
        info['end'] = f'reset:{type(error).__name__}'
    finally:
        info['ended_ms'] = now_ms()
        try:
            sock.close()
        except OSError:
            pass
        with lock:
            if a.mode == 'single' and queue and queue[0] == cid:
                queue.popleft()
            lock.notify_all()

def consumer():
    global buffered_bytes, consumed_bytes, last_activity
    stalled = False
    tick = 0.005
    budget = 0.0
    while not stopping:
        time.sleep(tick)
        if not stalled and a.stall_at >= 0 and consumed_bytes >= a.stall_at:
            stalled = True
            time.sleep(a.stall_ms / 1000)
        budget = min(budget + a.rate * tick, a.rate * 0.05)
        with lock:
            while budget >= 1 and buffered:
                cid, chunk = buffered[0]
                take = min(len(chunk), int(budget))
                piece = bytes(chunk[:take])
                del chunk[:take]
                if not chunk:
                    buffered.popleft()
                if consumed and consumed[-1][0] == cid:
                    consumed[-1] = (cid, consumed[-1][1] + piece)
                else:
                    consumed.append((cid, piece))
                buffered_bytes -= take
                consumed_bytes += take
                budget -= take
                last_activity = time.monotonic()
            if not buffered:
                budget = min(budget, a.rate * tick)
            lock.notify_all()

def status():
    while not stopping:
        with lock:
            open_conns = sum(1 for c in conns if c.get('ended_ms') is None)
            line = {'type': 'status', 'consumed': consumed_bytes, 'buffered': buffered_bytes, 'open': open_conns,
                    'conns': len(conns), 'idle_ms': round((time.monotonic() - last_activity) * 1000)}
        print(json.dumps(line), flush=True)
        time.sleep(0.25)

server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, a.rcvbuf)
server.bind(('127.0.0.1', 0))
server.listen(8)
server.settimeout(0.05)
print(json.dumps({'type': 'ready', 'port': server.getsockname()[1]}), flush=True)
threading.Thread(target=consumer, daemon=True).start()
threading.Thread(target=status, daemon=True).start()

def stdin_watch():
    global stopping
    for line in sys.stdin:
        if line.strip() == 'quit':
            break
    with lock:
        stopping = True
        lock.notify_all()
threading.Thread(target=stdin_watch, daemon=True).start()

while not stopping:
    try:
        sock, peer = server.accept()
    except socket.timeout:
        continue
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, a.rcvbuf)
    with lock:
        cid = len(conns)
        busy = any(c.get('ended_ms') is None for c in conns)
        conns.append({'id': cid, 'peer_port': peer[1], 'accepted_ms': now_ms(), 'bytes': 0, 'end': None, 'ended_ms': None})
        if a.mode == 'refuse' and busy:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('hh', 1, 0))
            sock.close()
            conns[cid].update(end='refused', ended_ms=now_ms())
            continue
        if a.mode == 'single':
            queue.append(cid)
    threading.Thread(target=reader, args=(cid, sock), daemon=True).start()

time.sleep(0.1)
os.makedirs(a.out, exist_ok=True)
with lock:
    stream = b''.join(piece for _, piece in consumed)
    with open(os.path.join(a.out, 'device.bin'), 'wb') as f:
        f.write(stream)
    with open(os.path.join(a.out, 'segments.json'), 'w') as f:
        json.dump([{'conn': cid, 'length': len(piece)} for cid, piece in consumed], f)
    with open(os.path.join(a.out, 'connections.json'), 'w') as f:
        json.dump({'mode': a.mode, 'rcvbuf': a.rcvbuf, 'rate': a.rate, 'device_buffer': a.device_buffer,
                   'unconsumed_bytes': buffered_bytes, 'connections': conns}, f, indent=1)
print(json.dumps({'type': 'done', 'consumed': consumed_bytes}), flush=True)
