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
}

// Default model when none is specified in the request
const DEFAULT_MODEL = '@cf/nvidia/nemotron-3-120b-a12b';

// Generate a unique ID for each response
function generateId(): string {
  return 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    // Only accept POST requests
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
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
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Extract messages
      const messages = requestData.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Determine which model to use: prefer request model, fallback to default
      const modelToRun = requestData.model || DEFAULT_MODEL;
      const responseId = generateId();
      const created = Math.floor(Date.now() / 1000);

      // --- Streaming mode ---
      if (requestData.stream) {
        const stream = await env.AI.run(modelToRun, {
          messages,
          stream: true,
        });

        // If the AI returns a ReadableStream, pipe it through as SSE
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
                // Parse SSE lines from Cloudflare AI
                const lines = text.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(line.slice(6));
                      const chunk = {
                        id: responseId,
                        object: 'chat.completion.chunk',
                        created,
                        model: modelToRun,
                        choices: [
                          {
                            index: 0,
                            delta: { content: data.response || '' },
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
                    // Send the final chunk with finish_reason
                    const finalChunk = {
                      id: responseId,
                      object: 'chat.completion.chunk',
                      created,
                      model: modelToRun,
                      choices: [
                        {
                          index: 0,
                          delta: {},
                          finish_reason: 'stop',
                        },
                      ],
                    };
                    await writer.write(
                      encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
                    );
                    await writer.write(encoder.encode('data: [DONE]\n\n'));
                  }
                }
              }
            } catch (err) {
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
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }

      // --- Non-streaming mode ---
      const result = await env.AI.run(modelToRun, { messages });

      if (result.error) {
        return new Response(
          JSON.stringify({
            error: {
              message: result.error,
              type: 'model_error',
            },
          }),
          {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }

      // Build the OpenAI-compatible response
      const responseContent = result.response || '';
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
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'An unexpected error occurred',
            type: 'server_error',
          },
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },
};
