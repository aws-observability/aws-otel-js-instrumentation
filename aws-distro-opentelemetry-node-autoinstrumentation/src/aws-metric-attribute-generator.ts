// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Attributes, AttributeValue, diag, SpanKind } from '@opentelemetry/api';
import { defaultServiceName, Resource } from '@opentelemetry/resources';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  SEMATTRS_DB_CONNECTION_STRING,
  SEMATTRS_DB_NAME,
  SEMATTRS_DB_OPERATION,
  SEMATTRS_DB_STATEMENT,
  SEMATTRS_DB_SYSTEM,
  SEMATTRS_DB_USER,
  SEMATTRS_FAAS_INVOKED_NAME,
  SEMATTRS_FAAS_TRIGGER,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_URL,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
  SEMATTRS_NET_PEER_NAME,
  SEMATTRS_NET_PEER_PORT,
  SEMATTRS_PEER_SERVICE,
  SEMATTRS_RPC_METHOD,
  SEMATTRS_RPC_SERVICE,
  SEMRESATTRS_SERVICE_NAME,
} from '@opentelemetry/semantic-conventions';
import { AWS_ATTRIBUTE_KEYS } from './aws-attribute-keys';
import { AwsSpanProcessingUtil } from './aws-span-processing-util';
import {
  AttributeMap,
  DEPENDENCY_METRIC,
  MetricAttributeGenerator,
  SERVICE_METRIC,
} from './metric-attribute-generator';
import { SqsUrlParser } from './sqs-url-parser';

// Does not exist in @opentelemetry/semantic-conventions
const _SERVER_SOCKET_ADDRESS: string = 'server.socket.address';
const _SERVER_SOCKET_PORT: string = 'server.socket.port';
const _NET_SOCK_PEER_ADDR: string = 'net.sock.peer.addr';
const _NET_SOCK_PEER_PORT: string = 'net.sock.peer.port';
// Alternatively, `import { SemanticAttributes } from '@opentelemetry/instrumentation-undici/build/src/enums/SemanticAttributes';`
//   SemanticAttributes.SERVER_ADDRESS
//   SemanticAttributes.SERVER_PORT
const _SERVER_ADDRESS: string = 'server.address';
const _SERVER_PORT: string = 'server.port';
// Alternatively, `import { AttributeNames } from '@opentelemetry/instrumentation-graphql/build/src/enums/AttributeNames';`
//   AttributeNames.OPERATION_TYPE
const _GRAPHQL_OPERATION_TYPE: string = 'graphql.operation.type';
// Special DEPENDENCY attribute value if GRAPHQL_OPERATION_TYPE attribute key is present.
const GRAPHQL: string = 'graphql';

// Normalized remote service names for supported AWS services
const NORMALIZED_DYNAMO_DB_SERVICE_NAME: string = 'AWS::DynamoDB';
const NORMALIZED_KINESIS_SERVICE_NAME: string = 'AWS::Kinesis';
const NORMALIZED_S3_SERVICE_NAME: string = 'AWS::S3';
const NORMALIZED_SQS_SERVICE_NAME: string = 'AWS::SQS';

const DB_CONNECTION_RESOURCE_TYPE: string = 'DB::Connection';
// As per https://opentelemetry.io/docs/specs/semconv/resource/#service, if service name is not specified, SDK defaults
// the service name to unknown_service:<process name> or just unknown_service.
// - https://github.com/open-telemetry/opentelemetry-js/blob/b2778e1b2ff7b038cebf371f1eb9f808fd98107f/packages/opentelemetry-resources/src/platform/node/default-service-name.ts#L16.
// - `defaultServiceName()` returns `unknown_service:${process.argv0}`
const OTEL_UNKNOWN_SERVICE: string = defaultServiceName();

