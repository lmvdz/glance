import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  groupPartByType,
  MessagePrimitive,
  QueueItemPrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FastForwardIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { createContext, useContext, type ComponentType, type FC, type PropsWithChildren, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ComposerQuotePreview, QuoteBlock, SelectionToolbar } from "@/components/assistant-ui/quote";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { Reasoning, ReasoningContent, ReasoningRoot, ReasoningText, ReasoningTrigger } from "@/components/assistant-ui/reasoning";
import { ToolFallback } from "@/components/assistant-ui/tool-fallback";
import { ToolGroupContent, ToolGroupRoot, ToolGroupTrigger } from "@/components/assistant-ui/tool-group";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?: ComponentType<PropsWithChildren<{ group: MessagePrimitive.GroupedParts.GroupPart }>> | undefined;
  ReasoningGroup?: ComponentType<PropsWithChildren<{ group: MessagePrimitive.GroupedParts.GroupPart }>> | undefined;
};

export type ThreadProps = {
  components?: ThreadComponents;
  composerFooter?: ReactNode;
  inputPlaceholder?: string;
};

const EMPTY_COMPONENTS: ThreadComponents = {};
const ThreadComponentsContext = createContext<ThreadComponents>(EMPTY_COMPONENTS);
const ThreadOptionsContext = createContext<Pick<ThreadProps, "composerFooter" | "inputPlaceholder">>({});

const isNewChatView = (state: AssistantState) => state.thread.messages.length === 0 && (!state.thread.isLoading || state.threads.isLoading);

export const Thread: FC<ThreadProps> = ({ components = EMPTY_COMPONENTS, composerFooter, inputPlaceholder }) => {
  const isEmpty = useAuiState(isNewChatView);
  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadOptionsContext.Provider value={{ composerFooter, inputPlaceholder }}>
        <ThreadRoot isEmpty={isEmpty} />
      </ThreadOptionsContext.Provider>
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean }> = ({ isEmpty }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-bg" as string]: "color-mix(in oklab, var(--color-surface) 72%, var(--color-base))",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "0.5rem",
      }}
    >
      <ThreadPrimitive.Viewport turnAnchor="top" className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth" autoScroll>
        <div className={cn("mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4", isEmpty && "justify-center")}>
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>

          <div className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter className={cn("bg-background flex flex-col gap-3 overflow-visible pb-4 md:pb-5", !isEmpty && "sticky bottom-0 mt-auto rounded-t-(--composer-radius)")}>
            <ThreadScrollToBottom />
            <Composer />
            <AuiIf condition={(state) => isNewChatView(state) && state.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
      <SelectionToolbar />
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } = useContext(ThreadComponentsContext);
  const role = useAuiState((state) => state.message.role);
  const isEditing = useAuiState((state) => state.message.composer.isEditing);

  if (isEditing) return <EditComposer />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom asChild>
    <TooltipIconButton tooltip="Scroll to bottom" variant="outline" className="absolute -top-12 z-10 self-center rounded-full bg-surface shadow-[var(--shadow-card)] disabled:invisible">
      <ArrowDownIcon className="size-4" aria-hidden="true" />
    </TooltipIconButton>
  </ThreadPrimitive.ScrollToBottom>
);

const ThreadWelcome: FC = () => (
  <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
    <h1 className="aui-thread-welcome-message-inner animate-in fade-in slide-in-from-bottom-1 text-2xl font-semibold duration-200">How can I help?</h1>
  </div>
);

const ThreadSuggestions: FC = () => (
  <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
    <ThreadPrimitive.Suggestions>{() => <ThreadSuggestionItem />}</ThreadPrimitive.Suggestions>
  </div>
);

const ThreadSuggestionItem: FC = () => (
  <div className="aui-thread-welcome-suggestion-display animate-in fade-in slide-in-from-bottom-2 duration-200">
    <SuggestionPrimitive.Trigger send asChild>
      <Button variant="ghost" className="aui-thread-welcome-suggestion h-auto rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-normal text-text-secondary hover:bg-surface-hover hover:text-text-primary">
        <SuggestionPrimitive.Title />
      </Button>
    </SuggestionPrimitive.Trigger>
  </div>
);

