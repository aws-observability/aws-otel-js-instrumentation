/**
 * OpenTelemetry Semantic Convention attribute keys for Generative AI operations.
 * These constants follow the OTel GenAI semantic conventions.
 */

/** The name of the operation being performed (e.g., 'chat', 'completion'). */
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/** The AI system or provider (e.g., 'openai', 'anthropic'). */
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';

/** The model name requested for the operation. */
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';

/** The number of input tokens used in the request. */
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';

/** The number of output tokens generated in the response. */
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/** The name of the tool being invoked. */
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';

/** LangGraph node name attribute. */
export const ATTR_GEN_AI_LANGGRAPH_NODE = 'gen_ai.langgraph.node';

/** LangGraph step number attribute. */
export const ATTR_GEN_AI_LANGGRAPH_STEP = 'gen_ai.langgraph.step';

/** Input messages for the request. */
export const ATTR_GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';

/** Output messages from the response. */
export const ATTR_GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';

/** Reasons why the model stopped generating. */
export const ATTR_GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';

/** Unique identifier for the response. */
export const ATTR_GEN_AI_RESPONSE_ID = 'gen_ai.response.id';

/** Tool calls made by the model. */
export const ATTR_GEN_AI_OUTPUT_TOOL_CALLS = 'gen_ai.output.tool_calls';
