#!/usr/bin/env python3
"""CDP proxy: forwards 0.0.0.0:LISTEN_PORT -> 127.0.0.1:TARGET_PORT"""
import socket, sys, threading, os

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
TARGET_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else LISTEN_PORT

def forward(src, dst):
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

log = open('/tmp/cdp-proxy.log', 'w')
log.write(f'Proxy 0.0.0.0:{LISTEN_PORT} -> 127.0.0.1:{TARGET_PORT} started\n')
log.flush()

while True:
    client, addr = srv.accept()
    target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        target.connect(('127.0.0.1', TARGET_PORT))
        threading.Thread(target=forward, args=(client, target), daemon=True).start()
        threading.Thread(target=forward, args=(target, client), daemon=True).start()
    except Exception as e:
        log.write(f'Connection from {addr} failed: {e}\n')
        log.flush()
        client.close()