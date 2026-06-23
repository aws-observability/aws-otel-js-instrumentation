import * as dgram from 'dgram';
import * as crypto from 'crypto';

import {
  context as contextApi,
  trace as traceApi,
  propagation,
  ROOT_CONTEXT,
  Tracer as TracerAPI,
  TracerProvider as TracerProviderAPI,
  Span as SpanAPI,
  SpanContext,
  SpanKind,
  SpanStatus,
  SpanStatusCode,
  TraceFlags,
  Link,
  Attributes,
  AttributeValue,
  Context,
  TimeInput,
  Exception,
  HrTime,
  diag,
  defaultTextMapSetter,
} from '@opentelemetry/api';


const PROTOCOL_HEADER = '{"format":"json","version":1}\n';
const DEFAULT_ENDPOINT = '127.0.0.1:2000';
const INVALID_TRACE_ID = '00000000000000000000000000000000';
const INVALID_SPAN_ID = '0000000000000000';
const XRAY_TRACE_ID_HEADER = 'x-amzn-trace-id';
const XRAY_TRACE_ID_HEADER_CAPITALIZED = 'X-Amzn-Trace-Id';
const TRACE_CONTEXT_ENV_KEY = '_X_AMZN_TRACE_ID';

let isTracingSuppressed: (context: Context) => boolean = () => false;


function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

function isSpanContextValid(spanContext: SpanContext): boolean {
  return spanContext.traceId !== INVALID_TRACE_ID && spanContext.spanId !== INVALID_SPAN_ID;
}

const _hrOffset = (() => {
  const wallMs = Date.now();
  const hr = process.hrtime();
  return wallMs - (hr[0] * 1000 + hr[1] / 1e6);
})();

function getHrTime(): HrTime {
  const hr = process.hrtime();
  const wallMs = _hrOffset + hr[0] * 1000 + hr[1] / 1e6;
  const seconds = Math.floor(wallMs / 1000);
  const nanos = Math.round((wallMs - seconds * 1000) * 1e6);
  return [seconds, nanos];
}

function hrTimeToNanos(hrTime: HrTime): number {
  return hrTime[0] * 1e9 + hrTime[1];
}

function timeInputToNanos(time: TimeInput): number {
  if (typeof time === 'number') {
    return time < 1e12 ? time * 1e9 : time;
  }
  if (Array.isArray(time)) {
    return hrTimeToNanos(time as HrTime);
  }
  return hrTimeToNanos(getHrTime());
}

function nowNanos(): number {
  return hrTimeToNanos(getHrTime());
}

function attrStr(attributes: Record<string, AttributeValue>, ...keys: string[]): string {
  for (const key of keys) {
    const val = attributes[key];
    if (val !== undefined && val !== '') return String(val);
  }
  return '';
}


function buildLambdaResource(): Record<string, string> {
  const attrs: Record<string, string> = {};
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  for (const pair of raw.split(',')) {
    if (pair.includes('=')) {
      const [k, ...rest] = pair.split('=');
      attrs[k.trim()] = rest.join('=').trim();
    }
  }
  attrs['service.name'] = process.env.OTEL_SERVICE_NAME || '';
  attrs['telemetry.sdk.language'] = 'nodejs';
  attrs['telemetry.sdk.name'] = 'opentelemetry';
  attrs['telemetry.sdk.version'] = '2.7.0';
  attrs['telemetry.auto.version'] = '0.11.0-dev0-aws';
  return attrs;
}


export class InstrumentationScope {
  readonly name: string;
  readonly version: string;
  readonly schemaUrl: string;

  constructor(name: string, version?: string, schemaUrl?: string) {
    this.name = name;
    this.version = version || '';
    this.schemaUrl = schemaUrl || '';
  }
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes: Attributes;
}

export interface SpanProcessor {
  onStart(span: Span, parentContext?: Context): void;
  onEnd(span: Span): void;
  forceFlush(timeoutMillis?: number): boolean;
  shutdown(): void;
}


export class Span implements SpanAPI {
  private _name: string;
  private _context: SpanContext;
  private _parent: SpanContext | undefined;
  private _kind: SpanKind;
  private _resource: Record<string, string>;
  private _instrumentationScope: InstrumentationScope;
  private _provider: TracerProvider;
  private _startTime: number | undefined;
  private _endTime: number | undefined;
  private _status: SpanStatus;
  private _attributes: Record<string, AttributeValue>;
  private _events: SpanEvent[];

  constructor(opts: {
    name: string;
    context: SpanContext;
    parent?: SpanContext;
    resource: Record<string, string>;
    attributes?: Attributes;
    kind: SpanKind;
    provider: TracerProvider;
    instrumentationScope: InstrumentationScope;
  }) {
    this._name = opts.name;
    this._context = opts.context;
    this._parent = opts.parent;
    this._kind = opts.kind;
    this._resource = opts.resource;
    this._instrumentationScope = opts.instrumentationScope;
    this._provider = opts.provider;
    this._startTime = undefined;
    this._endTime = undefined;
    this._status = { code: SpanStatusCode.UNSET };
    this._attributes = {};
    if (opts.attributes) {
      for (const [k, v] of Object.entries(opts.attributes)) {
        if (v !== undefined) this._attributes[k] = v;
      }
    }
    this._events = [];
  }

