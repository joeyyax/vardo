import OpenAI from "openai";
import { LineItemGroup } from "./generate";

// Check if OpenAI is configured
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Check if AI summaries are available (OpenAI key is configured).
 */
export function isAISummaryAvailable(): boolean {
  return !!OPENAI_API_KEY;
}

/**
 * Generate AI summaries for invoice line items.
 * Uses GPT-4o-mini for cost-effective summaries.
 * Returns null for each item if AI is not available.
 */
export async function generateLineItemSummaries(
  groups: LineItemGroup[]
): Promise<(string | null)[]> {
  if (!isAISummaryAvailable()) {
    return groups.map(() => null);
  }

  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
  });

  const summaries: (string | null)[] = [];

  for (const group of groups) {
    if (group.descriptions.length === 0) {
      summaries.push(null);
      continue;
    }

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a professional invoice writer. Summarize time entry descriptions into a concise, professional line item description for an invoice.

Rules:
- Keep it to 1-2 sentences maximum
- Use professional, client-facing language
- Focus on deliverables and outcomes
- Remove any internal notes or technical jargon
- If descriptions are vague, create a reasonable professional summary
- Do not include time or duration information`,
          },
          {
            role: "user",
            content: `Project: ${group.projectName}${group.taskName ? `\nTask: ${group.taskName}` : ""}

Time entry descriptions:
${group.descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n")}

Write a brief professional description for this invoice line item:`,
          },
        ],
        max_tokens: 100,
        temperature: 0.3,
      });

      const summary = response.choices[0]?.message?.content?.trim() || null;
      summaries.push(summary);
    } catch (error) {
      console.error("Error generating AI summary:", error);
      // Fall back to null on error
      summaries.push(null);
    }
  }

  return summaries;
}

/**
 * Generate a single summary for one line item group.
 */
export async function generateSingleSummary(
  group: LineItemGroup
): Promise<string | null> {
  const [summary] = await generateLineItemSummaries([group]);
  return summary;
}
