import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

// Lazy-loaded (see Transcript) so Shiki/markdown deps stay out of the initial
// bundle. Streamdown is purpose-built for AI output (incomplete-markdown safe,
// GFM, Shiki code highlighting) and themes off our shadcn token bridge.
const plugins = { code };

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <Streamdown plugins={plugins}>{children}</Streamdown>
    </div>
  );
}