  get name(): string { return this._name; }
  get parent(): SpanContext | undefined { return this._parent; }
  get kind(): SpanKind { return this._kind; }
  get resource(): Record<string, string> { return this._resource; }
  get instrumentationScope(): InstrumentationScope { return this._instrumentationScope; }
  get attributes(): Record<string, AttributeValue> { return this._attributes; }
  get startTime(): number | undefined { return this._startTime; }
  get endTime(): number | undefined { return this._endTime; }
  get status(): SpanStatus { return this._status; }
  get events(): SpanEvent[] { return this._events; }

  spanContext(): SpanContext { return this._context; }

  setAttribute(key: string, value: AttributeValue): this {
    if (this._endTime !== undefined) return this;
    this._attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    if (this._endTime !== undefined) return this;
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this._attributes[key] = value;
    }
    return this;
  }

  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput, _startTime?: TimeInput): this {
    if (this._endTime !== undefined) return this;
    let attrs: Attributes = {};
    if (attributesOrStartTime && typeof attributesOrStartTime === 'object' && !Array.isArray(attributesOrStartTime)) {
      attrs = attributesOrStartTime as Attributes;
    }
    this._events.push({ name, timestamp: nowNanos(), attributes: attrs });
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (this._endTime !== undefined) return this;
    if (this._status.code === SpanStatusCode.OK) return this;
    if (status.code === SpanStatusCode.UNSET) return this;
    this._status = status;
    return this;
  }

  updateName(name: string): this {
    if (this._endTime !== undefined) return this;
    this._name = name;
    return this;
  }

  isRecording(): boolean {
    return this._endTime === undefined;
  }

  recordException(exception: Exception, _time?: TimeInput): void {
    if (this._endTime !== undefined) return;
    const attrs: Record<string, AttributeValue> = {};
    if (typeof exception === 'string') {
      attrs['exception.message'] = exception;
    } else if (exception instanceof Error) {
      attrs['exception.type'] = exception.name;
      attrs['exception.message'] = exception.message;
      if (exception.stack) attrs['exception.stacktrace'] = exception.stack;
    }
    attrs['exception.escaped'] = 'false';
    this._events.push({ name: 'exception', timestamp: nowNanos(), attributes: attrs });
  }

  addLink(_link: Link): this { return this; }
  addLinks(_links: Link[]): this { return this; }

  start(startTime?: number, parentContext?: Context): void {
    if (this._startTime !== undefined) return;
    this._startTime = startTime !== undefined ? startTime : nowNanos();
    this._provider.onStart(this, parentContext);
  }

  end(endTime?: TimeInput): void {
    if (this._startTime === undefined) return;
    if (this._endTime !== undefined) return;
    this._endTime = endTime !== undefined ? timeInputToNanos(endTime) : nowNanos();
    this._provider.onEnd(this);
  }
}


export class Tracer implements TracerAPI {
  private _resource: Record<string, string>;
  private _provider: TracerProvider;
  private _instrumentationScope: InstrumentationScope;

  constructor(resource: Record<string, string>, provider: TracerProvider, scope: InstrumentationScope) {
    this._resource = resource;
    this._provider = provider;
    this._instrumentationScope = scope;
  }

  startSpan(
    name: string,
    options?: {
      kind?: SpanKind;
      attributes?: Attributes;
      links?: Link[];
      startTime?: TimeInput;
      root?: boolean;
    },
    context?: Context
  ): SpanAPI {
    const activeCtx = context || contextApi.active();
    if (isTracingSuppressed(activeCtx)) {
      return traceApi.wrapSpanContext({
        traceId: INVALID_TRACE_ID,
        spanId: INVALID_SPAN_ID,
        traceFlags: TraceFlags.NONE,
      });
    }

    let parentSpanContext: SpanContext | undefined;
    let traceId: string;

    const parentSpan = traceApi.getSpan(activeCtx);
    if (parentSpan && !options?.root) {
      const psc = parentSpan.spanContext();
      if (psc && isSpanContextValid(psc)) {
        parentSpanContext = psc;
        traceId = psc.traceId;
      } else {
        traceId = generateTraceId();
      }
    } else {
      traceId = generateTraceId();
    }

    const spanContext: SpanContext = {
      traceId,
      spanId: generateSpanId(),
      traceFlags: parentSpanContext ? parentSpanContext.traceFlags : TraceFlags.SAMPLED,
      traceState: parentSpanContext?.traceState,
    };

    const span = new Span({
      name,
      context: spanContext,
      parent: parentSpanContext,
      resource: this._resource,
      attributes: options?.attributes,
      kind: options?.kind || SpanKind.INTERNAL,
      provider: this._provider,
      instrumentationScope: this._instrumentationScope,
    });

    const startTime = options?.startTime !== undefined ? timeInputToNanos(options.startTime) : undefined;
    span.start(startTime, activeCtx);
    return span;
  }

