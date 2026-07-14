#!/usr/bin/env python3
"""CDP proxy: forwards 0.0.0.0:LISTEN_PORT -> 127.0.0.1:TARGET_PORT
Rewrites Host header to '127.0.0.1' so Chrome accepts the request."""
import socket, sys, threading, re

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else LISTEN_PORT

HOST_RE = re.compile(rb'^Host:\s*\S+', re.IGNORECASE | re.MULTILINE)

def forward_with_rewrite(src, dst):
    buf = b''
    while True:
        try:
            data = src.recv(65536)
            if not data: break
            buf += data
            # Once we have the full headers, rewrite Host
            if b'\r\n\r\n' in buf:
                headers, body = buf.split(b'\r\n\r\n', 1)
                headers = HOST_RE.sub(b'Host: 127.0.0.1', headers)
                # Add Connection: close to prevent Chrome from keeping alive
                if b'Connection:' not in headers:
                    headers += b'\r\nConnection: close'
                dst.sendall(headers + b'\r\n\r\n' + body)
                buf = b''
                break
        except: break
    # Forward rest of body data
    while True:
        try:
            data = src.recv(65536)
            if not data: break
            dst.sendall(data)
        except: break
    for s in (src, dst):
        try: s.close()
        except: pass

def forward_passthrough(src, dst):
    while True:
        try:
            data = src.recv(65536)
            if not data: break
            dst.sendall(data)
        except: break
    for s in (src, dst):
        try: s.close()
        except: pass

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('0.0.0.0', LISTEN_PORT))
srv.listen(50)
srv.settimeout(None)

with open('/tmp/cdp-proxy.log', 'w') as f:
    f.write(f'Proxy 0.0.0.0:{LISTEN_PORT} -> 127.0.0.1:{TARGET_PORT} started\n')

while True:
    client, addr = srv.accept()
    target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        target.connect(('127.0.0.1', TARGET_PORT))
        threading.Thread(target=forward_with_rewrite, args=(client, target), daemon=True).start()
        threading.Thread(target=forward_passthrough, args=(target, client), daemon=True).start()
    except Exception as e:
        with open('/tmp/cdp-proxy.log', 'a') as f:
            f.write(f'Connection from {addr} failed: {e}\n')
        client.close()