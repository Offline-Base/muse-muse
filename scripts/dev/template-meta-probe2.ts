// Probes multi-turn input with an assistant message, and loose recursive schemas. Throwaway.
import OpenAI from "openai";
const meta = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY! });
try {
  const res = await meta.responses.create({
    model: "muse-spark-1.3",
    reasoning: { effort: "low" },
    input: [
      { role: "user", content: "Name a bird as JSON {\"name\": string, \"count\": integer}." },
      { role: "assistant", content: "{\"name\": \"robin\", \"count\": \"three\"}" },
      { role: "user", content: "That JSON did not match: count must be an integer. Reply with only the corrected JSON." },
    ],
  });
  console.log("assistant-turn OK:", res.output_text, JSON.stringify(res.usage));
} catch (e) {
  console.log("assistant-turn FAIL", (e as Error).message);
}
try {
  const res = await meta.responses.create({
    model: "muse-spark-1.3",
    reasoning: { effort: "low" },
    input: "Make up a tiny family tree.",
    text: { format: { type: "json_schema", name: "tree", strict: false, schema: { type: "object", properties: { name: { type: "string" }, kids: { type: "array", items: { $ref: "#" } } }, required: ["name", "kids"] } } },
  });
  console.log("loose-recursive OK:", res.output_text.slice(0, 200));
} catch (e) {
  const err = e as InstanceType<typeof OpenAI.APIError>;
  console.log("loose-recursive FAIL", err.status, JSON.stringify(err.error));
}