  startActiveSpan<F extends (span: SpanAPI) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: SpanAPI) => unknown>(
    name: string,
    options: { kind?: SpanKind; attributes?: Attributes; links?: Link[]; startTime?: TimeInput; root?: boolean },
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: SpanAPI) => unknown>(
    name: string,
    options: { kind?: SpanKind; attributes?: Attributes; links?: Link[]; startTime?: TimeInput; root?: boolean },
    context: Context,
    fn: F
  ): ReturnType<F>;
  startActiveSpan<F extends (span: SpanAPI) => unknown>(
    name: string,
    optionsOrFn: any,
    contextOrFn?: any,
    maybeFn?: F
  ): ReturnType<F> {
    let opts: any;
    let ctx: Context | undefined;
    let fn: F;

    if (typeof optionsOrFn === 'function') {
      fn = optionsOrFn;
    } else if (typeof contextOrFn === 'function') {
      opts = optionsOrFn;
      fn = contextOrFn;
    } else {
      opts = optionsOrFn;
      ctx = contextOrFn;
      fn = maybeFn!;
    }

    const span = this.startSpan(name, opts, ctx);
    const activeContext = traceApi.setSpan(ctx || contextApi.active(), span);
    return contextApi.with(activeContext, () => {
      try {
        return fn(span) as ReturnType<F>;
      } catch (err) {
        if (err instanceof Error) {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        }
        throw err;
      }
    });
  }
}


export class TracerProvider implements TracerProviderAPI {
  private _spanProcessors: SpanProcessor[] = [];
  private _resource: Record<string, string>;

  constructor(resource?: Record<string, string>) {
    this._resource = resource || buildLambdaResource();
  }

  get resource(): Record<string, string> { return this._resource; }

  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): TracerAPI {
    return new Tracer(this._resource, this, new InstrumentationScope(name, version, options?.schemaUrl));
  }

  addSpanProcessor(processor: SpanProcessor): void {
    this._spanProcessors.push(processor);
  }

  onStart(span: Span, parentContext?: Context): void {
    for (const sp of this._spanProcessors) sp.onStart(span, parentContext);
  }

  onEnd(span: Span): void {
    for (const sp of this._spanProcessors) sp.onEnd(span);
  }

  forceFlush(timeoutMillis: number = 30000): boolean {
    for (const sp of this._spanProcessors) sp.forceFlush(timeoutMillis);
    return true;
  }

  shutdown(): void {
    for (const sp of this._spanProcessors) sp.shutdown();
  }
}


function resolveRemoteService(attributes: Record<string, AttributeValue>): string {
  const rpcService = attributes['rpc.service'];
  if (rpcService) {
    return attributes['rpc.system'] === 'aws-api' ? 'AWS::' + String(rpcService) : String(rpcService);
  }
  const httpUrl = attrStr(attributes, 'http.url', 'url.full');
  if (httpUrl) {
    try { return new URL(httpUrl).hostname || 'UnknownRemoteService'; }
    catch { return 'UnknownRemoteService'; }
  }
  return 'UnknownRemoteService';
}

function resolveRemoteOperation(attributes: Record<string, AttributeValue>): string {
  const rpcMethod = attributes['rpc.method'];
  if (rpcMethod) return String(rpcMethod);

  const httpMethod = attrStr(attributes, 'http.method', 'http.request.method');
  const httpUrl = attrStr(attributes, 'http.url', 'url.full');
  if (httpMethod && httpUrl) {
    try { return `${httpMethod} ${new URL(httpUrl).pathname || '/'}`; }
    catch { return httpMethod; }
  }
  return httpMethod || 'UnknownRemoteOperation';
}

// ─── Protobuf Encoding ─────────────────────────────────────────────────────

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN_DELIMITED = 2;
const WIRE_FIXED32 = 5;

function encodeVarint(value: number): Buffer {
  // Fast path for small non-negative values (tags, lengths, and the common
  // case for integer attributes). `>>> 0` is only correct here because the
  // value is known to fit in 32 bits; larger / negative values are routed
  // through encodeVarintBig below.
  if (value >= 0 && value <= 0xffffffff) {
    const bytes: number[] = [];
    let v = value >>> 0;
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
  }
  return encodeVarintBig(value);
}

// Full 64-bit varint encoding. Negative integers are encoded as two's
// complement int64 (a 10-byte varint), matching protobuf int64 semantics.
// Uses BigInt() constructor form (not `n` literals) to stay compatible with
// the es2017 compile target.
const BIG_ZERO = BigInt(0);
const BIG_SEVEN_F = BigInt(0x7f);
const BIG_EIGHT_0 = BigInt(0x80);
const BIG_TWO_64 = BigInt(1) << BigInt(64);

function encodeVarintBig(value: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  if (v < BIG_ZERO) v += BIG_TWO_64;
  while (v > BIG_SEVEN_F) {
    bytes.push(Number((v & BIG_SEVEN_F) | BIG_EIGHT_0));
    v >>= BigInt(7);
  }
  bytes.push(Number(v & BIG_SEVEN_F));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeBytesField(fieldNumber: number, data: Buffer): Buffer {
  if (!data || data.length === 0) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, WIRE_LEN_DELIMITED), encodeVarint(data.length), data]);
}

function encodeStringField(fieldNumber: number, value: string): Buffer {
  if (!value) return Buffer.alloc(0);
  return encodeBytesField(fieldNumber, Buffer.from(value, 'utf-8'));
}