/**
 * AwsMetricAttributeGenerator generates very specific metric attributes based on low-cardinality
 * span and resource attributes. If such attributes are not present, we fallback to default values.
 *
 * <p>The goal of these particular metric attributes is to get metrics for incoming and outgoing
 * traffic for a service. Namely, {@link SpanKind.SERVER} and {@link SpanKind.CONSUMER} spans
 * represent "incoming" traffic, {@link SpanKind.CLIENT} and {@link SpanKind.PRODUCER} spans
 * represent "outgoing" traffic, and {@link SpanKind.INTERNAL} spans are ignored.
 */
export class AwsMetricAttributeGenerator implements MetricAttributeGenerator {
  // This method is used by the AwsSpanMetricsProcessor to generate service and dependency metrics
  public generateMetricAttributeMapFromSpan(span: ReadableSpan, resource: Resource): AttributeMap {
    const attributesMap: AttributeMap = {};

    if (AwsSpanProcessingUtil.shouldGenerateServiceMetricAttributes(span)) {
      attributesMap[SERVICE_METRIC] = this.generateServiceMetricAttributes(span, resource);
    }
    if (AwsSpanProcessingUtil.shouldGenerateDependencyMetricAttributes(span)) {
      attributesMap[DEPENDENCY_METRIC] = this.generateDependencyMetricAttributes(span, resource);
    }

    return attributesMap;
  }

  private generateServiceMetricAttributes(span: ReadableSpan, resource: Resource): Attributes {
    const attributes: Attributes = {};

    AwsMetricAttributeGenerator.setService(resource, span, attributes);
    AwsMetricAttributeGenerator.setIngressOperation(span, attributes);
    AwsMetricAttributeGenerator.setSpanKindForService(span, attributes);

    return attributes;
  }

  private generateDependencyMetricAttributes(span: ReadableSpan, resource: Resource): Attributes {
    const attributes: Attributes = {};
    AwsMetricAttributeGenerator.setService(resource, span, attributes);
    AwsMetricAttributeGenerator.setEgressOperation(span, attributes);
    AwsMetricAttributeGenerator.setRemoteServiceAndOperation(span, attributes);
    AwsMetricAttributeGenerator.setRemoteResourceTypeAndIdentifier(span, attributes);
    AwsMetricAttributeGenerator.setSpanKindForDependency(span, attributes);
    AwsMetricAttributeGenerator.setRemoteDbUser(span, attributes);

    return attributes;
  }

  /** Service is always derived from {@link SEMRESATTRS_SERVICE_NAME} */
  private static setService(resource: Resource, span: ReadableSpan, attributes: Attributes): void {
    let service: AttributeValue | undefined = resource.attributes[SEMRESATTRS_SERVICE_NAME];

    // In practice the service name is never undefined, but we can be defensive here.
    if (service === undefined || service === OTEL_UNKNOWN_SERVICE) {
      AwsMetricAttributeGenerator.logUnknownAttribute(AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE, span);
      service = AwsSpanProcessingUtil.UNKNOWN_SERVICE;
    }
    attributes[AWS_ATTRIBUTE_KEYS.AWS_LOCAL_SERVICE] = service;
  }

  /**
   * Ingress operation (i.e. operation for Server and Consumer spans) will be generated from
   * "http.method + http.target/with the first API path parameter" if the default span name equals
   * null, UnknownOperation or http.method value.
   */
  private static setIngressOperation(span: ReadableSpan, attributes: Attributes): void {
    const operation: string = AwsSpanProcessingUtil.getIngressOperation(span);
    if (operation === AwsSpanProcessingUtil.UNKNOWN_OPERATION) {
      AwsMetricAttributeGenerator.logUnknownAttribute(AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION, span);
    }
    attributes[AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION] = operation;
  }