const ComposerQueuedTurns: FC = () => (
  <ComposerPrimitive.Queue>
    {() => (
      <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-border bg-secondary/80 px-2 py-1.5 text-xs text-text-secondary">
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-[0.12em] text-text-muted">Queued</span>
        <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
        <QueueItemPrimitive.Steer aria-label="Run queued turn now" className="inline-flex min-h-8 items-center gap-1 rounded-[var(--radius-sm)] px-2 text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <FastForwardIcon className="size-3.5" aria-hidden="true" />
          Run now
        </QueueItemPrimitive.Steer>
        <QueueItemPrimitive.Remove aria-label="Remove queued turn" className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-[var(--radius-sm)] text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Trash2Icon className="size-3.5" aria-hidden="true" />
        </QueueItemPrimitive.Remove>
      </div>
    )}
  </ComposerPrimitive.Queue>
);

const Composer: FC = () => {
  const { composerFooter, inputPlaceholder } = useContext(ThreadOptionsContext);
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div className="border-border focus-within:border-border-strong flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) shadow-[var(--shadow-card)] transition-[border-color,box-shadow] focus-within:shadow-[var(--shadow-card-hover)]">
        <ComposerQuotePreview />
        <ComposerQueuedTurns />
        <AuiIf condition={(state) => state.composer.dictation != null}>
          <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-1.5 text-xs text-text-secondary">
            <MicIcon className="size-3.5 text-accent" aria-hidden="true" />
            <span className="text-text-muted">Listening</span>
            <ComposerPrimitive.DictationTranscript className="min-w-0 flex-1 truncate text-text-primary" />
          </div>
        </AuiIf>
        <ComposerPrimitive.Input
          placeholder={inputPlaceholder ?? "Send a message..."}
          submitMode="ctrlEnter"
          rows={2}
          className="aui-composer-input placeholder:text-muted-foreground/80 max-h-40 min-h-16 w-full resize-none bg-transparent px-2.5 py-1.5 text-sm leading-6 text-foreground outline-none"
          aria-label="Message omp"
        />
        {composerFooter ? <div className="px-2">{composerFooter}</div> : null}
        <div className="aui-composer-action-wrapper flex items-center justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-text-muted">⌘/Ctrl Enter sends. Stop interrupts the live omp turn.</p>
          <div className="flex items-center gap-1.5">
            <AuiIf condition={(state) => state.thread.capabilities.dictation && state.composer.dictation == null}>
              <ComposerPrimitive.Dictate asChild>
                <TooltipIconButton tooltip="Voice input" side="bottom" type="button" className="size-8 rounded-full" aria-label="Start voice input">
                  <MicIcon className="size-4" aria-hidden="true" />
                </TooltipIconButton>
              </ComposerPrimitive.Dictate>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.capabilities.dictation && state.composer.dictation != null}>
              <ComposerPrimitive.StopDictation asChild>
                <TooltipIconButton tooltip="Stop dictation" side="bottom" type="button" className="size-8 rounded-full text-danger" aria-label="Stop voice input">
                  <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
                </TooltipIconButton>
              </ComposerPrimitive.StopDictation>
            </AuiIf>
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <TooltipIconButton tooltip="Send message" side="bottom" type="button" variant="primary" className="size-8 rounded-full" aria-label="Send message">
                  <ArrowUpIcon className="size-4" aria-hidden="true" />
                </TooltipIconButton>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel asChild>
                <Button type="button" variant="primary" size="icon" className="size-8 rounded-full" aria-label="Stop generating">
                  <SquareIcon className="size-3.5 fill-current" aria-hidden="true" />
                </Button>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="mt-2 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
      <ErrorPrimitive.Message className="line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