function encodeVarintField(fieldNumber: number, value: number): Buffer {
  if (!value) return Buffer.alloc(0);
  return Buffer.concat([encodeTag(fieldNumber, WIRE_VARINT), encodeVarint(value)]);
}

function encodeFixed64Field(fieldNumber: number, value: number): Buffer {
  if (!value) return Buffer.alloc(0);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([encodeTag(fieldNumber, WIRE_FIXED64), buf]);
}

// Always writes the field (no zero-skip), since the only caller — the span
// `flags` field — always has the HAS_IS_REMOTE bit (0x100) set, so it is never
// zero and must always be emitted.
function encodeFixed32Field(fieldNumber: number, value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return Buffer.concat([encodeTag(fieldNumber, WIRE_FIXED32), buf]);
}

function encodeAnyValue(value: AttributeValue): Buffer {
  if (typeof value === 'boolean') {
    return Buffer.concat([encodeTag(2, WIRE_VARINT), Buffer.from([value ? 0x01 : 0x00])]);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return Buffer.concat([encodeTag(3, WIRE_VARINT), encodeVarint(value)]);
    }
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value);
    return Buffer.concat([encodeTag(4, WIRE_FIXED64), buf]);
  }
  return encodeStringField(1, String(value));
}

function encodeKeyValue(key: string, value: AttributeValue): Buffer {
  return Buffer.concat([encodeStringField(1, key), encodeBytesField(2, encodeAnyValue(value))]);
}

function encodeSpanStatus(status: SpanStatus): Buffer {
  if (!status || status.code === SpanStatusCode.UNSET) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  if (status.message) parts.push(encodeStringField(1, status.message));
  const codeMap: Record<number, number> = {
    [SpanStatusCode.UNSET]: 0,
    [SpanStatusCode.OK]: 1,
    [SpanStatusCode.ERROR]: 2,
  };
  parts.push(encodeVarintField(2, codeMap[status.code] || 0));
  return Buffer.concat(parts);
}

function encodeSpanEvent(event: SpanEvent): Buffer {
  const parts: Buffer[] = [
    encodeFixed64Field(1, event.timestamp),
    encodeStringField(2, event.name),
  ];
  if (event.attributes) {
    for (const [key, value] of Object.entries(event.attributes)) {
      if (value !== undefined) parts.push(encodeBytesField(3, encodeKeyValue(key, value)));
    }
  }
  return Buffer.concat(parts);
}

function spanKindToOtlp(kind: SpanKind): number {
  const map: Record<number, number> = {
    [SpanKind.INTERNAL]: 1,
    [SpanKind.SERVER]: 2,
    [SpanKind.CLIENT]: 3,
    [SpanKind.PRODUCER]: 4,
    [SpanKind.CONSUMER]: 5,
  };
  return map[kind] || 0;
}

function encodeSpanOtlp(span: Span): Buffer {
  const ctx = span.spanContext();
  const parts: Buffer[] = [
    encodeBytesField(1, Buffer.from(ctx.traceId, 'hex')),
    encodeBytesField(2, Buffer.from(ctx.spanId, 'hex')),
  ];

  if (ctx.traceState) parts.push(encodeStringField(3, ctx.traceState.serialize()));
  if (span.parent) parts.push(encodeBytesField(4, Buffer.from(span.parent.spanId, 'hex')));

  parts.push(encodeStringField(5, span.name));
  parts.push(encodeVarintField(6, spanKindToOtlp(span.kind)));
  parts.push(encodeFixed64Field(7, span.startTime || 0));
  parts.push(encodeFixed64Field(8, span.endTime || 0));

  for (const [key, value] of Object.entries(span.attributes)) {
    if (value !== undefined) parts.push(encodeBytesField(9, encodeKeyValue(key, value)));
  }
  for (const event of span.events) {
    parts.push(encodeBytesField(11, encodeSpanEvent(event)));
  }

  // Field 16: flags. OTLP SpanFlags packs the W3C trace flags into the low byte
  // and sets HAS_IS_REMOTE (0x100) to indicate the is_remote bit is meaningful.
  parts.push(encodeFixed32Field(16, (ctx.traceFlags | 0x100) >>> 0));

  // Field 15: status. (Field 13 is `links` in the OTLP Span message — the
  // previous code wrote status to 13, which corrupted it.)
  const statusBytes = encodeSpanStatus(span.status);
  if (statusBytes.length > 0) parts.push(encodeBytesField(15, statusBytes));

  return Buffer.concat(parts);
}

function encodeResource(resourceAttrs: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(resourceAttrs)) {
    parts.push(encodeBytesField(1, encodeKeyValue(key, value)));
  }
  return Buffer.concat(parts);
}

function encodeInstrumentationScope(scope: InstrumentationScope): Buffer {
  const parts: Buffer[] = [encodeStringField(1, scope.name)];
  if (scope.version) parts.push(encodeStringField(2, scope.version));
  return Buffer.concat(parts);
}

function resourceKey(resource: Record<string, string>): string {
  if (!resource) return '';
  return Object.keys(resource)
    .sort()
    .map(k => `${k}=${resource[k]}`)
    .join(',');
}

function scopeKey(scope: InstrumentationScope | undefined): string {
  if (!scope) return ' ';
  return `${scope.name || ''} ${scope.version || ''}`;
}

