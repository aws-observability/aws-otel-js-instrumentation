// server.js
const http = require('http');
const url = require('url');
const fs = require('fs');
const os = require('os');
const ospath = require('path');
const { NodeHttpHandler } =require('@smithy/node-http-handler');
const fetch = require('node-fetch');
const JSZip = require('jszip');

const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, CreateTableCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { SQSClient, CreateQueueCommand, SendMessageCommand, ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
const { KinesisClient, CreateStreamCommand, PutRecordCommand } = require('@aws-sdk/client-kinesis');
const { BedrockClient, GetGuardrailCommand } = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, GetKnowledgeBaseCommand, GetDataSourceCommand, GetAgentCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { BedrockAgentRuntimeClient, InvokeAgentCommand, RetrieveCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { SNSClient, CreateTopicCommand, GetTopicAttributesCommand } = require('@aws-sdk/client-sns');
const { SecretsManagerClient, CreateSecretCommand, DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
const { SFNClient, CreateStateMachineCommand, CreateActivityCommand, DescribeStateMachineCommand, DescribeActivityCommand } = require('@aws-sdk/client-sfn');
const { IAMClient, AttachRolePolicyCommand, CreateRoleCommand } = require('@aws-sdk/client-iam')
const { LambdaClient, CreateFunctionCommand, GetEventSourceMappingCommand, CreateEventSourceMappingCommand, UpdateEventSourceMappingCommand } = require('@aws-sdk/client-lambda');


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

    const secretsClient = new SecretsManagerClient({
      endpoint: _AWS_SDK_ENDPOINT,
      region: _AWS_REGION,
    })

    const snsClient = new SNSClient({
      endpoint: _AWS_SDK_ENDPOINT,
      region: _AWS_REGION,
    })

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
    const sqsQueue = await sqsClient.send(
      new CreateQueueCommand({
        QueueName: 'test_put_get_queue',
      })
    );

    // Set up Kinesis
    await kinesisClient.send(
      new CreateStreamCommand({
        StreamName: 'test_stream',
        ShardCount: 1,
      }))

    // Set up SecretsManager
    await secretsClient.send(
      new CreateSecretCommand({
        "Description": "My test secret",
        "Name": "MyTestSecret",
        "SecretString": "{\"username\":\"user\",\"password\":\"password\"}"      
      })
    );

    // Set up SNS
    await snsClient.send(new CreateTopicCommand({
      "Name": "TestTopic"
    }))

    // Set up Lambda
    await setupLambda()

    // Set up StepFunctions
    await setupSfn()
    
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
})

async function handleGetRequest(req, res, path) {
  if (path.includes('s3')) {
    await handleS3Request(req, res, path);
  } else if (path.includes('ddb')) {
    await handleDdbRequest(req, res, path);
  } else if (path.includes('sqs')) {
    await handleSqsRequest(req, res, path);
  } else if (path.includes('kinesis')) {
    await handleKinesisRequest(req, res, path);
  } else if (path.includes('bedrock')) {
    await handleBedrockRequest(req, res, path);
  } else if (path.includes('secretsmanager')) {
    await handleSecretsRequest(req, res, path);
  } else if (path.includes('stepfunctions')) {
    await handleSfnRequest(req, res, path);
  } else if (path.includes('sns')) {
    await handleSnsRequest(req, res, path);
  } else if (path.includes('lambda')) {
    await handleLambdaRequest(req, res, path);
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

async function handleBedrockRequest(req, res, path) {
  const bedrockClient = new BedrockClient({ endpoint: _AWS_SDK_ENDPOINT, region: _AWS_REGION });
  const bedrockAgentClient = new BedrockAgentClient({ endpoint: _AWS_SDK_ENDPOINT, region: _AWS_REGION });
  const bedrockRuntimeClient = new BedrockRuntimeClient({ endpoint: _AWS_SDK_ENDPOINT, region: _AWS_REGION });
  const bedrockAgentRuntimeClient = new BedrockAgentRuntimeClient({ endpoint: _AWS_SDK_ENDPOINT, region: _AWS_REGION });

  try {
    if (path.includes('getknowledgebase/get_knowledge_base')) {
      await withInjected200Success(bedrockAgentClient, ['GetKnowledgeBaseCommand'], {}, async () => {
        await bedrockAgentClient.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: 'invalid-knowledge-base-id' }));
      });
      res.statusCode = 200;
    } else if (path.includes('getdatasource/get_data_source')) {
      await withInjected200Success(bedrockAgentClient, ['GetDataSourceCommand'], {}, async () => {
        await bedrockAgentClient.send(new GetDataSourceCommand({ knowledgeBaseId: 'TESTKBSEID', dataSourceId: 'DATASURCID' }));
      });
      res.statusCode = 200;
    } else if (path.includes('getagent/get-agent')) {
      await withInjected200Success(bedrockAgentClient, ['GetAgentCommand'], {}, async () => {
        await bedrockAgentClient.send(new GetAgentCommand({ agentId: 'TESTAGENTID' }));
      });
      res.statusCode = 200;
    } else if (path.includes('getguardrail/get-guardrail')) {
      await withInjected200Success(
        bedrockClient,
        ['GetGuardrailCommand'],
        { guardrailId: 'bt4o77i015cu',
          guardrailArn: 'arn:aws:bedrock:us-east-1:000000000000:guardrail/bt4o77i015cu'
         },
        async () => {
          await bedrockClient.send(
            new GetGuardrailCommand({
              guardrailIdentifier: 'arn:aws:bedrock:us-east-1:000000000000:guardrail/bt4o77i015cu',
            })
          );
        }
      );
      res.statusCode = 200;
    } else if (path.includes('invokeagent/invoke_agent')) {
      await withInjected200Success(bedrockAgentRuntimeClient, ['InvokeAgentCommand'], {}, async () => {
        await bedrockAgentRuntimeClient.send(
          new InvokeAgentCommand({
            agentId: 'Q08WFRPHVL',
            agentAliasId: 'testAlias',
            sessionId: 'testSessionId',
            inputText: 'Invoke agent sample input text',
          })
        );
      });
      res.statusCode = 200;
    } else if (path.includes('retrieve/retrieve')) {
      await withInjected200Success(bedrockAgentRuntimeClient, ['RetrieveCommand'], {}, async () => {
        await bedrockAgentRuntimeClient.send(
          new RetrieveCommand({
            knowledgeBaseId: 'test-knowledge-base-id',
            retrievalQuery: {
              text: 'an example of retrieve query',
            },
          })
        );
      });
      res.statusCode = 200;
    } else if (path.includes('invokemodel/invoke-model')) {
        const get_model_request_response = function () {
          const prompt = "Describe the purpose of a 'hello world' program in one line.";
          let modelId = ''
          let request_body = {}
          let response_body = {}
          
          if (path.includes('amazon.titan')) {
            
            modelId = 'amazon.titan-text-premier-v1:0';

            request_body = {
              inputText: prompt,
              textGenerationConfig: {
                maxTokenCount: 3072,
                stopSequences: [],
                temperature: 0.7,
                topP: 0.9,
              },
            };

            response_body = {
              inputTextTokenCount: 15,
              results: [
                {
                  tokenCount: 13,
                  outputText: 'text-test-response',
                  completionReason: 'CONTENT_FILTERED',
                },
              ],
            }
          }
          
          if (path.includes("amazon.nova")) {
            
            modelId = "amazon.nova-pro-v1:0"
            
            request_body = {
              messages: [{role: "user", content: [{text: "A camping trip"}]}],
              inferenceConfig: {
                  max_new_tokens: 800,
                  temperature: 0.9,
                  top_p: 0.7,
              },
            }
          
            response_body = {
              output: {message: {content: [{text: ""}], role: "assistant"}},
              stopReason: "max_tokens",
              usage: {
                inputTokens: 432, 
                outputTokens: 681
              },
            }
          }

          if (path.includes('anthropic.claude')) {
            
            modelId = 'anthropic.claude-v2:1';
            
            request_body = {
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: 1000,
              temperature: 0.99,
              top_p: 1,
              messages: [
                {
                  role: 'user',
                  content: [{ type: 'text', text: prompt }],
                },
              ],
            };

            response_body = {
              stop_reason: 'end_turn',
              usage: {
                input_tokens: 15,
                output_tokens: 13,
              },
            }
          }

          if (path.includes('meta.llama')) {
            modelId = 'meta.llama2-13b-chat-v1';
            
            request_body = {
              prompt,
              max_gen_len: 512,
              temperature: 0.5,
              top_p: 0.9
            };

            response_body = {
              prompt_token_count: 31,
              generation_token_count: 49,
              stop_reason: 'stop'
            }
          }

          if (path.includes('cohere.command')) {
            modelId = 'cohere.command-light-text-v14';
            
            request_body = {
              prompt,
              max_tokens: 512,
              temperature: 0.5,
              p: 0.65,
            };

            response_body = {
              generations: [
                {
                  finish_reason: 'COMPLETE',
                  text: 'test-generation-text',
                },
              ],
              prompt: prompt,
            };
          }

          if (path.includes('cohere.command-r')) {
            modelId = 'cohere.command-r-v1:0';
            
            request_body = {
              message: prompt,
              max_tokens: 512,
              temperature: 0.5,
              p: 0.65,
            };

            response_body = {
              finish_reason: 'COMPLETE',
              text: 'test-generation-text',
              prompt: prompt,
              request: {
                commandInput: {
                  modelId: modelId,
                },
              },
            }
          }
  
          if (path.includes('ai21.jamba')) {
            modelId = 'ai21.jamba-1-5-large-v1:0';
            
            request_body = {
              messages: [
                {
                  role: 'user',
                  content: prompt,
                },
              ],
              top_p: 0.8,
              temperature: 0.6,
              max_tokens: 512,
            };

            response_body = {
              stop_reason: 'end_turn',
              usage: {
                prompt_tokens: 21,
                completion_tokens: 24,
              },
              choices: [
                {
                  finish_reason: 'stop',
                },
              ],
            }
          }
  
          if (path.includes('mistral')) {
            modelId = 'mistral.mistral-7b-instruct-v0:2';
            
            request_body = {
              prompt,
              max_tokens: 4096,
              temperature: 0.75,
              top_p: 0.99,
            };

            response_body = {
              outputs: [
                {
                  text: 'test-output-text',
                  stop_reason: 'stop',
                },
              ]
            }
          }
          
          return [modelId, JSON.stringify(request_body), new TextEncoder().encode(JSON.stringify(response_body))]
        }
        
        const [modelId, request_body, response_body] = get_model_request_response();

      await withInjected200Success(bedrockRuntimeClient, ['InvokeModelCommand'], { body: response_body }, async () => {          
        await bedrockRuntimeClient.send(
          new InvokeModelCommand({
            body: request_body,
            modelId: modelId,
            accept: 'application/json',
            contentType: 'application/json',
          })
        );
      });

      res.statusCode = 200;
    } else {
      res.statusCode = 404;
    }
  } catch (error) {
    console.error('An error occurred:', error);
    res.statusCode = 500;
  }

  res.end();
}


