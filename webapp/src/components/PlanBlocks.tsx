import React from 'react';
import { CodeHighlight } from './CodeHighlight';
import type { ArtifactCommentDTO } from '../lib/dto';
import {
  AnnotatedCodeBlock,
  CalloutBlock,
  ColumnsBlock,
  FileTreeBlock,
  MermaidBlock,
  QuestionsBlock,
  WireframeBlock,
} from './blocks';

export interface PlanBlockCtx {
  featureId?: string;
  repo?: string;
  planPath?: string;
  touches?: string[];
  decisions?: string[];
  comments?: ArtifactCommentDTO[];
  onAnswer?: (blockId: string, questionId: string, value: string) => void | Promise<void>;
  onAnchorComment?: (blockId: string) => void;
}

export const PlanBlockContext = React.createContext<PlanBlockCtx>({});

export interface BlockProps {
  params: Record<string, string>;
  body: string;
  blockId: string;
}

export function parseMeta(meta: string): Record<string, string> {
  const params: Record<string, string> = {};
  const pairPattern = /([A-Za-z_][\w-]*)=(?:"([^"]*)"|(\S+))/g;
  for (const match of meta.matchAll(pairPattern)) {
    params[match[1]] = match[2] ?? match[3] ?? '';
  }
  return params;
}

function hashBody(body: string): string {
  let hash = 0x811c9dc5;
  for (const char of body.trim()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

const DiagramBlock: React.FC<BlockProps> = (props) => (
  <WireframeBlock {...props} params={{ ...props.params, kind: 'diagram' }} />
);

export const BLOCK_REGISTRY: Record<string, React.FC<BlockProps>> = {
  wireframe: WireframeBlock,
  diagram: DiagramBlock,
  filetree: FileTreeBlock,
  mermaid: MermaidBlock,
  questions: QuestionsBlock,
  'annotated-code': AnnotatedCodeBlock,
  annotated: AnnotatedCodeBlock,
  callout: CalloutBlock,
  columns: ColumnsBlock,
};

type MarkdownElementNode = {
  tagName?: unknown;
  properties?: unknown;
  children?: unknown;
  data?: unknown;
};

type MarkdownPreProps = React.ComponentPropsWithoutRef<'pre'> & {
  node?: unknown;
};

type MarkdownCodeProps = React.ComponentPropsWithoutRef<'code'> & {
  node?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMarkdownElementNode(value: unknown): value is MarkdownElementNode {
  return isRecord(value);
}

function childrenOf(node: MarkdownElementNode): unknown[] {
  return Array.isArray(node.children) ? node.children : [];
}

function codeNodeOf(node: unknown): MarkdownElementNode | undefined {
  if (!isMarkdownElementNode(node)) return undefined;
  return childrenOf(node).find((child): child is MarkdownElementNode => (
    isMarkdownElementNode(child) && child.tagName === 'code'
  ));
}

function firstClassName(node: MarkdownElementNode): string {
  if (!isRecord(node.properties)) return '';
  const className = node.properties.className;
  if (typeof className === 'string') return className;
  if (Array.isArray(className)) {
    const first = className[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

function metaOf(node: MarkdownElementNode): string {
  if (!isRecord(node.data)) return '';
  return typeof node.data.meta === 'string' ? node.data.meta : '';
}

function bodyOf(node: MarkdownElementNode): string {
  const firstChild = childrenOf(node)[0];
  if (!isRecord(firstChild)) return '';
  return typeof firstChild.value === 'string' ? firstChild.value.replace(/\n$/, '') : '';
}

export function PlanPre({ node, children, ...props }: MarkdownPreProps) {
  const codeNode = codeNodeOf(node);
  const cls = codeNode ? firstClassName(codeNode) : '';
  const lang = /^language-([\w-]+)/.exec(cls)?.[1];
  const Comp = lang ? BLOCK_REGISTRY[lang] : undefined;

  if (Comp && codeNode) {
    const params = parseMeta(metaOf(codeNode));
    const body = bodyOf(codeNode);
    const blockId = params.id || hashBody(body);
    return <Comp params={params} body={body} blockId={blockId} />;
  }

  return <pre {...props}>{children}</pre>;
}

export function MarkdownCode({ node: _node, className, children, ...props }: MarkdownCodeProps) {
  const match = /language-(\w+)/.exec(className || '');
  if (match) {
    return (
      <CodeHighlight
        language={match[1]}
        customStyle={{ margin: 0, borderRadius: '0.5rem', background: 'transparent' }}
      >
        {String(children).replace(/\n$/, '')}
      </CodeHighlight>
    );
  }
  return <code className={className} {...props}>{children}</code>;
}

export const MarkdownComponents = { pre: PlanPre, code: MarkdownCode };