function encodeExportTraceRequest(spans: Span[]): Buffer {
  if (spans.length === 0) return Buffer.alloc(0);

  // Group spans by resource, then by instrumentation scope, so each distinct
  // scope produces its own ScopeSpans entry (matching OTLP semantics and the
  // Python lite SDK). Insertion-ordered Maps keep the output deterministic.
  const resourceGroups = new Map<string, { resource: Record<string, string>; scopes: Map<string, Span[]> }>();
  for (const span of spans) {
    const rKey = resourceKey(span.resource);
    let rGroup = resourceGroups.get(rKey);
    if (!rGroup) {
      rGroup = { resource: span.resource, scopes: new Map() };
      resourceGroups.set(rKey, rGroup);
    }
    const sKey = scopeKey(span.instrumentationScope);
    let scopeSpans = rGroup.scopes.get(sKey);
    if (!scopeSpans) {
      scopeSpans = [];
      rGroup.scopes.set(sKey, scopeSpans);
    }
    scopeSpans.push(span);
  }

  const resourceSpansParts: Buffer[] = [];
  for (const rGroup of resourceGroups.values()) {
    const resourceSpanParts: Buffer[] = [];

    const resourceBytes = encodeResource(rGroup.resource);
    if (resourceBytes.length > 0) resourceSpanParts.push(encodeBytesField(1, resourceBytes));

    for (const scopeSpans of rGroup.scopes.values()) {
      const scopeSpanParts: Buffer[] = [];
      const scopeBytes = encodeInstrumentationScope(scopeSpans[0].instrumentationScope);
      if (scopeBytes.length > 0) scopeSpanParts.push(encodeBytesField(1, scopeBytes));
      for (const span of scopeSpans) {
        scopeSpanParts.push(encodeBytesField(2, encodeSpanOtlp(span)));
      }
      resourceSpanParts.push(encodeBytesField(2, Buffer.concat(scopeSpanParts)));
    }

    resourceSpansParts.push(encodeBytesField(1, Buffer.concat(resourceSpanParts)));
  }

  return Buffer.concat(resourceSpansParts);
}


export class UdpExporter {
  private _host: string;
  private _port: number;
  private _socket: dgram.Socket;

  constructor(endpoint?: string) {
    const ep = endpoint || DEFAULT_ENDPOINT;
    const [host, portStr] = ep.split(':');
    this._host = host;
    this._port = parseInt(portStr, 10);
    this._socket = dgram.createSocket('udp4');
    this._socket.unref();
  }

  sendOtlp(data: Buffer, prefix: string = 'T1U'): void {
    const message = `${PROTOCOL_HEADER}${prefix}${data.toString('base64')}`;
    try {
      this._socket.send(Buffer.from(message, 'utf-8'), this._port, this._host);
    } catch (err) {
      diag.error('Error sending OTLP UDP data', err);
    }
  }

  shutdown(): void {
    this._socket.close();
  }
}


export class UdpSpanExporter {
  private _udpExporter: UdpExporter;
  private _appSignalsEnabled: boolean;

  constructor(endpoint?: string) {
    this._udpExporter = new UdpExporter(endpoint);
    this._appSignalsEnabled = (process.env.OTEL_AWS_APPLICATION_SIGNALS_ENABLED || 'false').toLowerCase() === 'true';
  }

  export(spans: Span[]): boolean {
    try {
      if (this._appSignalsEnabled) {
        for (const span of spans) this._injectAppSignalsAttributes(span);
      } else {
        for (const span of spans) delete span.attributes['aws.is.local.root'];
      }
      const sampled = spans.length > 0 && (spans[0].spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
      const prefix = sampled ? 'T1S' : 'T1U';
      this._udpExporter.sendOtlp(encodeExportTraceRequest(spans), prefix);
      return true;
    } catch (err) {
      diag.error('Error exporting spans in lite SDK', err);
      return false;
    }
  }

  private _injectAppSignalsAttributes(span: Span): void {
    const serviceName = span.resource['service.name'] || '';
    const lambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME || '';
    const localOperation = lambdaFunctionName ? `${lambdaFunctionName}/FunctionHandler` : span.name;
    const isLocalRoot = span.attributes['aws.is.local.root'] === true;

    span.attributes['aws.local.service'] = serviceName;
    span.attributes['aws.local.operation'] = localOperation;
    span.attributes['aws.local.environment'] = 'lambda:default';

    if (isLocalRoot) {
      span.attributes['aws.span.kind'] = 'LOCAL_ROOT';
    } else if (span.kind === SpanKind.SERVER || span.kind === SpanKind.CONSUMER) {
      span.attributes['aws.span.kind'] = 'SERVER';
    } else if (span.kind === SpanKind.CLIENT || span.kind === SpanKind.PRODUCER) {
      span.attributes['aws.span.kind'] = 'CLIENT';
    }

    if (span.kind === SpanKind.CLIENT || span.kind === SpanKind.PRODUCER) {
      span.attributes['aws.remote.service'] = resolveRemoteService(span.attributes);
      span.attributes['aws.remote.operation'] = resolveRemoteOperation(span.attributes);
    }
  }

  forceFlush(): boolean { return true; }

  shutdown(): void {
    this._udpExporter.shutdown();
  }
}


export class BatchingSpanProcessor implements SpanProcessor {
  private _exporter: UdpSpanExporter;
  private _spans: Span[] = [];

