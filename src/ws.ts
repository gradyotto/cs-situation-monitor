import { WebSocket, WebSocketServer } from 'ws';
import { WsMessage } from './types';

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

export function initWss(server: import('http').Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return wss;
}

export function broadcast(message: WsMessage): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function getConnectedClientCount(): number {
  return clients.size;
}
