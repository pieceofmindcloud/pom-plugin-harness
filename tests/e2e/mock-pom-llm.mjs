// Stand-in for the POM OpenAI-compatible endpoint in end-to-end tests: one
// model, and a streamed chat completion that echoes the last user message.
// With MOCK_LLM_API_KEY set, every request must carry that Bearer key, like
// the node's `/v1` with its API keys.
import http from "node:http";

const port = Number(process.env.MOCK_LLM_PORT || 0);
// MOCK_LLM_MODELS is a comma-separated list; empty means "no model deployed".
// POST /__mock/models with a JSON array replaces it while running.
let models = (process.env.MOCK_LLM_MODELS ?? process.env.MOCK_LLM_MODEL ?? "pom-test-model")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const requests = [];

function lastUserText(body) {
  const message = [...(body.messages ?? [])].reverse().find((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null });
    if (request.method === "POST" && request.url === "/__mock/models") {
      models = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]");
      response.writeHead(204).end();
      return;
    }
    const expected = process.env.MOCK_LLM_API_KEY;
    if (expected && request.headers.authorization !== `Bearer ${expected}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid api key" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "pom" })) }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
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