  constructor(exporter: UdpSpanExporter) {
    this._exporter = exporter;
  }

  onStart(span: Span, parentContext?: Context): void {
    const parentSpan = parentContext ? traceApi.getSpan(parentContext) : undefined;
    const parentCtx = parentSpan?.spanContext();
    const isLocalRoot = !parentCtx || !isSpanContextValid(parentCtx) || parentCtx.isRemote === true;
    span.setAttribute('aws.is.local.root', isLocalRoot);

    if (parentSpan && !isLocalRoot) {
      const parentAttrs = (parentSpan as Span).attributes;
      if (parentAttrs) {
        const faasId = parentAttrs['faas.id'];
        if (faasId && !span.attributes['faas.id']) {
          span.setAttribute('faas.id', faasId);
        }
      }
    }
  }

  onEnd(span: Span): void {
    this._spans.push(span);
  }

  forceFlush(_timeoutMillis?: number): boolean {
    if (this._spans.length > 0) {
      this._exporter.export(this._spans);
      this._spans = [];
    }
    return true;
  }

  shutdown(): void {
    this.forceFlush();
    this._exporter.shutdown();
  }
}

const INSTRUMENTATION_REGISTRY: Record<string, () => any> = {
  '@opentelemetry/instrumentation-amqplib': () => require('@opentelemetry/instrumentation-amqplib').AmqplibInstrumentation,
  '@opentelemetry/instrumentation-aws-lambda': () => require('@opentelemetry/instrumentation-aws-lambda').AwsLambdaInstrumentation,
  '@opentelemetry/instrumentation-aws-sdk': () => require('@opentelemetry/instrumentation-aws-sdk').AwsInstrumentation,
  '@opentelemetry/instrumentation-bunyan': () => require('@opentelemetry/instrumentation-bunyan').BunyanInstrumentation,
  '@opentelemetry/instrumentation-cassandra-driver': () => require('@opentelemetry/instrumentation-cassandra-driver').CassandraDriverInstrumentation,
  '@opentelemetry/instrumentation-connect': () => require('@opentelemetry/instrumentation-connect').ConnectInstrumentation,
  '@opentelemetry/instrumentation-cucumber': () => require('@opentelemetry/instrumentation-cucumber').CucumberInstrumentation,
  '@opentelemetry/instrumentation-dataloader': () => require('@opentelemetry/instrumentation-dataloader').DataloaderInstrumentation,
  '@opentelemetry/instrumentation-dns': () => require('@opentelemetry/instrumentation-dns').DnsInstrumentation,
  '@opentelemetry/instrumentation-express': () => require('@opentelemetry/instrumentation-express').ExpressInstrumentation,
  '@opentelemetry/instrumentation-fs': () => require('@opentelemetry/instrumentation-fs').FsInstrumentation,
  '@opentelemetry/instrumentation-generic-pool': () => require('@opentelemetry/instrumentation-generic-pool').GenericPoolInstrumentation,
  '@opentelemetry/instrumentation-graphql': () => require('@opentelemetry/instrumentation-graphql').GraphQLInstrumentation,
  '@opentelemetry/instrumentation-grpc': () => require('@opentelemetry/instrumentation-grpc').GrpcInstrumentation,
  '@opentelemetry/instrumentation-hapi': () => require('@opentelemetry/instrumentation-hapi').HapiInstrumentation,
  '@opentelemetry/instrumentation-host-metrics': () => require('@opentelemetry/instrumentation-host-metrics').HostMetricsInstrumentation,
  '@opentelemetry/instrumentation-http': () => require('@opentelemetry/instrumentation-http').HttpInstrumentation,
  '@opentelemetry/instrumentation-ioredis': () => require('@opentelemetry/instrumentation-ioredis').IORedisInstrumentation,
  '@opentelemetry/instrumentation-kafkajs': () => require('@opentelemetry/instrumentation-kafkajs').KafkaJsInstrumentation,
  '@opentelemetry/instrumentation-knex': () => require('@opentelemetry/instrumentation-knex').KnexInstrumentation,
  '@opentelemetry/instrumentation-koa': () => require('@opentelemetry/instrumentation-koa').KoaInstrumentation,
  '@opentelemetry/instrumentation-lru-memoizer': () => require('@opentelemetry/instrumentation-lru-memoizer').LruMemoizerInstrumentation,
  '@opentelemetry/instrumentation-memcached': () => require('@opentelemetry/instrumentation-memcached').MemcachedInstrumentation,
  '@opentelemetry/instrumentation-mongodb': () => require('@opentelemetry/instrumentation-mongodb').MongoDBInstrumentation,
  '@opentelemetry/instrumentation-mongoose': () => require('@opentelemetry/instrumentation-mongoose').MongooseInstrumentation,
  '@opentelemetry/instrumentation-mysql2': () => require('@opentelemetry/instrumentation-mysql2').MySQL2Instrumentation,
  '@opentelemetry/instrumentation-mysql': () => require('@opentelemetry/instrumentation-mysql').MySQLInstrumentation,
  '@opentelemetry/instrumentation-nestjs-core': () => require('@opentelemetry/instrumentation-nestjs-core').NestInstrumentation,
  '@opentelemetry/instrumentation-net': () => require('@opentelemetry/instrumentation-net').NetInstrumentation,
  '@opentelemetry/instrumentation-openai': () => require('@opentelemetry/instrumentation-openai').OpenAIInstrumentation,
  '@opentelemetry/instrumentation-oracledb': () => require('@opentelemetry/instrumentation-oracledb').OracleInstrumentation,
  '@opentelemetry/instrumentation-pg': () => require('@opentelemetry/instrumentation-pg').PgInstrumentation,
  '@opentelemetry/instrumentation-pino': () => require('@opentelemetry/instrumentation-pino').PinoInstrumentation,
  '@opentelemetry/instrumentation-redis': () => require('@opentelemetry/instrumentation-redis').RedisInstrumentation,
  '@opentelemetry/instrumentation-restify': () => require('@opentelemetry/instrumentation-restify').RestifyInstrumentation,
  '@opentelemetry/instrumentation-router': () => require('@opentelemetry/instrumentation-router').RouterInstrumentation,
  '@opentelemetry/instrumentation-runtime-node': () => require('@opentelemetry/instrumentation-runtime-node').RuntimeNodeInstrumentation,
  '@opentelemetry/instrumentation-socket.io': () => require('@opentelemetry/instrumentation-socket.io').SocketIoInstrumentation,
  '@opentelemetry/instrumentation-tedious': () => require('@opentelemetry/instrumentation-tedious').TediousInstrumentation,
  '@opentelemetry/instrumentation-undici': () => require('@opentelemetry/instrumentation-undici').UndiciInstrumentation,
  '@opentelemetry/instrumentation-winston': () => require('@opentelemetry/instrumentation-winston').WinstonInstrumentation,
};


const DEFAULT_EXCLUDED_INSTRUMENTATIONS: string[] = [
  '@opentelemetry/instrumentation-fs',
  '@opentelemetry/instrumentation-host-metrics',
];


function instrumentationConfigFor(name: string): Record<string, unknown> {
  if (name === '@opentelemetry/instrumentation-aws-sdk') {
    return { suppressInternalInstrumentation: true };
  }
  if (name === '@opentelemetry/instrumentation-aws-lambda') {
    return { eventContextExtractor: liteEventContextExtractor };
  }
  return {};
}

function parseInstrumentationEnv(envVar: string): string[] {
  const value = process.env[envVar];
  if (!value) return [];
  return value
    .split(',')
    .map(suffix => suffix.trim())
    .filter(suffix => suffix !== '')
    .map(suffix => `@opentelemetry/instrumentation-${suffix}`);
}

function getEnabledInstrumentationsFromEnv(): string[] {
  if (!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS) {
    return Object.keys(INSTRUMENTATION_REGISTRY).filter(
      key => !DEFAULT_EXCLUDED_INSTRUMENTATIONS.includes(key)
    );
  }
  return parseInstrumentationEnv('OTEL_NODE_ENABLED_INSTRUMENTATIONS');
}

function shouldDisableInstrumentation(
  name: string,
  enabledFromEnv: string[],
  disabledFromEnv: string[]
): boolean {
  if (disabledFromEnv.includes(name)) return true;

  const isEnabledEnvSet = !!process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  if (isEnabledEnvSet && !enabledFromEnv.includes(name)) return true;

  if (!isEnabledEnvSet && DEFAULT_EXCLUDED_INSTRUMENTATIONS.includes(name)) return true;

  return false;
}

export function buildInstrumentations(): any[] {
  const enabledFromEnv = getEnabledInstrumentationsFromEnv();
  const disabledFromEnv = parseInstrumentationEnv('OTEL_NODE_DISABLED_INSTRUMENTATIONS');
  const instrumentations: any[] = [];

  for (const name of Object.keys(INSTRUMENTATION_REGISTRY)) {
    if (shouldDisableInstrumentation(name, enabledFromEnv, disabledFromEnv)) {
      continue;
    }
    try {
      const InstrumentationClass = INSTRUMENTATION_REGISTRY[name]();
      if (typeof InstrumentationClass !== 'function') {
        diag.debug(`Lite SDK: instrumentation class not found for ${name}`);
        continue;
      }
      const instrumentation = new InstrumentationClass(instrumentationConfigFor(name));
      if (name === '@opentelemetry/instrumentation-aws-sdk') {
        patchAwsSdkForSmithyCore(instrumentation);
      }
      instrumentations.push(instrumentation);
    } catch (e) {
      diag.debug(`Lite SDK: failed to load instrumentation ${name}`, e);
    }
  }

  return instrumentations;
}


export function configureLiteMode(): TracerProvider {
  const logLevelName = (process.env.OTEL_LOG_LEVEL || '').toUpperCase();
  if (logLevelName) {
    const { DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
    const level = (DiagLogLevel as Record<string, number>)[logLevelName];
    if (level !== undefined) {
      diag.setLogger(new DiagConsoleLogger(), level);
    }
  }

  const provider = new TracerProvider();
  const endpoint = process.env.AWS_XRAY_DAEMON_ADDRESS || DEFAULT_ENDPOINT;
  provider.addSpanProcessor(new BatchingSpanProcessor(new UdpSpanExporter(endpoint)));

  traceApi.setGlobalTracerProvider(provider);

  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  contextApi.setGlobalContextManager(contextManager);

  const otelCore = require('@opentelemetry/core');
  const { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } = otelCore;
  isTracingSuppressed = otelCore.isTracingSuppressed;
  const { AWSXRayPropagator } = require('@opentelemetry/propagator-aws-xray');

  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CBaggagePropagator(), new AWSXRayPropagator(), new W3CTraceContextPropagator()],
    })
  );

  for (const instrumentation of buildInstrumentations()) {
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  }

  return provider;
}