async function handleSecretsRequest(req, res, path) {
  const secretsClient = new SecretsManagerClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

    if (path.includes(_ERROR)) {
      res.statusCode = 400;

      try {
        await secretsClient.send(
          new DescribeSecretCommand({
            SecretId: "arn:aws:secretsmanager:us-west-2:000000000000:secret:nonExistentSecret"
          })
        );
      } catch (err) {
        console.log('Expected exception occurred', err);
      }
  }

  if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;

    try {
      const faultSecretsClient = new SecretsManagerClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });

      await faultSecretsClient.send(
        new DescribeSecretCommand({
          SecretId: "arn:aws:secretsmanager:us-west-2:000000000000:secret:nonExistentSecret"
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
  }

  if (path.includes('describesecret/my-secret')) {
    await secretsClient.send(
      new DescribeSecretCommand({
        SecretId: "MyTestSecret"
      })
    );
  }

  res.end();
}

async function handleSfnRequest(req, res, path) {
  const sfnClient = new SFNClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

    if (path.includes(_ERROR)) {
      res.statusCode = 400;

      try {
        await sfnClient.send(
          new DescribeStateMachineCommand({
            stateMachineArn: "arn:aws:states:us-west-2:000000000000:stateMachine:nonExistentStateMachine"
          })
        );
      } catch (err) {
        console.log('Expected exception occurred', err);
      }
  }

  if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;

    try {

      const faultSfnClient = new SFNClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });

      await faultSfnClient.send(
        new DescribeStateMachineCommand({
          stateMachineArn: "arn:aws:states:us-west-2:000000000000:stateMachine:invalid-state-machine"
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
  }

  if (path.includes('describestatemachine/state-machine')) {
    await sfnClient.send(
      new DescribeStateMachineCommand({
        stateMachineArn: "arn:aws:states:us-west-2:000000000000:stateMachine:TestStateMachine"
      })
    );
  }

  if (path.includes('describeactivity/activity')) {
    await sfnClient.send(
      new DescribeActivityCommand({
        activityArn: "arn:aws:states:us-west-2:000000000000:activity:TestActivity"
      })
    );
  }

  res.end();
}

async function handleSnsRequest(req, res, path) {
  const snsClient = new SNSClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

    if (path.includes(_ERROR)) {
      res.statusCode = 404;

      try {
        await snsClient.send(
          new GetTopicAttributesCommand({
            TopicArn: "arn:aws:sns:us-west-2:000000000000:nonExistentTopic",
          })
        );
      } catch (err) {
        console.log('Expected exception occurred', err);
      }

  }

  if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;

    try {
      const faultSnsClient = new SNSClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });

      await faultSnsClient.send(
        new GetTopicAttributesCommand({
          TopicArn: "arn:aws:sns:us-west-2:000000000000:invalidTopic"
        })
      );
    } catch (err) {
      console.log('Expected exception occurred', err);
    }
  }

  if (path.includes('gettopicattributes/topic')) {
    await snsClient.send(
      new GetTopicAttributesCommand({
        TopicArn: "arn:aws:sns:us-west-2:000000000000:TestTopic"
      })
    );
  }

  res.end();
}

