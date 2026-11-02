import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from 'aws-lambda';

import { S3 } from '@aws-sdk/client-s3';
import winston from 'winston';
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport';

const s3 = new S3();
const logger = winston.createLogger({
  level: 'debug',
  transports: [
    new winston.transports.Console(),
    new OpenTelemetryTransportV3(),
  ],
});

exports.handler = async (_event: APIGatewayProxyEvent, _context: Context) => {
  logger.debug('debug-level-test-message');
  logger.info('info-level-test-message');
  logger.warn('warn-level-test-message');
  logger.error('error-level-test-message');

  logger.info('Serving lambda request.');

  const result = await s3.listBuckets();

  logger.info('Fetched OTel Resource Attrs:' + process.env.OTEL_RESOURCE_ATTRIBUTES);
  logger.info('Fetched X-Ray Trace Header:' + process.env['_X_AMZN_TRACE_ID']);

  const response: APIGatewayProxyResult = {
    statusCode: 200,
    body: `Hello lambda - found ${result.Buckets?.length || 0} buckets. X-Ray Trace ID: ${process.env['_X_AMZN_TRACE_ID'] || 'Not available'}`,
  };
  return response;
};