export function liteEventContextExtractor(event: any, handlerContext: any): Context {
  const xrayTraceId = handlerContext?.['xRayTraceId'] || process.env[TRACE_CONTEXT_ENV_KEY];

  const httpHeaders = event?.headers ? { ...event.headers } : {};
  if (xrayTraceId) {
    for (const key of Object.keys(httpHeaders)) {
      if (key.toLowerCase() === XRAY_TRACE_ID_HEADER) delete httpHeaders[key];
    }
    httpHeaders[XRAY_TRACE_ID_HEADER] = xrayTraceId;
  }

  const headerGetter = {
    keys(carrier: any): string[] { return Object.keys(carrier); },
    get(carrier: any, key: string) { return carrier[key]; },
  };

  const extractedContext = propagation.extract(contextApi.active(), httpHeaders, headerGetter);
  if (traceApi.getSpan(extractedContext)?.spanContext()) return extractedContext;
  return ROOT_CONTEXT;
}

// ─── Smithy Core Patch ─────────────────────────────────────────────────────
//
// Overrides the upstream private `_getV3SmithyClientSendPatch` to add ADOT
// middlewares (X-Ray context injection, credential extraction, response metadata
// capture). The upstream AwsInstrumentation already registers the require hook for
// `@smithy/core/dist-cjs/submodules/client/index.js` in its init(), so we only need
// to override the patch factory — registering a second hook here would double-wrap
// `Client.prototype.send` and break the captured `original` reference.

