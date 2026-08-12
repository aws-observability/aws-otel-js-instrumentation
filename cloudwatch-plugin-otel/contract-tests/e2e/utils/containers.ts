// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Testcontainers helpers for the DB/RPC/messaging family contract tests. The contract apps run as
// host child processes (see run-app.ts), so a container's backend is reached over its mapped host
// port — no shared Docker network is needed. Each helper returns the host + port to hand to the app.
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

// True when a Docker daemon is reachable. Family tests that need a backend skip when this is false,
// so the suite still runs (minus those tests) on machines/CI without Docker.
export async function dockerAvailable(): Promise<boolean> {
  try {
    // A no-op container ping is heavy; instead rely on testcontainers' own probe via a tiny pull.
    // The cheapest reliable signal is checking the Docker socket through the client testcontainers
    // uses. We attempt a trivial container and tear it down; failures (no daemon) return false.
    const { getContainerRuntimeClient } = await import('testcontainers');
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

export interface StartedBackend {
  host: string;
  port: number;
  container: StartedTestContainer;
}

// Postgres for the DB family. Uses the official postgres image with a fixed db/user/password.
export async function startPostgres(): Promise<StartedBackend & { database: string; user: string; password: string }> {
  const database = 'contract';
  const user = 'contract';
  const password = 'contract';
  const container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: database, POSTGRES_USER: user, POSTGRES_PASSWORD: password })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  return {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    database,
    user,
    password,
    container,
  };
}

// Kafka for the messaging family. Uses the dedicated @testcontainers/kafka module, which handles the
// advertised-listener mapping so a host-side client (kafkajs) can connect on the mapped port.
export async function startKafka(): Promise<StartedBackend> {
  const { KafkaContainer } = await import('@testcontainers/kafka');
  const container = await new KafkaContainer('confluentinc/cp-kafka:7.7.1')
    .withStartupTimeout(180000)
    .start();
  return { host: container.getHost(), port: container.getMappedPort(9093), container };
}
