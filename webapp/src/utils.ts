export function getCategoryBadge(category: string) {
  switch (category) {
    case 'frontend': return 'bg-[#fee2e2] text-[#b91c1c]';
    case 'devops': return 'bg-[#ffedd5] text-[#c2410c]';
    case 'backend': return 'bg-[#e0e7ff] text-[#4338ca]';
    case 'mcp': return 'bg-[#ede9fe] text-[#6d28d9]';
    case 'database': return 'bg-[#dcfce7] text-[#15803d]';
    // Honest-fallback bucket — deliberately the same neutral tone as the unknown-value default,
    // since 'other' IS "we don't know", not a fifth warm color competing for attention.
    case 'other': return 'bg-gray-100 text-gray-700';
    default: return 'bg-gray-100 text-gray-700';
  }
}
