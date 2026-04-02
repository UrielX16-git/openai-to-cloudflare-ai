// Define the structure for the environment variables
export interface Env {
  AI: {
    run: (
      model: string,
      options: {
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
      }
    ) => Promise<any>;
  };
  API_KEY?: string; // Optional: if set, requires Bearer token auth
}

// Default model when none is specified in the request
const DEFAULT_MODEL = '@cf/nvidia/nemotron-3-120b-a12b';

// Generate a unique ID for each response
function generateId(): string {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

// Helper: extract text content from diverse AI response shapes
function extractContent(result: any): string {
  if (typeof result === 'string') return result;
  if (result?.response) return result.response;
  if (result?.result) return typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
  if (result?.content) return result.content;
  if (result?.text) return result.text;
  if (result?.output) return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  if (result?.choices?.[0]?.message?.content) return result.choices[0].message.content;
  // Last resort: stringify the whole object
  return JSON.stringify(result);
}

// Common CORS headers
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // --- Authentication ---
    // If API_KEY is configured, require Bearer token on POST and protected GET endpoints
    const protectedGetPaths = ['/v1/models', '/models'];
    const needsAuth =
      request.method === 'POST' ||
      (request.method === 'GET' && protectedGetPaths.includes(url.pathname));

    if (env.API_KEY && needsAuth) {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

      if (token !== env.API_KEY) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Invalid API key. Provide a valid key via Authorization: Bearer <key>',
              type: 'authentication_error',
              code: 'invalid_api_key',
            },
          }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }
    }

    // GET / → health check (always public)
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'OpenAI-Compatible Cloudflare AI Proxy',
          default_model: DEFAULT_MODEL,
          auth_required: !!env.API_KEY,
          endpoints: {
            chat: 'POST /v1/chat/completions',
            models: 'GET /v1/models',
            health: 'GET /',
            debug: 'POST /debug',
          },
        }),
        {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    // GET /v1/models or /models → OpenAI-compatible model list
    if (request.method === 'GET' && protectedGetPaths.includes(url.pathname)) {
      const created = Math.floor(Date.now() / 1000);
      const models = [
        '@cf/nvidia/nemotron-3-120b-a12b',
        '@cf/meta/llama-3-8b-instruct',
        '@cf/meta/llama-3.1-8b-instruct',
        '@cf/meta/llama-3.2-3b-instruct',
        '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        '@cf/mistral/mistral-7b-instruct-v0.1',
        '@cf/google/gemma-7b-it',
        '@cf/qwen/qwen1.5-14b-chat-awq',
        '@cf/deepseek/deepseek-r1-distill-qwen-32b',
      ];

      return new Response(
        JSON.stringify({
          object: 'list',
          data: models.map((id) => ({
            id,
            object: 'model',
            created,
            owned_by: 'cloudflare',
          })),
        }),
        {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }

    // Accept POST on / , /v1/chat/completions, or /chat/completions
    const validPaths = ['/', '/v1/chat/completions', '/chat/completions'];
    const isDebug = url.pathname === '/debug';

    if (request.method !== 'POST' || (!validPaths.includes(url.pathname) && !isDebug)) {
      return new Response(
        JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }

    try {
      // Parse the JSON body from the request (OpenAI-compatible format)
      const requestData = (await request.json()) as {
        model?: string;
        messages: Array<{ role: string; content: string }>;
        stream?: boolean;
        temperature?: number;
        max_tokens?: number;
      };

      if (!requestData.messages || !Array.isArray(requestData.messages)) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'messages is required and must be an array',
              type: 'invalid_request_error',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      // Extract messages
      const messages = requestData.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Determine which model to use
      const modelToRun = requestData.model || DEFAULT_MODEL;
      const responseId = generateId();
      const created = Math.floor(Date.now() / 1000);

      // --- Streaming mode ---
      if (requestData.stream) {
        const stream = await env.AI.run(modelToRun, {
          messages,
          stream: true,
        });

        if (stream instanceof ReadableStream) {
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          (async () => {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(line.slice(6));
                      const chunkContent = data.response || data.content || data.text || '';
                      const chunk = {
                        id: responseId,
                        object: 'chat.completion.chunk',
                        created,
                        model: modelToRun,
                        choices: [
                          {
                            index: 0,
                            delta: { content: chunkContent },
                            finish_reason: null,
                          },
                        ],
                      };
                      await writer.write(
                        encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                      );
                    } catch {
                      // Skip malformed JSON lines
                    }
                  } else if (line.trim() === 'data: [DONE]') {
                    const finalChunk = {
                      id: responseId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelToRun,
                      choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' },
                      ],
                    };
                    await writer.write(
                      encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
                    );
                    await writer.write(encoder.encode('data: [DONE]\n\n'));
                  }
                }
              }
            } catch {
              // Silently close on error
            } finally {
              await writer.close();
            }
          })();

          return new Response(readable, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              ...CORS_HEADERS,
            },
          });
        }
      }

      // --- Non-streaming mode ---
      const result = await env.AI.run(modelToRun, { messages });

      // Debug endpoint: return raw AI response for troubleshooting
      if (isDebug) {
        return new Response(
          JSON.stringify({
            raw_result: result,
            raw_type: typeof result,
            extracted_content: extractContent(result),
          }),
          { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
        );
      }

      if (result?.error) {
        return new Response(
          JSON.stringify({
            error: { message: result.error, type: 'model_error' },
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }

      // Build the OpenAI-compatible response
      // Some models (e.g. Nemotron) already return OpenAI-compatible format
      if (result?.choices?.[0]?.message?.content !== undefined) {
        // Already in OpenAI format — pass through with CORS headers
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      // For models that return { response: "..." } (e.g. Llama, Mistral)
      const responseContent = extractContent(result);
      const openAIResponse = {
        id: responseId,
        object: 'chat.completion',
        created,
        model: modelToRun,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: responseContent,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: -1,
          completion_tokens: -1,
          total_tokens: -1,
        },
      };

      return new Response(JSON.stringify(openAIResponse), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'An unexpected error occurred';
      return new Response(
        JSON.stringify({
          error: { message: errMsg, type: 'server_error' },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        }
      );
    }
  },
};
