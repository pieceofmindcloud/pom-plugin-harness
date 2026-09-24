// Stand-in for the POM OpenAI-compatible endpoint in end-to-end tests: a model
// list with the node's limit fields, and a streamed chat completion that
// echoes the last user message.
// With MOCK_LLM_API_KEY set, every request must carry that Bearer key, like
// the node's `/v1` with its API keys.
import http from "node:http";

const port = Number(process.env.MOCK_LLM_PORT || 0);
// MOCK_LLM_MODELS is a comma-separated list of `id` or `id:context`; empty
// means "no model deployed". A model without a context publishes no limits,
// like a deployment whose capacity the node is still confirming.
// POST /__mock/models with a JSON array of the same strings replaces it while
// running; GET /__mock/requests lists what the clients sent.
function parseModel(entry) {
  const [id, context] = String(entry).trim().split(":");
  return { id, context: context ? Number(context) : undefined };
}
let models = (process.env.MOCK_LLM_MODELS ?? process.env.MOCK_LLM_MODEL ?? "pom-test-model")
  .split(",")
  .map(parseModel)
  .filter((model) => model.id);
const requests = [];

/** The node's `/v1/models` row: the context is also the output ceiling of one request. */
function modelRow({ id, context = null }) {
  return {
    id,
    object: "model",
    owned_by: "pom",
    max_input_tokens: context,
    max_tokens: context,
    context_length: context,
    top_provider: { context_length: context, max_completion_tokens: context },
  };
}

function lastUserText(body) {
  const message = [...(body.messages ?? [])].reverse().find((item) => item.role === "user");
  if (!message) return "";
  const text =
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("");
  // Claude Code prepends <system-reminder> context to the user's text; echo only what was typed.
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "POST" && request.url === "/__mock/models") {
      models = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]").map(parseModel);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/__mock/requests") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(requests));
      return;
    }
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      userAgent: request.headers["user-agent"] ?? null,
    };
    requests.push(entry);
    const expected = process.env.MOCK_LLM_API_KEY;
    if (expected && request.headers.authorization !== `Bearer ${expected}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid api key" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: models.map(modelRow) }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      Object.assign(entry, { model: body.model, max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null });
      const text = `POM mock reply: ${lastUserText(body)}`;
      const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: body.model };
      if (!body.stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ...base, object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404).end();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on("SIGTERM", () => {
  process.stderr.write(`mock-pom-llm requests: ${JSON.stringify(requests)}\n`);
  process.exit(0);
});
