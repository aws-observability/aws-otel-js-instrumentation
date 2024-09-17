import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';

import AWS from 'aws-sdk';

const s3 = new AWS.S3();

exports.handler = async (event: APIGatewayProxyEvent, context: Context) => {
  console.info('Serving lambda request.');

  const result = await s3.listBuckets().promise();

  console.log('Fetched OTel Resource Attrs:' + process.env.OTEL_RESOURCE_ATTRIBUTES);
  console.log('Fetched X-Ray Trace Header:' + process.env['_X_AMZN_TRACE_ID']);

  const response: APIGatewayProxyResult = {
    statusCode: 200,
    body: `Hello lambda - found ${result.Buckets?.length || 0} buckets`,
  };
  return response;
};
