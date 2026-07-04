import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // JSX supported — ember star + lowercase wordmark, per brand.md
      title: (
        <span className="font-semibold tracking-tight">
          <span className="text-fd-primary">✦</span> glance
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
