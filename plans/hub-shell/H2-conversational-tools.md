# conversational tool rendering (kill the JSON blob)

STATUS: open
PARENT: hub-shell

Pure toolPresenter.ts: (TranscriptTool)→{verb,subject,detail?} — bash→'Ran'+command (not JSON envelope), read/write/edit→verb+repo-relative path, grep/glob→pattern, unknown→name+trimmed args. ToolLine renders verb+subject in the existing dot grammar; raw args/result one fold deeper (click to expand, never default). Restyle system/gate copy. Single highest-leverage feel fix; additive, no wire change (argsText/args/resultText already carried). TOUCHES: new timeline/toolPresenter.ts(+test), timeline/TimelineRowView.tsx (ToolLine only). SIZE S. VERIFY: presenter unit tests over real captured transcripts; live thread read-through. Taste-critical. Safe to land first, even before H0.
