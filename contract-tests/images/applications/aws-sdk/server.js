// server.js
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const ospath = require('path');
const { NodeHttpHandler } =require('@smithy/node-http-handler');

const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, CreateTableCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
const { KinesisClient, CreateStreamCommand, PutRecordCommand } = require('@aws-sdk/client-kinesis');
const fetch = require('node-fetch');

const _PORT = 8080;
const _ERROR = 'error';
const _FAULT = 'fault';

const _AWS_SDK_S3_ENDPOINT = process.env.AWS_SDK_S3_ENDPOINT;
const _AWS_SDK_ENDPOINT = process.env.AWS_SDK_ENDPOINT;
const _AWS_REGION = process.env.AWS_REGION;
const _FAULT_ENDPOINT = 'http://fault.test:8080';

process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'testcontainers-localstack';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'testcontainers-localstack';

const noRetryConfig = {
  maxAttempts: 0,
  requestHandler: {
    metadata: { handlerProtocol: 'http/1.1' },
    connectionTimeout: 3000,
    socketTimeout: 3000,
  },
};

let statusCodeForFault = 200;

async function prepareAwsServer() {
  try {
    // Initialize AWS SDK clients
    const s3Client = new S3Client({
      endpoint: _AWS_SDK_S3_ENDPOINT,
      region: _AWS_REGION,
      forcePathStyle: true,
    });

    const ddbClient = new DynamoDBClient({
      endpoint: _AWS_SDK_ENDPOINT,
      region: _AWS_REGION,
    });

    const sqsClient = new SQSClient({
      endpoint: _AWS_SDK_ENDPOINT,
      region: _AWS_REGION,
    });

    const kinesisClient = new KinesisClient({
      endpoint: _AWS_SDK_ENDPOINT,
      region: _AWS_REGION,
    });

    // Set up S3
    await s3Client.send(
      new CreateBucketCommand({
        Bucket: 'test-put-object-bucket-name',
        CreateBucketConfiguration: { LocationConstraint: _AWS_REGION },
      })
    );

    await s3Client.send(
      new CreateBucketCommand({
        Bucket: 'test-get-object-bucket-name',
        CreateBucketConfiguration: { LocationConstraint: _AWS_REGION },
      })
    );

    // Upload a file to S3
    const tempFileName = ospath.join(os.tmpdir(), 'tempfile');
    fs.writeFileSync(tempFileName, 'This is temp file for S3 upload');
    const fileStream = fs.createReadStream(tempFileName);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'test-get-object-bucket-name',
        Key: 'test_object',
        Body: fileStream,
      })
    );
    fs.unlinkSync(tempFileName);

    // Set up DynamoDB
    await ddbClient.send(
      new CreateTableCommand({
        TableName: 'put_test_table',
        KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      })
    );

    // Set up SQS
    await sqsClient.send(
      new CreateQueueCommand({
        QueueName: 'test_put_get_queue',
      })
    );

    // Set up Kinesis
    await kinesisClient.send(
      new CreateStreamCommand({
        StreamName: 'test_stream',
        ShardCount: 1,
      })
    );
  } catch (error) {
    console.error('Unexpected exception occurred', error);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url);
  const pathName = parsedUrl.pathname;

  if (req.method === 'GET') {
    await handleGetRequest(req, res, pathName);
  } else if (req.method === 'POST') {
    await handlePostRequest(req, res, pathName);
  } else if (req.method === 'PUT') {
    await handlePutRequest(req, res, pathName);
  } else {
    res.writeHead(405);
    res.end();
  }
});

async function handleGetRequest(req, res, path) {
  if (path.includes('s3')) {
    await handleS3Request(req, res, path);
  } else if (path.includes('ddb')) {
    await handleDdbRequest(req, res, path);
  } else if (path.includes('sqs')) {
    await handleSqsRequest(req, res, path);
  } else if (path.includes('kinesis')) {
    await handleKinesisRequest(req, res, path);
  } else {
    res.writeHead(404);
    res.end();
  }
}

// this can be served as the fake AWS service to generate fault responses
async function handlePostRequest(req, res, path) {
  res.writeHead(statusCodeForFault);
  res.end();
}

// this can be served as the fake AWS service to generate fault responses
async function handlePutRequest(req, res, path) {
  res.writeHead(statusCodeForFault);
  res.end();
}

