export type ModelOption = { label: string; value: string };

export function uniqueModelOptions(options: ModelOption[], reservedValues: readonly string[] = []): ModelOption[] {
  const seen = new Set(reservedValues);
  return options.filter((option) => {
    const value = option.value || "__default__";
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
