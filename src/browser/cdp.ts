type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string };
type Listener = (params: any) => void;

export class CdpError extends Error {}

export const CONNECTION_CLOSED = 'Browser connection closed';

// One WebSocket to the browser; page sessions are multiplexed on it (flatten mode).
export class Connection {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<Listener>>();
  #closed: Error | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data as string));
    ws.addEventListener('close', () => this.#fail(new CdpError(CONNECTION_CLOSED)));
  }

  static open(url: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onError = () => reject(new CdpError(`Cannot connect to the browser at ${url}`));
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener(
        'open',
        () => {
          ws.removeEventListener('error', onError);
          resolve(new Connection(ws));
        },
        { once: true },
      );
    });
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(message));
    });
  }

  on(event: string, listener: Listener, sessionId = ''): () => void {
    const key = `${sessionId}:${event}`;
    let set = this.#listeners.get(key);
    if (!set) this.#listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.#ws.addEventListener('close', () => resolve(), { once: true });
      this.#ws.close();
    });
  }

  #onMessage(data: string): void {
    const message = JSON.parse(data);
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    const listeners = this.#listeners.get(`${message.sessionId ?? ''}:${message.method}`);
    if (listeners) for (const listener of listeners) listener(message.params);
  }

  #fail(error: Error): void {
    this.#closed = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export type Session = {
  send<T = any>(method: string, params?: object): Promise<T>;
  on(event: string, listener: Listener): () => void;
};

export function session(connection: Connection, sessionId: string): Session {
  return {
    send: (method, params) => connection.send(method, params, sessionId),
    on: (event, listener) => connection.on(event, listener, sessionId),
  };
}