async function handleS3Request(req, res, path) {
  const s3Client = new S3Client({
    endpoint: _AWS_SDK_S3_ENDPOINT,
    region: _AWS_REGION,
    forcePathStyle: true,
  });

  if (path.includes(_ERROR)) {
    res.statusCode = 400;
    try {
      // trigger error case with an invalid bucket name
      await s3Client.send(
        new CreateBucketCommand({
          Bucket: '-',
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes(_FAULT)) {
    res.statusCode = 500;
    // save the status code so that the current server will response correctly
    // when the faultS3Client connect to it
    statusCodeForFault = 500;
    try {
      const faultS3Client = new S3Client({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        forcePathStyle: true,
        maxAttempts: 0,
        requestHandler: {
          metadata: { handlerProtocol: 'http/1.1' },
          connectionTimeout: 3000,
          socketTimeout: 3000,
        },
      });
      await faultS3Client.send(
        new CreateBucketCommand({
          Bucket: 'valid-bucket-name',
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes('createbucket/create-bucket')) {
    try {
      await s3Client.send(
        new CreateBucketCommand({
          Bucket: 'test-bucket-name',
          CreateBucketConfiguration: { LocationConstraint: _AWS_REGION },
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error creating bucket', err);
      res.statusCode = 500;
    }
    res.end();
  } else if (path.includes('createobject/put-object/some-object')) {
    try {
      const tempFileName = ospath.join(os.tmpdir(), 'tempfile');
      fs.writeFileSync(tempFileName, 'This is temp file for S3 upload');
      const fileStream = fs.createReadStream(tempFileName);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'test-put-object-bucket-name',
          Key: 'test_object',
          Body: fileStream,
        })
      );
      fs.unlinkSync(tempFileName);
      res.statusCode = 200;
    } catch (err) {
      console.log('Error uploading file', err);
      res.statusCode = 500;
    }
    res.end();
  } else if (path.includes('getobject/get-object/some-object')) {
    try {
      const data = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'test-get-object-bucket-name',
          Key: 'test_object',
        })
      );
      res.statusCode = 200;
      res.end();
    } catch (err) {
      console.log('Error getting object', err);
      res.statusCode = 500;
      res.end();
    }
  } else {
    res.statusCode = 404;
    res.end();
  }
}

async function handleDdbRequest(req, res, path) {
  const ddbClient = new DynamoDBClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  if (path.includes(_ERROR)) {
    res.statusCode = 400;
    try {
      const item = { id: { S: '1' } };
      await ddbClient.send(
        new PutItemCommand({
          TableName: 'invalid_table',
          Item: item,
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;
    try {
      const faultDdbClient = new DynamoDBClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });
      const item = { id: { S: '1' } };
      await faultDdbClient.send(
        new PutItemCommand({
          TableName: 'invalid_table',
          Item: item,
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes('createtable/some-table')) {
    try {
      await ddbClient.send(
        new CreateTableCommand({
          TableName: 'test_table',
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error creating table', err);
      res.statusCode = 500;
    }
    res.end();
  } else if (path.includes('putitem/putitem-table/key')) {
    try {
      const item = { id: { S: '1' } };
      await ddbClient.send(
        new PutItemCommand({
          TableName: 'put_test_table',
          Item: item,
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error putting item', err);
      res.statusCode = 500;
    }
    res.end();
  } else {
    res.statusCode = 404;
    res.end();
  }
}

async function handleSqsRequest(req, res, path) {
  const sqsClient = new SQSClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  if (path.includes(_ERROR)) {
    res.statusCode = 400;
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: 'http://error.test:8080/000000000000/sqserror',
          MessageBody: _ERROR,
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;
    try {
      const faultSqsClient = new SQSClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });
      await faultSqsClient.send(
        new CreateQueueCommand({
          QueueName: 'invalid_test',
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes('createqueue/some-queue')) {
    try {
      await sqsClient.send(
        new CreateQueueCommand({
          QueueName: 'test_queue',
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error creating queue', err);
      res.statusCode = 500;
    }
    res.end();
  } else if (path.includes('publishqueue/some-queue')) {
    try {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: 'http://localstack:4566/000000000000/test_put_get_queue',
          MessageBody: 'test_message',
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error sending message', err);
      res.statusCode = 500;
    }
    res.end();
  } else if (path.includes('consumequeue/some-queue')) {
    try {
      await sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: 'http://localstack:4566/000000000000/test_put_get_queue',
          MaxNumberOfMessages: 1,
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error receiving message', err);
      res.statusCode = 500;
    }
    res.end();
  } else {
    res.statusCode = 404;
    res.end();
  }
}

async function handleKinesisRequest(req, res, path) {
  const kinesisClient = new KinesisClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  if (path.includes(_ERROR)) {
    res.statusCode = 400;
    try {
      await kinesisClient.send(
        new PutRecordCommand({
          StreamName: 'invalid_stream',
          Data: Buffer.from('test'),
          PartitionKey: 'partition_key',
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;
    try {
      const faultKinesisClient = new KinesisClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 3000,
          socketTimeout: 3000, 
        }),
        maxAttempts: 0,
      });
      await faultKinesisClient.send(
        new PutRecordCommand({
          StreamName: 'test_stream',
          Data: Buffer.from('test'),
          PartitionKey: 'partition_key',
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
    res.end();
  } else if (path.includes('putrecord/my-stream')) {
    try {
      await kinesisClient.send(
        new PutRecordCommand({
          StreamName: 'test_stream',
          Data: Buffer.from('test'),
          PartitionKey: 'partition_key',
        })
      );
      res.statusCode = 200;
    } catch (err) {
      console.log('Error putting record', err);
      res.statusCode = 500;
    }
    res.end();
  } else {
    res.statusCode = 404;
    res.end();
  }
}

prepareAwsServer().then(() => {
  server.listen(_PORT, '0.0.0.0', () => {
    console.log('Server is listening on port', _PORT);
    console.log('Ready');
  });
});
