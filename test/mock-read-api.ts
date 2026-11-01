import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReadApi {
  url: string;
  requests: IncomingMessage[];
  close(): Promise<void>;
}

export async function startReadApi(status: number, body: unknown): Promise<MockReadApi> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
