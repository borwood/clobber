import { FilesystemBrowser } from "./FilesystemBrowser.tsx";

interface Props {
  readonly onSelect: (absolutePath: string) => void;
  readonly onCancel: () => void;
  readonly initialPath?: string;
}

export function FolderPicker({ onSelect, onCancel, initialPath }: Props) {
  return (
    <FilesystemBrowser
      mode="dir"
      onSelect={onSelect}
      onCancel={onCancel}
      {...(initialPath !== undefined ? { initialPath } : {})}
    />
  );
}
