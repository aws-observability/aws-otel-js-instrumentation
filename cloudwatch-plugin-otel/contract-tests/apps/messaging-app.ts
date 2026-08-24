// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Messaging-family contract app: a plain app (no OTel code) that produces messages to a Kafka topic
// via kafkajs, so the kafkajs instrumentation produces real messaging spans (PRODUCER, and CONSUMER
// if consumed). Broker address is env-configured by the test. Instrumentation is injected by the
// --require chain.
export async function runMessagingWorkload(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Kafka, logLevel } = require('kafkajs');

  const broker = `${process.env.KAFKA_HOST}:${process.env.KAFKA_PORT}`;
  const topic = 'contract-topic';
  const kafka = new Kafka({ clientId: 'contract-app', brokers: [broker], logLevel: logLevel.NOTHING });

  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
  await admin.disconnect();

  const producer = kafka.producer();
  await producer.connect();
  const MESSAGE_COUNT = 20;
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    await producer.send({ topic, messages: [{ value: `msg-${i}` }] });
  }
  await producer.disconnect();

  await new Promise(resolve => setTimeout(resolve, 4000));
  process.exit(0);
}

void runMessagingWorkload();
