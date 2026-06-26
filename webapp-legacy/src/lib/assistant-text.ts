import type { AppendMessage } from "@assistant-ui/react";

function quotedText(message: AppendMessage): string {
  const quote = message.metadata?.custom?.quote;
  if (!quote || typeof quote !== "object" || !("text" in quote) || typeof quote.text !== "string") return "";
  return quote.text.trim();
}

export function appendText(message: AppendMessage): string {
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  const quote = quotedText(message);
  if (!quote) return text;
  return `${quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${text}`.trim();
}
