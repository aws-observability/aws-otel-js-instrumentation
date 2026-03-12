# opentelemetry-instrumentation-langchain

OpenTelemetry instrumentation for [LangChain](https://js.langchain.com/).

This package provides automatic tracing for LangChain operations including LLM calls, chains, and tools using OpenTelemetry semantic conventions for Generative AI (v1.39).

## Installation

```bash
npm install opentelemetry-instrumentation-langchain
```

## Usage

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangChainInstrumentation } from 'opentelemetry-instrumentation-langchain';

const sdk = new NodeSDK({
  instrumentations: [new LangChainInstrumentation()],
});

sdk.start();
```

## Supported Versions

- `@langchain/core` ^0.3.x || ^1.x

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OTEL_INSTRUMENTATION_LANGCHAIN_ENABLED` | Enable/disable the instrumentation | `true` |

## Semantic Conventions

This instrumentation follows the [OpenTelemetry Semantic Conventions for Generative AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (v1.39).

Attributes set on spans:

- `gen_ai.operation.name` - Operation type (e.g., 'chat', 'chain', 'execute_tool')
- `gen_ai.system` - AI provider (e.g., 'openai', 'anthropic', 'aws.bedrock')
- `gen_ai.request.model` - Model name
- `gen_ai.usage.input_tokens` - Input token count
- `gen_ai.usage.output_tokens` - Output token count
- `gen_ai.tool.name` - Tool name for tool executions

## License

Apache-2.0
