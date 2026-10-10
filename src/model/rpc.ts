// JSON-RPC as Codex app-server speaks it: JSON-RPC 2.0 shapes without the "jsonrpc" field.

export interface Transport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
  // While unreferenced, an idle connection does not keep the process alive.
  ref?(): void;
  unref?(): void;
}

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(method: string, error: { code?: number; message?: string; data?: unknown }) {
    super(`${method}: ${error.message ?? 'unknown error'}`);
    this.code = error.code ?? 0;
    this.data = error.data;
  }
}

type Pending = { method: string; resolve: (value: any) => void; reject: (error: Error) => void };
type RequestHandler = (method: string, params: any) => Promise<unknown>;
type NotificationHandler = (method: string, params: any) => void;

export class RpcClient {
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notificationHandlers = new Set<NotificationHandler>();
  private holds = 0;
  private requestHandler: RequestHandler = async (method) => {
    throw new RpcError(method, { code: -32601, message: 'method not handled by client' });
  };
  closed: Error | undefined;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((text) => this.receive(text));
    transport.onClose((error) => this.fail(error ?? new Error('connection closed')));
    transport.unref?.();
  }

  // Keeps the process alive until the returned release is called, e.g. for a whole model turn.
  hold(): () => void {
    this.holds++;
    this.updateRef();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.updateRef();
    };
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.updateRef();
      this.transport.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  close(): void {
    this.transport.close();
    this.fail(new Error('connection closed'));
  }

  private receive(text: string): void {
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      void this.answer(message.id, message.method, message.params);
    } else if (message.method !== undefined) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.updateRef();
      if (message.error) pending.reject(new RpcError(pending.method, message.error));
      else pending.resolve(message.result);
    }
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    let reply: object;
    try {
      reply = { id, result: await this.requestHandler(method, params) };
    } catch (error) {
      const e = error as RpcError;
      reply = { id, error: { code: typeof e.code === 'number' && e.code ? e.code : -32603, message: e.message } };
    }
    if (!this.closed) this.transport.send(JSON.stringify(reply));
  }

  private updateRef(): void {
    if (this.holds > 0 || this.pending.size > 0) this.transport.ref?.();
    else this.transport.unref?.();
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const handler of this.notificationHandlers) handler('transport/closed', { message: error.message });
  }
}