  /**
   * Egress operation (i.e. operation for Client and Producer spans) is always derived from a
   * special span attribute, {@link AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION}. This attribute is
   * generated with a separate SpanProcessor, {@link AttributePropagatingSpanProcessor}
   */
  private static setEgressOperation(span: ReadableSpan, attributes: Attributes): void {
    let operation: AttributeValue | undefined = AwsSpanProcessingUtil.getEgressOperation(span);
    if (operation === undefined) {
      AwsMetricAttributeGenerator.logUnknownAttribute(AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION, span);
      operation = AwsSpanProcessingUtil.UNKNOWN_OPERATION;
    }
    attributes[AWS_ATTRIBUTE_KEYS.AWS_LOCAL_OPERATION] = operation;
  }

  /**
   * Remote attributes (only for Client and Producer spans) are generated based on low-cardinality
   * span attributes, in priority order.
   *
   * <p>The first priority is the AWS Remote attributes, which are generated from manually
   * instrumented span attributes, and are clear indications of customer intent. If AWS Remote
   * attributes are not present, the next highest priority span attribute is Peer Service, which is
   * also a reliable indicator of customer intent. If this is set, it will override
   * AWS_REMOTE_SERVICE identified from any other span attribute, other than AWS Remote attributes.
   *
   * <p>After this, we look for the following low-cardinality span attributes that can be used to
   * determine the remote metric attributes:
   *
   * <ul>
   *   <li>RPC
   *   <li>DB
   *   <li>FAAS
   *   <li>Messaging
   *   <li>GraphQL - Special case, if {@link _GRAPHQL_OPERATION_TYPE} is present,
   *       we use it for RemoteOperation and set RemoteService to {@link GRAPHQL}.
   * </ul>
   *
   * <p>In each case, these span attributes were selected from the OpenTelemetry trace semantic
   * convention specifications as they adhere to the three following criteria:
   *
   * <ul>
   *   <li>Attributes are meaningfully indicative of remote service/operation names.
   *   <li>Attributes are defined in the specification to be low cardinality, usually with a low-
   *       cardinality list of values.
   *   <li>Attributes are confirmed to have low-cardinality values, based on code analysis.
   * </ul>
   *
   * if the selected attributes are still producing the UnknownRemoteService or
   * UnknownRemoteOperation, `net.peer.name`, `net.peer.port`, `net.peer.sock.addr`,
   * `net.peer.sock.port` and `http.url` will be used to derive the RemoteService. And `http.method`
   * and `http.url` will be used to derive the RemoteOperation.
   */
  private static setRemoteServiceAndOperation(span: ReadableSpan, attributes: Attributes): void {
    let remoteService: string = AwsSpanProcessingUtil.UNKNOWN_REMOTE_SERVICE;
    let remoteOperation: string = AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;

    if (
      AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE) ||
      AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION)
    ) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE);
      remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION);
    } else if (
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_RPC_SERVICE) ||
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_RPC_METHOD)
    ) {
      remoteService = AwsMetricAttributeGenerator.normalizeRemoteServiceName(
        span,
        AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_RPC_SERVICE)
      );
      remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, SEMATTRS_RPC_METHOD);
    } else if (AwsSpanProcessingUtil.isDBSpan(span)) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_DB_SYSTEM);
      if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_OPERATION)) {
        remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, SEMATTRS_DB_OPERATION);
      } else {
        remoteOperation = AwsMetricAttributeGenerator.getDBStatementRemoteOperation(span, SEMATTRS_DB_STATEMENT);
      }
    } else if (
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_FAAS_INVOKED_NAME) ||
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_FAAS_TRIGGER)
    ) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_FAAS_INVOKED_NAME);
      remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, SEMATTRS_FAAS_TRIGGER);
    } else if (
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_MESSAGING_SYSTEM) ||
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_MESSAGING_OPERATION)
    ) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_MESSAGING_SYSTEM);
      remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, SEMATTRS_MESSAGING_OPERATION);
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, _GRAPHQL_OPERATION_TYPE)) {
      remoteService = GRAPHQL;
      remoteOperation = AwsMetricAttributeGenerator.getRemoteOperation(span, _GRAPHQL_OPERATION_TYPE);
    }

    // Peer service takes priority as RemoteService over everything but AWS Remote.
    if (
      AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_PEER_SERVICE) &&
      !AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE)
    ) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_PEER_SERVICE);
    }

    // try to derive RemoteService and RemoteOperation from the other related attributes
    if (remoteService === AwsSpanProcessingUtil.UNKNOWN_REMOTE_SERVICE) {
      remoteService = AwsMetricAttributeGenerator.generateRemoteService(span);
    }
    if (remoteOperation === AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION) {
      remoteOperation = AwsMetricAttributeGenerator.generateRemoteOperation(span);
    }

    attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE] = remoteService;
    attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION] = remoteOperation;
  }

  /**
   * When the remote call operation is undetermined for http use cases, will try to extract the
   * remote operation name from http url string
   */
  private static generateRemoteOperation(span: ReadableSpan): string {
    let remoteOperation: string = AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
    if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_URL)) {
      const httpUrl: AttributeValue | undefined = span.attributes[SEMATTRS_HTTP_URL];
      try {
        let url: URL;
        if (httpUrl !== undefined) {
          url = new URL(httpUrl as string);
          remoteOperation = AwsSpanProcessingUtil.extractAPIPathValue(url.pathname);
        }
      } catch (e: unknown) {
        diag.verbose(`invalid http.url attribute: ${httpUrl}`);
      }
    }
    if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_METHOD)) {
      const httpMethod: AttributeValue | undefined = span.attributes[SEMATTRS_HTTP_METHOD];
      remoteOperation = (httpMethod as string) + ' ' + remoteOperation;
    }
    if (remoteOperation === AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION) {
      AwsMetricAttributeGenerator.logUnknownAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_OPERATION, span);
    }
    return remoteOperation;
  }

  private static generateRemoteService(span: ReadableSpan): string {
    let remoteService: string = AwsSpanProcessingUtil.UNKNOWN_REMOTE_SERVICE;

    if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_NET_PEER_NAME)) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, SEMATTRS_NET_PEER_NAME);
      if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_NET_PEER_PORT)) {
        const port: AttributeValue | undefined = span.attributes[SEMATTRS_NET_PEER_PORT];
        remoteService += ':' + (port as string);
      }
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, _NET_SOCK_PEER_ADDR)) {
      remoteService = AwsMetricAttributeGenerator.getRemoteService(span, _NET_SOCK_PEER_ADDR);
      if (AwsSpanProcessingUtil.isKeyPresent(span, _NET_SOCK_PEER_PORT)) {
        const port: AttributeValue | undefined = span.attributes[_NET_SOCK_PEER_PORT];
        remoteService += ':' + (port as string);
      }
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_HTTP_URL)) {
      const httpUrl: string = span.attributes[SEMATTRS_HTTP_URL] as string;
      try {
        const url: URL = new URL(httpUrl);
        if (url.hostname !== '') {
          remoteService = url.hostname;
          if (url.port !== '') {
            remoteService += ':' + url.port;
          }
        }
      } catch (e: unknown) {
        diag.verbose(`invalid http.url attribute: ${httpUrl}`);
      }
    } else {
      AwsMetricAttributeGenerator.logUnknownAttribute(AWS_ATTRIBUTE_KEYS.AWS_REMOTE_SERVICE, span);
    }
    return remoteService;
  }

  /**
   * If the span is an AWS SDK span, normalize the name to align with <a
   * href="https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html">AWS
   * Cloud Control resource format</a> as much as possible, with special attention to services we
   * can detect remote resource information for. Long term, we would like to normalize service name
   * in the upstream.
   */
  private static normalizeRemoteServiceName(span: ReadableSpan, serviceName: string): string {
    if (AwsSpanProcessingUtil.isAwsSDKSpan(span)) {
      return 'AWS::' + serviceName;
    }
    return serviceName;
  }

  /**
   * Remote resource attributes {@link AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE} and
   * {@link AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER} are used to store information about the
   * resource associated with the remote invocation, such as S3 bucket name, etc. We should only
   * ever set both type and identifier or neither. If any identifier value contains | or ^ , they
   * will be replaced with ^| or ^^.
   *
   * <p>AWS resources type and identifier adhere to <a
   * href="https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html">AWS
   * Cloud Control resource format</a>.
   */
  private static setRemoteResourceTypeAndIdentifier(span: ReadableSpan, attributes: Attributes): void {
    let remoteResourceType: AttributeValue | undefined;
    let remoteResourceIdentifier: AttributeValue | undefined;

    if (AwsSpanProcessingUtil.isAwsSDKSpan(span)) {
      const awsTableNames: AttributeValue | undefined = span.attributes[AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES];
      if (
        AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_DYNAMODB_TABLE_NAMES) &&
        Array.isArray(awsTableNames) &&
        awsTableNames.length === 1
      ) {
        remoteResourceType = NORMALIZED_DYNAMO_DB_SERVICE_NAME + '::Table';
        remoteResourceIdentifier = AwsMetricAttributeGenerator.escapeDelimiters(awsTableNames[0]);
      } else if (AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME)) {
        remoteResourceType = NORMALIZED_KINESIS_SERVICE_NAME + '::Stream';
        remoteResourceIdentifier = AwsMetricAttributeGenerator.escapeDelimiters(
          span.attributes[AWS_ATTRIBUTE_KEYS.AWS_KINESIS_STREAM_NAME]
        );
      } else if (AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET)) {
        remoteResourceType = NORMALIZED_S3_SERVICE_NAME + '::Bucket';
        remoteResourceIdentifier = AwsMetricAttributeGenerator.escapeDelimiters(
          span.attributes[AWS_ATTRIBUTE_KEYS.AWS_S3_BUCKET]
        );
      } else if (AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME)) {
        remoteResourceType = NORMALIZED_SQS_SERVICE_NAME + '::Queue';
        remoteResourceIdentifier = AwsMetricAttributeGenerator.escapeDelimiters(
          span.attributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_NAME]
        );
      } else if (AwsSpanProcessingUtil.isKeyPresent(span, AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL)) {
        remoteResourceType = NORMALIZED_SQS_SERVICE_NAME + '::Queue';
        remoteResourceIdentifier = SqsUrlParser.getQueueName(
          AwsMetricAttributeGenerator.escapeDelimiters(span.attributes[AWS_ATTRIBUTE_KEYS.AWS_SQS_QUEUE_URL])
        );
      }
    } else if (AwsSpanProcessingUtil.isDBSpan(span)) {
      remoteResourceType = DB_CONNECTION_RESOURCE_TYPE;
      remoteResourceIdentifier = AwsMetricAttributeGenerator.getDbConnection(span);
    }

    if (remoteResourceType !== undefined && remoteResourceIdentifier !== undefined) {
      attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_TYPE] = remoteResourceType;
      attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_RESOURCE_IDENTIFIER] = remoteResourceIdentifier;
    }
  }

  /**
   * RemoteResourceIdentifier is populated with rule <code>
   *     ^[{db.name}|]?{address}[|{port}]?
   * </code>
   *
   * <pre>
   * {address} attribute is retrieved in priority order:
   * - {@link _SERVER_ADDRESS},
   * - {@link SEMATTRS_NET_PEER_NAME},
   * - {@link _SERVER_SOCKET_ADDRESS}
   * - {@link SEMATTRS_DB_CONNECTION_STRING}-Hostname
   * </pre>
   *
   * <pre>
   * {port} attribute is retrieved in priority order:
   * - {@link _SERVER_PORT},
   * - {@link SEMATTRS_NET_PEER_PORT},
   * - {@link _SERVER_SOCKET_PORT}
   * - {@link SEMATTRS_DB_CONNECTION_STRING}-Port
   * </pre>
   *
   * If address is not present, neither RemoteResourceType nor RemoteResourceIdentifier will be
   * provided.
   */
  private static getDbConnection(span: ReadableSpan): string | undefined {
    const dbName: AttributeValue | undefined = span.attributes[SEMATTRS_DB_NAME];
    let dbConnection: string | undefined;

    if (AwsSpanProcessingUtil.isKeyPresent(span, _SERVER_ADDRESS)) {
      const serverAddress: AttributeValue | undefined = span.attributes[_SERVER_ADDRESS];
      const serverPort: AttributeValue | undefined = span.attributes[_SERVER_PORT];
      dbConnection = AwsMetricAttributeGenerator.buildDbConnection(serverAddress, serverPort);
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_NET_PEER_NAME)) {
      const networkPeerAddress: AttributeValue | undefined = span.attributes[SEMATTRS_NET_PEER_NAME];
      const networkPeerPort: AttributeValue | undefined = span.attributes[SEMATTRS_NET_PEER_PORT];
      dbConnection = AwsMetricAttributeGenerator.buildDbConnection(networkPeerAddress, networkPeerPort);
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, _SERVER_SOCKET_ADDRESS)) {
      const serverSocketAddress: AttributeValue | undefined = span.attributes[_SERVER_SOCKET_ADDRESS];
      const serverSocketPort: AttributeValue | undefined = span.attributes[_SERVER_SOCKET_PORT];
      dbConnection = AwsMetricAttributeGenerator.buildDbConnection(serverSocketAddress, serverSocketPort);
    } else if (AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_CONNECTION_STRING)) {
      const connectionString: AttributeValue | undefined = span.attributes[SEMATTRS_DB_CONNECTION_STRING];
      dbConnection = AwsMetricAttributeGenerator.buildDbConnectionString(connectionString);
    }

    // return empty resource identifier if db server is not found
    if (dbConnection !== undefined && dbName !== undefined) {
      return AwsMetricAttributeGenerator.escapeDelimiters(dbName) + '|' + dbConnection;
    }

    return dbConnection;
  }

  private static buildDbConnection(
    address: AttributeValue | undefined,
    port: AttributeValue | undefined
  ): string | undefined {
    if (address === undefined) {
      return undefined;
    }

    return AwsMetricAttributeGenerator.escapeDelimiters(address as string) + (port !== undefined ? '|' + port : '');
  }

  private static buildDbConnectionString(connectionString: AttributeValue | undefined): string | undefined {
    if (connectionString === undefined) {
      return undefined;
    }

    let uri: URL;
    let address: string;
    let port: string;
    try {
      // Divergence from Java/Python
      // `jdbc:<dababase>://` isn't handled well with `new URL()`
      // uri.host and uri.port will be empty strings
      // examples:
      // - jdbc:postgresql://host:port/database?properties
      // - jdbc:mysql://localhost:3306
      // - abc:def:ghi://host:3306
      // Try with a dummy schema without `:`, since we do not care about the schema
      const schemeEndIndex: number = (connectionString as string).indexOf('://');
      if (schemeEndIndex === -1) {
        uri = new URL(connectionString as string);
      } else {
        uri = new URL('dummyschema' + (connectionString as string).substring(schemeEndIndex));
      }

      address = uri.hostname;
      port = uri.port;
    } catch (error: unknown) {
      diag.verbose(`invalid DB ConnectionString: ${connectionString}`);
      return undefined;
    }

    if (address === '') {
      return undefined;
    }

    return AwsMetricAttributeGenerator.escapeDelimiters(address) + (port !== '' ? '|' + port : '');
  }

  private static escapeDelimiters(input: string | AttributeValue | undefined | null): string | undefined {
    if (typeof input !== 'string') {
      return undefined;
    }

    // Divergence from Java/Python
    // `replaceAll(a,b)` is not available, and `replace(a,b)` only replaces the first occurrence
    // `split(a).join(b)` is not equivalent for all (a,b), but works with `a = '^'` or a = '|'`.
    // Implementing some regex is also possible
    //   e.g. let re = new RegExp(String.raw`\s${variable}\s`, "g");
    return (input as string).split('^').join('^^').split('|').join('^|');
  }

  /** Span kind is needed for differentiating metrics in the EMF exporter */
  private static setSpanKindForService(span: ReadableSpan, attributes: Attributes): void {
    let spanKind: string = SpanKind[span.kind];
    if (AwsSpanProcessingUtil.isLocalRoot(span)) {
      spanKind = AwsSpanProcessingUtil.LOCAL_ROOT;
    }
    attributes[AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND] = spanKind;
  }

  private static setSpanKindForDependency(span: ReadableSpan, attributes: Attributes): void {
    const spanKind: string = SpanKind[span.kind];
    attributes[AWS_ATTRIBUTE_KEYS.AWS_SPAN_KIND] = spanKind;
  }

  private static setRemoteDbUser(span: ReadableSpan, attributes: Attributes): void {
    if (AwsSpanProcessingUtil.isDBSpan(span) && AwsSpanProcessingUtil.isKeyPresent(span, SEMATTRS_DB_USER)) {
      attributes[AWS_ATTRIBUTE_KEYS.AWS_REMOTE_DB_USER] = span.attributes[SEMATTRS_DB_USER];
    }
  }

  private static getRemoteService(span: ReadableSpan, remoteServiceKey: string): string {
    let remoteService: AttributeValue | undefined = span.attributes[remoteServiceKey];
    if (remoteService === undefined) {
      remoteService = AwsSpanProcessingUtil.UNKNOWN_REMOTE_SERVICE;
    }
    return remoteService as string;
  }

  private static getRemoteOperation(span: ReadableSpan, remoteOperationKey: string): string {
    let remoteOperation: AttributeValue | undefined = span.attributes[remoteOperationKey];
    if (remoteOperation === undefined) {
      remoteOperation = AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
    }
    return remoteOperation as string;
  }

  /**
   * If no db.operation attribute provided in the span, we use db.statement to compute a valid
   * remote operation in a best-effort manner. To do this, we take the first substring of the
   * statement and compare to a regex list of known SQL keywords. The substring length is determined
   * by the longest known SQL keywords.
   */
  private static getDBStatementRemoteOperation(span: ReadableSpan, remoteOperationKey: string): string {
    let remoteOperation: AttributeValue | undefined = span.attributes[remoteOperationKey];
    if (remoteOperation === undefined) {
      remoteOperation = AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
    }

    // Remove all whitespace and newline characters from the beginning of remote_operation
    // and retrieve the first MAX_KEYWORD_LENGTH characters
    remoteOperation = (remoteOperation as string).trimStart();
    if (remoteOperation.length > AwsSpanProcessingUtil.MAX_KEYWORD_LENGTH) {
      remoteOperation = remoteOperation.substring(0, AwsSpanProcessingUtil.MAX_KEYWORD_LENGTH);
    }

    const matcher: RegExpMatchArray | null = remoteOperation
      .toUpperCase()
      .match(AwsSpanProcessingUtil.SQL_DIALECT_PATTERN);
    if (matcher == null || matcher.length === 0) {
      remoteOperation = AwsSpanProcessingUtil.UNKNOWN_REMOTE_OPERATION;
    } else {
      remoteOperation = matcher[0];
    }

    return remoteOperation;
  }

  private static logUnknownAttribute(attributeKey: string, span: ReadableSpan): void {
    diag.verbose(`No valid ${attributeKey} value found for ${SpanKind[span.kind]} span ${span.spanContext().spanId}`);
  }
}