async function handleLambdaRequest(req, res, path) {
  const lambdaClient = new LambdaClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  if (path.includes(_ERROR)) {
    res.statusCode = 404;
    
    try {
      await lambdaClient.send(
        new GetEventSourceMappingCommand({
          UUID: "nonExistentUUID"
        })
      );
    }
    catch(err) {
      console.log('Expected exception occurred', err);
    }

  } 

  if (path.includes(_FAULT)) {
    res.statusCode = 500;
    statusCodeForFault = 500;

    try {
      const faultLambdaClient = new LambdaClient({
        endpoint: _FAULT_ENDPOINT,
        region: _AWS_REGION,
        ...noRetryConfig,
      });

      await faultLambdaClient.send(
        new UpdateEventSourceMappingCommand({
          UUID: "123e4567-e89b-12d3-a456-426614174000"
        })
      );
    }
    catch(err) {
      console.log('Expected exception occurred', err);
    }
  }
  

  if (path.includes('geteventsourcemapping')) {
    await lambdaClient.send(
      new GetEventSourceMappingCommand({
        UUID: ''
      })
    ); 
  }
  res.end();
}

async function setupLambda() {
  const lambdaClient = new LambdaClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  const iamClient = new IAMClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: {
        Service: "lambda.amazonaws.com"
      },
      Action: "sts:AssumeRole"
    }]
  };

  const functionName = 'testFunction'

  const lambdaRoleParams = {
    RoleName: "LambdaRole",
    AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
  };

  const policyParams = {
    RoleName: "LambdaRole",
    PolicyArn: "arn:aws:iam::aws:policy/AWSLambda_FullAccess"
  };  
  
  const role = await iamClient.send(new CreateRoleCommand(lambdaRoleParams));
  await iamClient.send(new AttachRolePolicyCommand(policyParams)); 

  const zip = new JSZip();
  zip.file('index.js', 'exports.handler = async (event) => { return { statusCode: 200 }; };');
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const functionParams = {
    Code: {
      ZipFile: zipBuffer
    },
    FunctionName: functionName,
    Handler: "index.handler",
    Role: role.Role.Arn,
    Runtime: "nodejs18.x"
  };

  const mappingParams = {
    EventSourceArn: "arn:aws:sns:us-west-2:000000000000:TestTopic",
    FunctionName: functionName,
    Enabled: false
  }

  await lambdaClient.send(new CreateFunctionCommand(functionParams));
  await lambdaClient.send(new CreateEventSourceMappingCommand(mappingParams));
}

