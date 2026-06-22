import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';

// You can customize Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // `dot` (Graphviz) isn't in Fumadocs' Shiki bundle; render those fences as plain
    // text rather than failing the build. Every other fence language auto-loads.
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      langAlias: { ...rehypeCodeDefaultOptions.langAlias, dot: 'text' },
    },
  },
});
