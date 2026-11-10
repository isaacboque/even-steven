import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** A model that answers every call with the given JSON/text, in order (last one repeats). */
export function textModel(...answers: string[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const text = answers[Math.min(i++, answers.length - 1)];
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] } as never;
    },
  });
}
export { usage as mockUsage };
