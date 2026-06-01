import { FilesystemBrowser } from "./FilesystemBrowser.tsx";

interface Props {
  readonly onSelect: (absolutePath: string) => void;
  readonly onCancel: () => void;
  readonly initialPath?: string;
  readonly triggerRect: DOMRect;
}

export function FolderPicker({ onSelect, onCancel, initialPath, triggerRect }: Props) {
  return (
    <FilesystemBrowser
      mode="dir"
      triggerRect={triggerRect}
      onSelect={onSelect}
      onCancel={onCancel}
      {...(initialPath !== undefined ? { initialPath } : {})}
    />
  );
}
