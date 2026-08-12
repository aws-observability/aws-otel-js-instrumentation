// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// RPC-family contract app: a plain app (no OTel code) that stands up an in-process gRPC server and
// calls it, so the grpc instrumentation produces real RPC spans. No external backend/container is
// needed — gRPC runs entirely in-process. Instrumentation is injected by the --require chain.
export async function runRpcWorkload(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const grpc = require('@grpc/grpc-js');

  // Minimal service defined programmatically (no .proto file needed).
  const PORT = Number(process.env.RPC_PORT ?? 50251);
  const serviceName = 'contract.Echoer';
  const methodPath = `/${serviceName}/Echo`;

  const serviceDef: Record<string, unknown> = {
    Echo: {
      path: methodPath,
      requestStream: false,
      responseStream: false,
      requestSerialize: (v: Buffer) => v,
      requestDeserialize: (v: Buffer) => v,
      responseSerialize: (v: Buffer) => v,
      responseDeserialize: (v: Buffer) => v,
    },
  };

  const server = new grpc.Server();
  server.addService(serviceDef, {
    Echo: (_call: unknown, callback: (err: unknown, res: Buffer) => void) => callback(null, Buffer.from('ok')),
  });
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err: unknown) =>
      err ? reject(err) : resolve()
    );
  });

  const ClientCtor = grpc.makeGenericClientConstructor({ Echo: serviceDef.Echo }, serviceName);
  const client = new ClientCtor(`localhost:${PORT}`, grpc.credentials.createInsecure());
  const echo = (): Promise<void> =>
    new Promise((resolve, reject) =>
      client.Echo(Buffer.from('ping'), (err: unknown) => (err ? reject(err) : resolve()))
    );

  const CALL_COUNT = 20;
  for (let i = 0; i < CALL_COUNT; i++) {
    await echo();
  }

  await new Promise(resolve => setTimeout(resolve, 4000));
  server.forceShutdown();
  process.exit(0);
}

void runRpcWorkload();
