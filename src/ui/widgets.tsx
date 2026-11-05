import { Text, useInput } from "ink";
import { useEffect, useState } from "react";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return <Text>{FRAMES[frame]}</Text>;
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
}

/**
 * Single-line input with a movable cursor. Supports ←/→, home/end
 * (ctrl+a/ctrl+e), backspace, ctrl+u (clear) and ctrl+w (delete word).
 * Pasted newlines become spaces.
 */
export function TextInput({ value, onChange, onSubmit, placeholder }: TextInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const at = Math.min(cursor, value.length);

  useInput((input, key) => {
    if (key.return) return onSubmit(value);
    if (key.leftArrow) return setCursor(Math.max(0, at - 1));
    if (key.rightArrow) return setCursor(Math.min(value.length, at + 1));
    if (key.home || (key.ctrl && input === "a")) return setCursor(0);
    if (key.end || (key.ctrl && input === "e")) return setCursor(value.length);
    if (key.backspace || key.delete) {
      if (at === 0) return;
      onChange(value.slice(0, at - 1) + value.slice(at));
      return setCursor(at - 1);
    }
    if (key.ctrl && input === "u") {
      onChange(value.slice(at));
      return setCursor(0);
    }
    if (key.ctrl && input === "w") {
      const start = value.slice(0, at).replace(/\S+\s*$/, "").length;
      onChange(value.slice(0, start) + value.slice(at));
      return setCursor(start);
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || !input) return;

    const text = input.replace(/\r\n|\r|\n/g, " ");
    onChange(value.slice(0, at) + text + value.slice(at));
    setCursor(at + text.length);
  });

  if (!value) {
    return (
      <Text>
        <Text inverse> </Text>
        {placeholder && <Text dimColor>{placeholder}</Text>}
      </Text>
    );
  }
  return (
    <Text>
      {value.slice(0, at)}
      <Text inverse>{value[at] ?? " "}</Text>
      {value.slice(at + 1)}
    </Text>
  );
}
