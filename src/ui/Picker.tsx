import { Box, Text, useInput } from "ink";
import { useState } from "react";

export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
}

interface Props {
  title: string;
  items: PickerItem[];
  current?: string;
  onSelect: (value: string) => void;
  onCancel: () => void;
}

const WINDOW = 10;

/** A list you move through with the arrow keys and narrow down by typing. */
export function Picker({ title, items, current, onSelect, onCancel }: Props) {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((i) => i.value === current)));

  const needle = filter.toLowerCase();
  const visible = needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
  const selected = Math.min(index, Math.max(0, visible.length - 1));

  useInput((ch, key) => {
    if (key.escape) return onCancel();
    if (key.return) {
      const item = visible[selected];
      if (item) onSelect(item.value);
      return;
    }
    if (key.upArrow) return setIndex(selected === 0 ? visible.length - 1 : selected - 1);
    if (key.downArrow) return setIndex(selected >= visible.length - 1 ? 0 : selected + 1);
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      setIndex(0);
      return;
    }
    if (ch && !key.ctrl && !key.meta && !key.tab && ch >= " ") {
      setFilter((f) => f + ch);
      setIndex(0);
    }
  });

  const start = Math.min(Math.max(0, selected - Math.floor(WINDOW / 2)), Math.max(0, visible.length - WINDOW));
  const shown = visible.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{filter ? `filter: ${filter}` : "type to filter · ↑↓ move · enter select · esc cancel"}</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {shown.map((item, i) => {
        const isSelected = start + i === selected;
        return (
          <Text key={item.value}>
            <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "› " : "  "}</Text>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>{item.label}</Text>
            {item.value === current && <Text color="green"> (current)</Text>}
            {item.hint && <Text dimColor>  {item.hint}</Text>}
          </Text>
        );
      })}
      {visible.length === 0 && <Text dimColor>  no matches</Text>}
      {start + WINDOW < visible.length && <Text dimColor>  ↓ {visible.length - start - WINDOW} more</Text>}
    </Box>
  );
}
