# Block registry + PlanMarkdown pre-override refactor + block stubs
STATUS: open
PRIORITY: p0
REPOS: omp-squad
COMPLEXITY: architectural
TOUCHES: webapp/src/components/PlanBlocks.tsx, webapp/src/components/blocks/index.ts, webapp/src/components/blocks/WireframeBlock.tsx, webapp/src/components/blocks/FileTreeBlock.tsx, webapp/src/components/blocks/QuestionsBlock.tsx, webapp/src/components/blocks/AnnotatedCodeBlock.tsx, webapp/src/components/blocks/CalloutBlock.tsx, webapp/src/components/blocks/ColumnsBlock.tsx, webapp/src/components/TaskDetail.tsx

## Goal

Build the single render seam: a block registry + a React context, dispatched from
a `pre` component override in `PlanMarkdown`. Ship a minimal STUB for every block
component so later concerns flesh out their own file (build stays green, no two
units edit the same new file). Preserve the existing syntax-highlighter path for
normal code fences.

## Approach

### Verified react-markdown v10 facts (do NOT re-derive; the current code is subtly wrong)
- The `inline` prop was REMOVED in react-markdown v9. The current `MarkdownCode`
  (`TaskDetail.tsx:107-122`) branches on `if (!inline && match)` — `inline` is
  always `undefined`, so the guard is really carried by the `language-` match.
  Do not rely on `inline`.
- Block (fenced) code is the ONLY code wrapped in `<pre>`. So override `pre` for
  unambiguous block dispatch; leave `code` for inline.
- The fence info-string after the first token is on the hast node at
  `node.children[0].data.meta` (react-markdown passes `node` to component
  overrides). className keeps only `language-<firstToken>`.
- The raw fence body is `node.children[0].children[0].value` (literal text, not
  parsed/escaped). Strip a single trailing `\n`.

### Steps

1. **Create `webapp/src/components/PlanBlocks.tsx`:**
   - `parseMeta(meta: string): Record<string,string>` — split on whitespace,
     parse `key=value` and `key="quoted value"` pairs. Bare tokens (no `=`) ignored.
   - `PlanBlockContext` (React context) carrying the data blocks need that isn't in
     the fence body:
     ```ts
     export interface PlanBlockCtx {
       featureId?: string;
       repo?: string;
       planPath?: string;            // selectedPlanDoc.path
       touches?: string[];           // concern TOUCHES (for filetree)
       decisions?: string[];         // concern Decisions (for questions prefill)
       comments?: ArtifactCommentDTO[];
       onAnswer?: (blockId: string, questionId: string, value: string) => void | Promise<void>;
       onAnchorComment?: (blockId: string) => void;  // concern 10 wires this
     }
     export const PlanBlockContext = React.createContext<PlanBlockCtx>({});
     ```
   - `BlockProps`: `{ params: Record<string,string>; body: string; blockId: string }`
     (the component reads context via `useContext(PlanBlockContext)`).
   - `BLOCK_REGISTRY: Record<string, React.FC<BlockProps>>` importing the stub
     components from `./blocks`.
   - `blockId` resolution: prefer `params.id`; else an 8-char hash of the trimmed
     body (a small synchronous string hash is fine — does NOT need crypto).
   - The dispatcher component used as react-markdown's `pre` override:
     ```tsx
     export function PlanPre({ node, children }: any) {
       const codeNode = node?.children?.find((c: any) => c.tagName === 'code');
       const cls: string = codeNode?.properties?.className?.[0] ?? '';
       const lang = /^language-([\w-]+)/.exec(cls)?.[1];
       const Comp = lang ? BLOCK_REGISTRY[lang] : undefined;
       if (Comp) {
         const meta: string = codeNode?.data?.meta ?? '';
         const body: string = (codeNode?.children?.[0]?.value ?? '').replace(/\n$/, '');
         const params = parseMeta(meta);
         const blockId = params.id || hashBody(body);
         return <Comp params={params} body={body} blockId={blockId} />;
       }
       return <pre>{children}</pre>;   // fall through to default for normal fences
     }
     ```
   - Export a `MarkdownComponents` object: `{ pre: PlanPre, code: MarkdownCode }`
     where `MarkdownCode` is the EXISTING highlighter component (move it here from
     TaskDetail.tsx unchanged, minus the dead `inline` usage). Normal language
     fences (`ts`, `bash`, …) are not in BLOCK_REGISTRY → `PlanPre` returns
     `<pre>{children}</pre>` and the inner `code` override still highlights. Verify
     existing code blocks still render highlighted after the refactor.
2. **Create stub files** under `webapp/src/components/blocks/` — one per block,
   each a real component that renders the body in a neutral bordered box labeled
   with the block type (so the registry imports resolve and the build is green):
   `WireframeBlock.tsx`, `FileTreeBlock.tsx`, `QuestionsBlock.tsx`,
   `AnnotatedCodeBlock.tsx`, `CalloutBlock.tsx`, `ColumnsBlock.tsx`, plus a
   barrel `blocks/index.ts` re-exporting them. Register `wireframe` AND `diagram`
   to `WireframeBlock` (diagram is a skin — pass `params.kind='diagram'`).
   Stub example:
   ```tsx
   export default function WireframeBlock({ body, params }: BlockProps) {
     return <div className="wf-surface not-prose rounded-lg border border-gray-200 dark:border-gray-800 p-3 text-xs text-gray-500">[wireframe stub] {params.surface}<pre className="whitespace-pre-wrap">{body}</pre></div>;
   }
   ```
3. **Wire into `PlanMarkdown` (`TaskDetail.tsx`):**
   - Change `<Markdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>`
     to use the imported `MarkdownComponents` (`{ pre: PlanPre, code: MarkdownCode }`).
   - Wrap the rendered article (or provide at the `renderPlanDocPane` level) in a
     `<PlanBlockContext.Provider value={...}>` populated from the current pipeline
     state: `featureId`, `repo`, `selectedPlanDoc.path`, the selected concern's
     `touches`/`decisions` (from the pipeline `concerns`/`documents`), and
     `comments`. Leave `onAnswer`/`onAnchorComment` undefined here (concerns 09/10
     supply them). Keep the change minimal and confined to the PlanMarkdown
     definition + its provider — this concern OWNS this region of TaskDetail.tsx;
     concern 10 will edit the separate comment-UI region later.

## Cross-Repo Side Effects

Defines `BlockProps`, `PlanBlockCtx`, `PlanBlockContext`, `BLOCK_REGISTRY` —
imported by concerns 05-10. The stub files are each fully replaced (not edited
alongside) by their owning concern, so there is no shared-file contention.

## Verify

- `cd webapp && bun run build` succeeds.
- Existing normal code fences in a plan doc still render with syntax highlighting
  (open a plan with a ```ts block in the webapp, or assert in 11).
- Rendering the fixture from concern 01 shows each block as its stub box (no crash).
- `grep -q 'BLOCK_REGISTRY' webapp/src/components/PlanBlocks.tsx` and all six stub
  files + `blocks/index.ts` exist.
- No remaining reference to the removed `inline` prop.
