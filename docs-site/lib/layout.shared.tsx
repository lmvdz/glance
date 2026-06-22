import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported — green "omp" mark mirrors the product UI brand
      title: (
        <span className="font-semibold tracking-tight">
          <span className="text-fd-primary">omp</span>-squad
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
