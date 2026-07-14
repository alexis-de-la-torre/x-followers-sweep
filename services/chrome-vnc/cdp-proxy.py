#!/usr/bin/env python3
"""CDP proxy: forwards 0.0.0.0:CDP_PORT -> 127.0.0.1:CDP_PORT"""
import socket, sys, threading

CDP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222

def forward(src, dst):
    while True:
        try:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
        except:
            break
    src.close()
    dst.close()

def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', CDP_PORT))
    srv.listen(50)
    srv.settimeout(None)
    with open('/tmp/cdp-proxy.log', 'w') as f:
        f.write(f'Proxy listening on 0.0.0.0:{CDP_PORT}\n')
    while True:
        client, addr = srv.accept()
        target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            target.connect(('127.0.0.1', CDP_PORT))
            threading.Thread(target=forward, args=(client, target), daemon=True).start()
            threading.Thread(target=forward, args=(target, client), daemon=True).start()
        except Exception as e:
            with open('/tmp/cdp-proxy.log', 'a') as f:
                f.write(f'Connection from {addr} failed: {e}\n')
            client.close()

if __name__ == '__main__':
    main()