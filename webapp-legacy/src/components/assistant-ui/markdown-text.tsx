import { memo } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const plugins = { code };

function MarkdownTextImpl() {
  const text = useAuiState((state) => (state.part.type === "text" || state.part.type === "reasoning" ? state.part.text : ""));
  return (
    <div className="aui-md text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--radius-md)] [&_pre]:border [&_pre]:border-border [&_pre]:bg-secondary [&_pre]:p-3 [&_code]:font-mono [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      <Streamdown plugins={plugins}>{text}</Streamdown>
    </div>
  );
}

export const MarkdownText = memo(MarkdownTextImpl);