async function setupSfn() {
  const sfnClient = new SFNClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  const iamClient = new IAMClient({
    endpoint: _AWS_SDK_ENDPOINT,
    region: _AWS_REGION,
  });

  const trustPolicy = {
    Version: "2012-10-17",
    Statement: [{
        Effect: "Allow",
        Principal: {
            Service: "states.amazonaws.com"
        },
        Action: "sts:AssumeRole"
    }]
};

const roleName = 'testRole'

const createRoleResponse = await iamClient.send(new CreateRoleCommand({
  RoleName: roleName,
  AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
}));

await iamClient.send(new AttachRolePolicyCommand({
  RoleName: roleName,
  PolicyArn: 'arn:aws:iam::aws:policy/AWSStepFunctionsFullAccess'
}));

const roleArn = createRoleResponse.Role.Arn

const definition = {
  StartAt: "HelloWorld",
  States: {
    "HelloWorld": {          
      Type: "Pass",
      Result: "Hello, World!",
      End: true
    }
  }
};

await sfnClient.send(new CreateStateMachineCommand({
  name: 'TestStateMachine',
  definition: JSON.stringify(definition),
  roleArn: roleArn,
  type: 'STANDARD'
}));

await sfnClient.send(
  new CreateActivityCommand({
    name: 'TestActivity',
  }));
}

function inject200Success(client, commandNames, additionalResponse = {}, middlewareName = 'inject200SuccessMiddleware') {
  const middleware = (next, context) => async (args) => {
    const { commandName } = context;
    if (commandNames.includes(commandName)) {
      const response = {
        $metadata: {
          httpStatusCode: 200,
          requestId: 'mock-request-id',
        },
        Message: 'Request succeeded',
        ...additionalResponse,
      };
      return { output: response };
    }
    return next(args);
  };
  // this middleware intercept the request and inject the response
  client.middlewareStack.add(middleware, { step: 'build', name: middlewareName, priority: 'high' });
}

async function withInjected200Success(client, commandNames, additionalResponse, apiCall) {
  const middlewareName = 'inject200SuccessMiddleware';
  inject200Success(client, commandNames, additionalResponse, middlewareName);
  await apiCall();
  client.middlewareStack.remove(middlewareName);
}

prepareAwsServer().then(() => {
  server.listen(_PORT, '0.0.0.0', () => {
    console.log('Server is listening on port', _PORT);
    console.log('Ready');
  });
});