const AssistantMessage: FC = () => {
  const { ToolFallback: ToolFallbackComponent = ToolFallback, ToolGroup, ReasoningGroup } = useContext(ThreadComponentsContext);
  return (
    <MessagePrimitive.Root data-role="assistant" className="aui-assistant-message-root animate-in fade-in slide-in-from-bottom-1 duration-150">
      <div className="aui-assistant-message-content px-2 leading-relaxed text-foreground wrap-break-word [content-visibility:auto]">
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({ reasoning: ["group-chainOfThought", "group-reasoning"], "tool-call": ["group-chainOfThought", "group-tool"], "standalone-tool-call": [] })}
        >
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                if (ToolGroup) return <ToolGroup group={part}>{children}</ToolGroup>;
                return (
                  <ToolGroupRoot>
                    <ToolGroupTrigger count={part.indices.length} active={part.status.type === "running"} />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) return <ReasoningGroup group={part}>{children}</ReasoningGroup>;
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />;
              case "data":
                return part.dataRendererUI;
              case "indicator":
                return <span className="animate-pulse font-sans" aria-label="Assistant is working">●</span>;
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>
      <div className="ms-2 -mb-7.5 flex min-h-7.5 items-center pt-1.5">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-assistant-action-bar-root animate-in fade-in -ms-1 flex gap-1 text-muted-foreground duration-200">
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip="Copy">
        <AuiIf condition={(state) => state.message.isCopied}><CheckIcon className="size-4" aria-hidden="true" /></AuiIf>
        <AuiIf condition={(state) => !state.message.isCopied}><CopyIcon className="size-4" aria-hidden="true" /></AuiIf>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton tooltip="Refresh"><RefreshCwIcon className="size-4" aria-hidden="true" /></TooltipIconButton>
    </ActionBarPrimitive.Reload>
    <ActionBarMorePrimitive.Root>
      <ActionBarMorePrimitive.Trigger asChild>
        <TooltipIconButton tooltip="More" className="data-[state=open]:bg-accent"><MoreHorizontalIcon className="size-4" aria-hidden="true" /></TooltipIconButton>
      </ActionBarMorePrimitive.Trigger>
      <ActionBarMorePrimitive.Content side="bottom" align="start" sideOffset={6} className="z-50 min-w-40 overflow-hidden rounded-[var(--radius-md)] border border-border bg-popover/95 p-1.5 text-popover-foreground shadow-[var(--shadow-float)] backdrop-blur-sm">
        <ActionBarPrimitive.ExportMarkdown asChild>
          <ActionBarMorePrimitive.Item className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm outline-none hover:bg-surface-hover focus:bg-surface-hover">
            <DownloadIcon className="size-4" aria-hidden="true" />
            Export Markdown
          </ActionBarMorePrimitive.Item>
        </ActionBarPrimitive.ExportMarkdown>
      </ActionBarMorePrimitive.Content>
    </ActionBarMorePrimitive.Root>
  </ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root data-role="user" className="aui-user-message-root animate-in fade-in slide-in-from-bottom-1 grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [&:where(>*)]:col-start-2">
    <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
      <div className="aui-user-message-content peer rounded-[var(--radius-lg)] bg-muted px-4 py-2 text-foreground wrap-break-word empty:hidden">
        <MessagePrimitive.Quote>{(quote) => <QuoteBlock {...quote} />}</MessagePrimitive.Quote>
        <MessagePrimitive.Parts />
      </div>
      <div className="aui-user-action-bar-wrapper absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
        <UserActionBar />
      </div>
    </div>
    <BranchPicker className="col-span-full col-start-1 row-start-3 -me-1 justify-end" />
  </MessagePrimitive.Root>
);

const UserActionBar: FC = () => (
  <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="aui-user-action-bar-root flex flex-col items-end">
    <ActionBarPrimitive.Edit asChild>
      <TooltipIconButton tooltip="Edit"><PencilIcon className="size-4" aria-hidden="true" /></TooltipIconButton>
    </ActionBarPrimitive.Edit>
  </ActionBarPrimitive.Root>
);

const EditComposer: FC = () => (
  <MessagePrimitive.Root className="aui-edit-composer-wrapper flex flex-col px-2">
    <ComposerPrimitive.Root className="aui-edit-composer-root ms-auto flex w-full max-w-[85%] flex-col rounded-(--composer-radius) border border-border bg-(--composer-bg) shadow-[var(--shadow-card)]">
      <ComposerPrimitive.Input className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-foreground outline-none" autoFocus />
      <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
        <ComposerPrimitive.Cancel asChild><Button variant="ghost" size="sm" className="rounded-full px-3.5">Cancel</Button></ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild><Button variant="primary" size="sm" className="rounded-full px-3.5">Update</Button></ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({ className, ...rest }) => (
  <BranchPickerPrimitive.Root hideWhenSingleBranch className={cn("aui-branch-picker-root -ms-2 me-2 inline-flex items-center text-xs text-muted-foreground", className)} {...rest}>
    <BranchPickerPrimitive.Previous asChild><TooltipIconButton tooltip="Previous"><ChevronLeftIcon className="size-4" aria-hidden="true" /></TooltipIconButton></BranchPickerPrimitive.Previous>
    <span className="aui-branch-picker-state px-1 font-medium"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
    <BranchPickerPrimitive.Next asChild><TooltipIconButton tooltip="Next"><ChevronRightIcon className="size-4" aria-hidden="true" /></TooltipIconButton></BranchPickerPrimitive.Next>
  </BranchPickerPrimitive.Root>
);
