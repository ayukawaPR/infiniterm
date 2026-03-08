import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as os from 'os';
import { EventEmitter } from 'events';

// ---- Protocol types ----

export interface SharedTabInfo {
  id: number;
  title: string;
  cols: number;
  rows: number;
}

export type ShareMessage =
  | { type: 'auth'; code: string }
  | { type: 'auth-ok' }
  | { type: 'auth-fail' }
  | { type: 'sync'; tabs: SharedTabInfo[]; activeTabId: number }
  | { type: 'buffer'; tabId: number; data: string }
  | { type: 'data'; tabId: number; data: string }
  | { type: 'tab-created'; tab: SharedTabInfo }
  | { type: 'tab-closed'; tabId: number }
  | { type: 'tab-activated'; tabId: number }
  | { type: 'tab-title'; tabId: number; title: string }
  | { type: 'input'; tabId: number; data: string }
  | { type: 'resize'; tabId: number; cols: number; rows: number };

const MAX_BUFFER = 1024 * 1024; // 1MB per tab

// ---- Helpers ----

export function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---- Sharing Server (host side) ----

export class SharingServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private code: string;
  private port: number = 0;
  private authedClients: Set<WebSocket> = new Set();
  private tabs: Map<number, SharedTabInfo> = new Map();
  private tabBuffers: Map<number, string> = new Map();
  private activeTabId: number = -1;

  constructor() {
    super();
    this.code = String(Math.floor(100000 + Math.random() * 900000));
  }

  getCode(): string { return this.code; }
  getPort(): number { return this.port; }
  getClientCount(): number { return this.authedClients.size; }

  async start(): Promise<{ port: number; code: string; ip: string }> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => this.handleConnection(ws));

      this.httpServer.listen(0, () => {
        const addr = this.httpServer!.address() as { port: number };
        this.port = addr.port;
        const ip = getLocalIP();
        resolve({ port: this.port, code: this.code, ip });
      });

      this.httpServer.on('error', reject);
    });
  }

  stop(): void {
    for (const ws of this.authedClients) {
      try { ws.close(); } catch {}
    }
    this.authedClients.clear();
    this.wss?.close();
    this.httpServer?.close();
    this.wss = null;
    this.httpServer = null;
  }

  addTab(tab: SharedTabInfo): void {
    this.tabs.set(tab.id, { ...tab });
    this.tabBuffers.set(tab.id, '');
    this.broadcast({ type: 'tab-created', tab });
  }

  removeTab(tabId: number): void {
    this.tabs.delete(tabId);
    this.tabBuffers.delete(tabId);
    this.broadcast({ type: 'tab-closed', tabId });
  }

  setActiveTab(tabId: number): void {
    this.activeTabId = tabId;
    this.broadcast({ type: 'tab-activated', tabId });
  }

  setTabTitle(tabId: number, title: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) tab.title = title;
    this.broadcast({ type: 'tab-title', tabId, title });
  }

  feedData(tabId: number, data: string): void {
    let buf = this.tabBuffers.get(tabId) ?? '';
    buf += data;
    if (buf.length > MAX_BUFFER) {
      buf = buf.slice(buf.length - MAX_BUFFER);
    }
    this.tabBuffers.set(tabId, buf);
    this.broadcast({ type: 'data', tabId, data });
  }

  resizeTab(tabId: number, cols: number, rows: number): void {
    const tab = this.tabs.get(tabId);
    if (tab) { tab.cols = cols; tab.rows = rows; }
    this.broadcast({ type: 'resize', tabId, cols, rows });
  }

  private handleConnection(ws: WebSocket): void {
    let authed = false;

    const timeout = setTimeout(() => {
      if (!authed) ws.close();
    }, 10000);

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!authed) {
        if (msg.type === 'auth' && msg.code === this.code) {
          authed = true;
          clearTimeout(timeout);
          this.authedClients.add(ws);
          this.emit('client-connected');

          ws.send(JSON.stringify({ type: 'auth-ok' }));

          // Send full sync
          ws.send(JSON.stringify({
            type: 'sync',
            tabs: [...this.tabs.values()],
            activeTabId: this.activeTabId,
          }));

          // Send buffered data for each tab
          for (const [tabId, buf] of this.tabBuffers) {
            if (buf.length > 0) {
              ws.send(JSON.stringify({ type: 'buffer', tabId, data: buf }));
            }
          }
        } else {
          ws.send(JSON.stringify({ type: 'auth-fail' }));
          ws.close();
        }
        return;
      }

      // Authenticated client messages
      if (msg.type === 'input') {
        this.emit('remote-input', msg.tabId, msg.data);
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      this.authedClients.delete(ws);
      if (authed) this.emit('client-disconnected');
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      this.authedClients.delete(ws);
    });
  }

  private broadcast(msg: object): void {
    if (this.authedClients.size === 0) return;
    const json = JSON.stringify(msg);
    for (const ws of this.authedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(json); } catch {}
      }
    }
  }
}

// ---- Sharing Client (viewer side) ----

export class SharingClient extends EventEmitter {
  private ws: WebSocket | null = null;

  async connect(host: string, port: number, code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${host}:${port}`;
      this.ws = new WebSocket(url);

      let resolved = false;

      this.ws.on('open', () => {
        this.ws!.send(JSON.stringify({ type: 'auth', code }));
      });

      this.ws.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (!resolved) {
          if (msg.type === 'auth-ok') {
            resolved = true;
            resolve();
            return;
          } else if (msg.type === 'auth-fail') {
            resolved = true;
            this.ws?.close();
            reject(new Error('Authentication failed'));
            return;
          }
        }

        this.emit('message', msg);
      });

      this.ws.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Connection closed'));
        }
        this.emit('disconnected');
      });
    });
  }

  sendInput(tabId: number, data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'input', tabId, data }));
    }
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
