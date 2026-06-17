import type { ButtonHTMLAttributes } from "react";

// The one primary-action button. Each variant pairs a `-strong` background with
// its luminance-correct `-fg` token, so button text stays readable in every
// theme (dark/light/paper) without any site hardcoding `text-white`. Sizing and
// layout come from the call site via `className`; the variant owns only color.
type Variant = "accent" | "provenance" | "info" | "danger";

const VARIANT_CLASSES: Record<Variant, string> = {
  accent: "bg-accent-strong text-accent-fg hover:bg-accent",
  provenance: "bg-provenance-strong text-provenance-fg hover:bg-provenance",
  info: "bg-info-strong text-info-fg hover:bg-info",
  // danger has no -fg token; danger-strong is red-700 in every theme, so white
  // is the correct, theme-stable contrast.
  danger: "bg-danger-strong text-white hover:bg-danger",
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: Variant;
}

export function ActionButton({ variant = "accent", className, type, ...rest }: Props) {
  const classes = ["rounded disabled:opacity-40 disabled:cursor-not-allowed", VARIANT_CLASSES[variant], className]
    .filter(Boolean)
    .join(" ");
  return <button type={type ?? "button"} className={classes} {...rest} />;
}