export function patchAwsSdkForSmithyCore(awsInstrumentation: any): void {
  try {
    const instr = awsInstrumentation;

    instr['_getV3SmithyClientSendPatch'] = function (this: any, ...factoryArgs: unknown[]) {
      const self = this;
      const original = factoryArgs.find(arg => typeof arg === 'function') as (
        ...args: unknown[]
      ) => Promise<any>;
      return function send(this: any, command: any, ...args: unknown[]): Promise<any> {
        if (!this.__adotMiddlewarePatched) {
          if (this.middlewareStack) {
            self.patchV3MiddlewareStack(undefined, this.middlewareStack);
          }
          this.middlewareStack?.add(
            (next: any) => async (middlewareArgs: any) => {
              propagation.inject(contextApi.active(), middlewareArgs.request.headers, defaultTextMapSetter);
              const xrayId = middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER];
              if (xrayId) {
                middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER_CAPITALIZED] = xrayId;
                delete middlewareArgs.request.headers[XRAY_TRACE_ID_HEADER];
              }
              return await next(middlewareArgs);
            },
            { step: 'build', name: '_adotInjectXrayContextMiddleware', override: true }
          );
          const clientConfig = this.config;
          this.middlewareStack?.add(
            (next: any) => async (middlewareArgs: any) => {
              const span = traceApi.getSpan(contextApi.active());
              if (span) {
                try {
                  if (clientConfig.credentials instanceof Function) {
                    const creds = await clientConfig.credentials();
                    if (creds?.accessKeyId) {
                      span.setAttribute('aws.auth.account.access_key', creds.accessKeyId);
                    }
                  }
                  if (clientConfig.region instanceof Function) {
                    const region = await clientConfig.region();
                    if (region) {
                      span.setAttribute('aws.auth.region', region);
                    }
                  }
                } catch (_) { /* best-effort */ }
              }
              return await next(middlewareArgs);
            },
            { step: 'build', name: '_adotExtractCredentials', override: true }
          );
          this.middlewareStack?.add(
            (next: any) => async (middlewareArgs: any) => {
              const result = await next(middlewareArgs);
              const span = traceApi.getSpan(contextApi.active());
              if (span && result?.output?.$metadata) {
                const meta = result.output.$metadata;
                if (meta.requestId) {
                  span.setAttribute('aws.request.id', meta.requestId);
                }
                if (meta.extendedRequestId) {
                  span.setAttribute('aws.request.extended_id', meta.extendedRequestId);
                }
                if (meta.httpStatusCode) {
                  span.setAttribute('http.status_code', meta.httpStatusCode);
                }
              }
              return result;
            },
            { step: 'deserialize', name: '_adotCaptureResponseMetadata', override: true }
          );
          this.__adotMiddlewarePatched = true;
        }
        command[Symbol.for('opentelemetry.instrumentation.aws-sdk.client.config')] = this.config;
        return original.apply(this, [command, ...args]);
      };
    };
  } catch (e) {
    diag.debug('Failed to patch _getV3SmithyClientSendPatch for lite SDK', e);
  }
}
