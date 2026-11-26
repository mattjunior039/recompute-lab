// WebSocket to the Hub that reconnects by itself (Wi-Fi blips, Hub restarts).

export class HubSocket<In, Out> {
  ws: WebSocket | null = null;
  open = false;
  private wait = 500;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private path: string,
    private handlers: { onOpen?: () => void; onMessage: (m: In) => void; onClose?: (code: number, reason: string) => void },
    /** Sees every outgoing message as text; returning null stops it from being sent. */
    private check?: (text: string) => string | null,
  ) {
    this.connect();
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${this.path}`;
  }

  private connect() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.wait = 500;
      this.handlers.onOpen?.();
      this.pingTimer = setInterval(() => this.send({ type: 'ping' } as Out), 15_000);
    };
    ws.onmessage = (e) => {
      try {
        this.handlers.onMessage(JSON.parse(String(e.data)));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      const was = this.open;
      this.open = false;
      this.ws = null;
      if (was || e.code >= 4000) this.handlers.onClose?.(e.code, e.reason);
      // 4001 wrong room · 4002 this device opened Recompute in a newer tab · 4003/4004 Hub-node refused/turned off.
      // Retrying would just fight the other tab, so stop until the user asks.
      if (e.code >= 4001 && e.code <= 4004) return;
      this.retry();
    };
    ws.onerror = () => {};
  }

  private retry() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, this.wait);
    this.wait = Math.min(5000, this.wait * 1.6);
  }

  reconnectNow() {
    if (this.open) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wait = 500;
    this.connect();
  }

  send(m: Out) {
    if (this.ws && this.ws.readyState === 1) {
      const text = this.check ? this.check(JSON.stringify(m)) : JSON.stringify(m);
      if (text === null) return false;
      this.ws.send(text);
      return true;
    }
    return false;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
