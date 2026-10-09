/**
 * A WebSocket transport that sends nothing, for tests that build a GameServer
 * without opening a socket. Mock the real one with:
 *
 *   vi.mock("@engine/server/network/transport/WebSocketTransport", () => import("./_fakeTransport"));
 */
export class WebSocketServerTransport {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  broadcastDatagram(): void {}
  broadcastReliable(): void {}
  sendDatagram(): void {}
  sendReliable(): void {}
  disconnect(): void {}
}
