import type { ComponentType } from "react";
import { TextBIcon } from "@phosphor-icons/react/dist/csr/TextB";
import { TextItalicIcon } from "@phosphor-icons/react/dist/csr/TextItalic";
import { TextStrikethroughIcon } from "@phosphor-icons/react/dist/csr/TextStrikethrough";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { TextHOneIcon } from "@phosphor-icons/react/dist/csr/TextHOne";
import { QuotesIcon } from "@phosphor-icons/react/dist/csr/Quotes";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { ListNumbersIcon } from "@phosphor-icons/react/dist/csr/ListNumbers";
import type { MarkdownFormat } from "./markdown-format.ts";

interface IconProps {
  readonly size?: number;
  readonly weight?: "regular" | "bold";
}

interface ToolDef {
  readonly format: MarkdownFormat;
  readonly label: string;
  readonly Icon: ComponentType<IconProps>;
}

// Toolbar order mirrors the keyboard shortcuts (Ctrl+B/I/E, Ctrl+Shift+X) first,
// then the line-level formats that have no shortcut.
const TOOLS: readonly ToolDef[] = [
  { format: "bold", label: "Bold  (Ctrl+B)", Icon: TextBIcon },
  { format: "italic", label: "Italic  (Ctrl+I)", Icon: TextItalicIcon },
  { format: "code", label: "Code  (Ctrl+E)", Icon: CodeIcon },
  { format: "strikethrough", label: "Strikethrough  (Ctrl+Shift+X)", Icon: TextStrikethroughIcon },
  { format: "heading", label: "Heading", Icon: TextHOneIcon },
  { format: "quote", label: "Quote", Icon: QuotesIcon },
  { format: "bullet", label: "Bulleted list", Icon: ListBulletsIcon },
  { format: "ordered", label: "Numbered list", Icon: ListNumbersIcon },
];

interface Props {
  readonly onFormat: (format: MarkdownFormat) => void;
  readonly disabled: boolean;
}

export function ComposerToolbar({ onFormat, disabled }: Props) {
  return (
    <div className="flex items-center gap-0.5">
      {TOOLS.map(({ format, label, Icon }) => (
        <button
          key={format}
          type="button"
          // Keep focus in the editor so the selection the format acts on survives.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onFormat(format)}
          disabled={disabled}
          title={label}
          aria-label={label}
          className="flex h-7 w-7 items-center justify-center rounded text-text-soft hover:bg-elevated hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Icon size={16} weight="bold" />
        </button>
      ))}
    </div>
  );
}
